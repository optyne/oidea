import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DepartmentsService } from './departments.service';
import { EmployeeAdminService } from './employee-admin.service';
import { resolveUserIdByEmail } from '../common/email-lookup';
import { lockUser } from '../common/identity-lock';
import { actionFilter } from '../audit/audit.controller';

/**
 * 真的 Postgres（H2 review S5）：記憶體版 Prisma 只模仿得了 migration 手寫的索引、advisory lock 與 raw SQL，
 * 這裡用真的 Prisma client 證明它們在資料庫上真的有效。
 *
 * 沒設 `TEST_DATABASE_URL` 就整組跳過（`npm test` 不需要資料庫）。CI 的 `backend-postgres` job 會先
 * `prisma migrate deploy` 再跑這個檔。每次用一個新的工作空間，不清別人的資料。
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Postgres integration (TEST_DATABASE_URL)', () => {
  jest.setTimeout(60_000);
  let prisma: PrismaClient;
  let workspaceId: string;
  let ownerId: string;
  const tag = randomUUID().slice(0, 8);
  const audit = { record: jest.fn(async () => undefined) };
  const clock = { now: () => new Date() };
  let departments: DepartmentsService;

  const codeOf = (e: unknown) => ((e as HttpException).getResponse?.() as { code?: string } | undefined)?.code;
  const statusOf = (e: unknown) => (e instanceof HttpException ? e.getStatus() : null);
  /** 只有小寫字母（audit action 的格式不收數字） */
  const alpha = tag.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const owner = await prisma.user.create({
      data: { email: `owner-${tag}@it.test`, username: `owner_${tag}`, displayName: 'owner' },
    });
    ownerId = owner.id;
    const ws = await prisma.workspace.create({ data: { name: `it-${tag}`, slug: `it-${tag}`, ownerId } });
    workspaceId = ws.id;
    departments = new DepartmentsService(prisma as any, audit as any, clock as any);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('the hand-written partial unique indexes exist after migrate deploy', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'departments' AND indexname IN ('departments_root_name_key', 'departments_child_name_key') ORDER BY indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(['departments_child_name_key', 'departments_root_name_key']);
  });

  it('root and child names clash case-insensitively: 409 through the service, and the index itself refuses a direct insert', async () => {
    const root = await departments.create(ownerId, workspaceId, { name: `RD-${tag}` } as any);
    const rootClash = await departments.create(ownerId, workspaceId, { name: `rd-${tag}` } as any).catch((e) => e);
    expect([statusOf(rootClash), codeOf(rootClash)]).toEqual([409, 'department_name_taken']);
    await departments.create(ownerId, workspaceId, { name: 'Team A', parentId: root.id } as any);
    const childClash = await departments.create(ownerId, workspaceId, { name: 'TEAM a', parentId: root.id } as any).catch((e) => e);
    expect([statusOf(childClash), codeOf(childClash)]).toEqual([409, 'department_name_taken']);
    // 繞過程式檢查直接寫：證明是索引在擋（P2002），不是只有程式的檢查
    await expect(prisma.department.create({ data: { workspaceId, name: `Rd-${tag}`, parentId: null } })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(prisma.department.create({ data: { workspaceId, name: 'team A', parentId: root.id } })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('the org advisory lock serializes two concurrent cyclic moves: exactly one wins', async () => {
    const a = await departments.create(ownerId, workspaceId, { name: `A-${tag}` } as any);
    const b = await departments.create(ownerId, workspaceId, { name: `B-${tag}` } as any);
    const results = await Promise.allSettled([
      departments.update(ownerId, workspaceId, a.id, { parentId: b.id } as any),
      departments.update(ownerId, workspaceId, b.id, { parentId: a.id } as any),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(codeOf(failed[0].reason)).toBe('department_cycle');
    const rows = await prisma.department.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, parentId: true } });
    expect(rows.filter((r) => r.parentId !== null)).toHaveLength(1);
  });

  it('the user advisory lock blocks a second transaction until the first one ends', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((r) => (releaseFirst = r));
    let firstLocked!: () => void;
    const locked = new Promise<void>((r) => (firstLocked = r));
    const first = prisma.$transaction(async (tx) => {
      await lockUser(tx, ownerId);
      order.push('first-locked');
      firstLocked();
      await firstHolds;
      order.push('first-done');
    }, { timeout: 20_000 });
    await locked;
    const second = prisma.$transaction(async (tx) => {
      await lockUser(tx, ownerId);
      order.push('second-locked');
    }, { timeout: 20_000, maxWait: 10_000 });
    await new Promise((r) => setTimeout(r, 300));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
  });

  it('roster search treats _ and % literally (strpos/lower, not ILIKE)', async () => {
    await prisma.employeeProfile.createMany({
      data: [
        { workspaceId, employeeNo: `S1-${tag}`, email: `a_b-${tag}@it.test`, fullName: 'Under Score', hireDate: new Date('2024-01-01') },
        { workspaceId, employeeNo: `S2-${tag}`, email: `axb-${tag}@it.test`, fullName: 'No Underscore', hireDate: new Date('2024-01-01') },
        // 只有把 % 當字面值才分得出 S3 與 S4（ILIKE '%a%b-…%' 兩筆都會中，re-verify N-5）
        { workspaceId, employeeNo: `S3-${tag}`, email: `pct-${tag}@it.test`, fullName: `a%b-${tag}`, hireDate: new Date('2024-01-01') },
        { workspaceId, employeeNo: `S4-${tag}`, email: `pctx-${tag}@it.test`, fullName: `axxb-${tag}`, hireDate: new Date('2024-01-01') },
      ],
    });
    const service = new EmployeeAdminService(prisma as any, clock as any, audit as any, {} as any, {} as any, {} as any, {} as any);
    const under = await service.list(workspaceId, { q: 'A_B' } as any);
    expect(under.items.map((i) => i.employeeNo)).toEqual([`S1-${tag}`]);
    const pct = await service.list(workspaceId, { q: `A%B-${tag}` } as any);
    expect(pct.items.map((i) => i.employeeNo)).toEqual([`S3-${tag}`]);
  });

  it('email lookup uses lower() = lower(): case-insensitive, _ is not a wildcard', async () => {
    const u = await prisma.user.create({ data: { email: `tom_lee-${tag}@it.test`, username: `tom_${tag}`, displayName: 'tom' } });
    await prisma.user.create({ data: { email: `tomxlee-${tag}@it.test`, username: `tomx_${tag}`, displayName: 'tomx' } });
    expect(await resolveUserIdByEmail(prisma, `TOM_LEE-${tag}@IT.TEST`)).toBe(u.id);
    expect(await resolveUserIdByEmail(prisma, `tom%lee-${tag}@it.test`)).toBeNull();
  });

  it('audit action prefix (startsWith) does not treat _ as a wildcard', async () => {
    await prisma.auditLog.createMany({
      data: [
        { workspaceId, action: `it_${alpha}.a` },
        { workspaceId, action: `itx${alpha}.b` },
      ],
    });
    const where = actionFilter(`it_${alpha}.*`);
    const rows = await prisma.auditLog.findMany({ where: { workspaceId, action: where as any }, select: { action: true } });
    expect(rows.map((r) => r.action)).toEqual([`it_${alpha}.a`]);
  });
});
