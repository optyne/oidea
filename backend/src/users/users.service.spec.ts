import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from '../common/prisma.service';
import { fakeEmailQueryRaw, sqlText } from '../common/testing/fake-email-raw';

describe('UsersService.search — H0 scoping', () => {
  let service: UsersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.workspaceId_userId.workspaceId === 'ws-1' && where.workspaceId_userId.userId === 'u-1'
            ? { role: 'member' }
            : null,
        ),
      },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u-3', username: 'carol' }]) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(UsersService);
  });

  it.each([undefined, '', '   '])('workspaceId %p → 400', async (ws) => {
    await expect(service.search('u-1', 'ca', ws as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('caller not a member of the workspace → 403', async () => {
    await expect(service.search('u-2', 'ca', 'ws-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('member search is scoped to the workspace and excludes bots', async () => {
    const res = await service.search('u-1', 'ca', 'ws-1');
    expect(res).toEqual([{ id: 'u-3', username: 'carol' }]);
    const { where, select } = prisma.user.findMany.mock.calls[0][0];
    expect(where.workspaceMembers).toEqual({ some: { workspaceId: 'ws-1' } });
    expect(where.botAccount).toEqual({ is: null });
    expect(where.deletedAt).toBeNull();
    expect(select.email).toBeUndefined();
  });

  it('controller passes the authenticated caller and workspaceId', async () => {
    const svc: any = { search: jest.fn().mockResolvedValue([]) };
    const controller = new UsersController(svc);
    await controller.search({ user: { userId: 'u-1' } }, 'ca', 'ws-1');
    expect(svc.search).toHaveBeenCalledWith('u-1', 'ca', 'ws-1');
  });
});

describe('UsersService.findByEmail — 不分大小寫（H1，帳密與緊急登入共用）', () => {
  const rows = [
    { id: 'u-foo', email: 'Foo@corp.com', deletedAt: null },
    { id: 'u-twin-a', email: 'Twin@corp.com', deletedAt: null },
    { id: 'u-twin-b', email: 'twin@CORP.com', deletedAt: null },
    { id: 'u-exact', email: 'Exact@corp.com', deletedAt: null },
    { id: 'u-exact-2', email: 'exact@corp.com', deletedAt: null },
    { id: 'u-dot', email: 'tom.lee@corp.com', deletedAt: null },
  ];
  const prisma = {
    $queryRaw: fakeEmailQueryRaw(() => rows),
    user: {
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id && r.deletedAt === null) ?? null),
    },
  };
  const service = new UsersService(prisma as any);

  it('foo@ 找到 Foo@：走 email-lookup 的 lower() 比對（排除已刪除），再用 id 載入', async () => {
    expect((await service.findByEmail('foo@corp.com'))?.id).toBe('u-foo');
    expect(await service.findByEmail('  FOO@CORP.COM ')).toMatchObject({ id: 'u-foo' });
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(sqlText(strings)).toContain('lower("email") = lower($?) AND "deletedAt" IS NULL');
    expect(values).toEqual(['foo@corp.com']);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-foo', deletedAt: null } });
  });

  it('有完全相同的就用它', async () => {
    expect((await service.findByEmail('exact@corp.com'))?.id).toBe('u-exact-2');
    expect((await service.findByEmail('Exact@corp.com'))?.id).toBe('u-exact');
  });

  it('只差大小寫的有兩筆、又沒有完全相同的 → null（不猜）', async () => {
    expect(await service.findByEmail('TWIN@corp.com')).toBeNull();
  });

  it('底線不是萬用字元：tom_lee@ 找不到 tom.lee@', async () => {
    expect(await service.findByEmail('tom_lee@corp.com')).toBeNull();
  });

  it('空字串 → null，不查 DB', async () => {
    prisma.$queryRaw.mockClear();
    expect(await service.findByEmail('  ')).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
