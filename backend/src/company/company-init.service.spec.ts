import { CompanyInitError, CompanyInitService, slugify } from './company-init.service';
import { CompanyService } from './company.service';
import { EmployeesService } from '../employees/employees.service';
import { FakeCompanyPrisma } from './testing/company-fakes';

const PROFILE = { employeeNo: 'E000', fullName: '老闆', hireDate: '2020-01-01' };

describe('CompanyInitService（npm run company:init）', () => {
  let prisma: FakeCompanyPrisma;
  let audit: { record: jest.Mock };
  let service: CompanyInitService;

  beforeEach(() => {
    prisma = new FakeCompanyPrisma();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    const company = new CompanyService(prisma as any);
    const employees = new EmployeesService(prisma as any, audit as any, company);
    service = new CompanyInitService(prisma as any, audit as any, company, employees);
  });

  const companies = () => prisma.workspaces.filter((w) => w.isCompany);

  describe('--workspace <id>（指定既有工作空間）', () => {
    beforeEach(() => {
      prisma.addUser({ id: 'u-old', email: 'old@corp.com' });
      prisma.addWorkspace({ id: 'ws-1', name: 'Oadpiz', ownerId: 'u-old' });
      prisma.addMember('ws-1', 'u-old', 'owner');
    });

    it('owner 已有 User（email 不分大小寫）：設 isCompany、ownerId 指向他、成為 owner 成員、建立員工資料（不綁 userId）', async () => {
      prisma.addUser({ id: 'u-boss', email: 'Boss@Corp.com', displayName: 'Boss' });
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE });

      expect(res).toMatchObject({
        workspaceId: 'ws-1',
        workspaceCreated: false,
        ownerUserId: 'u-boss',
        pendingOwnerEmail: null,
        profile: 'created',
      });
      const ws = prisma.workspaces.find((w) => w.id === 'ws-1')!;
      expect(ws).toMatchObject({ isCompany: true, ownerId: 'u-boss', pendingOwnerEmail: null });
      expect(prisma.members).toContainEqual({ workspaceId: 'ws-1', userId: 'u-boss', role: 'owner' });
      // 原本的 owner 角色不動
      expect(prisma.members).toContainEqual({ workspaceId: 'ws-1', userId: 'u-old', role: 'owner' });
      expect(prisma.profiles).toEqual([
        expect.objectContaining({ workspaceId: 'ws-1', email: 'boss@corp.com', employeeNo: 'E000', userId: null }),
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'company.init', workspaceId: 'ws-1', targetId: 'ws-1' }),
      );
    });

    it('已有 User 時 --full-name 可省略（用 displayName）', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', displayName: '王老闆' });
      await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', employeeNo: 'E0', hireDate: '2020-01-01' });
      expect(prisma.profiles[0].fullName).toBe('王老闆');
    });

    it('重跑同一個工作空間：冪等（不建第二個公司工作空間、不重複建員工資料）', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com' });
      await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE });
      const again = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com' });
      expect(again).toMatchObject({ workspaceId: 'ws-1', profile: 'existing' });
      expect(companies()).toHaveLength(1);
      expect(prisma.profiles).toHaveLength(1);
      expect(prisma.members.filter((m) => m.userId === 'u-boss')).toHaveLength(1);
    });

    it('已有另一個公司工作空間 → 拒絕，什麼都不改', async () => {
      prisma.addWorkspace({ id: 'ws-co', name: 'Real Co', ownerId: 'u-old', isCompany: true });
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        CompanyInitError,
      );
      expect(prisma.workspaces.find((w) => w.id === 'ws-1')!.isCompany).toBe(false);
      expect(companies().map((w) => w.id)).toEqual(['ws-co']);
      expect(prisma.profiles).toHaveLength(0);
    });

    it('owner 還沒有 User：記 pendingOwnerEmail（小寫），ownerId 不動', async () => {
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'New.Boss@Corp.com', ...PROFILE });
      expect(res).toMatchObject({ ownerUserId: null, pendingOwnerEmail: 'new.boss@corp.com' });
      expect(prisma.workspaces.find((w) => w.id === 'ws-1')).toMatchObject({
        isCompany: true,
        ownerId: 'u-old',
        pendingOwnerEmail: 'new.boss@corp.com',
      });
    });

    it('owner 沒有員工資料又缺 --employee-no／--hire-date → 拒絕，而且還沒寫入任何東西', async () => {
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', fullName: 'X' })).rejects.toThrow(
        /--employee-no --hire-date/,
      );
      expect(companies()).toHaveLength(0);
    });

    it('--employee-no 已屬於另一位員工 → 拒絕（不搶別人的員工資料）', async () => {
      prisma.workspaces[0].isCompany = true;
      prisma.profiles.push({
        id: 'p-x',
        workspaceId: 'ws-1',
        userId: null,
        email: 'someone@corp.com',
        employeeNo: 'E000',
        fullName: 'Someone',
        departmentId: null,
        jobTitle: '',
        hireDate: new Date('2021-01-01'),
        employmentStatus: 'active',
      });
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /已屬於另一位員工/,
      );
      expect(prisma.profiles.find((p) => p.id === 'p-x')!.email).toBe('someone@corp.com');
    });

    it('owner 是停用帳號或 bot → 拒絕', async () => {
      prisma.addUser({ id: 'u-dis', email: 'dis@corp.com', disabledAt: new Date() });
      prisma.addUser({ id: 'u-bot', email: 'bot@corp.com', isBot: true });
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'dis@corp.com', ...PROFILE })).rejects.toThrow(/停用/);
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'bot@corp.com', ...PROFILE })).rejects.toThrow(/bot/);
    });

    it('找不到工作空間 → 拒絕', async () => {
      await expect(service.init({ workspaceId: 'nope', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /找不到工作空間/,
      );
    });
  });

  describe('--create <name>（建立新的工作空間）', () => {
    it('owner 已有 User：建立公司工作空間，ownerId 與 owner 成員都是他', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com' });
      const res = await service.init({ createName: 'Oadpiz Inc.', ownerEmail: 'boss@corp.com', ...PROFILE });
      expect(res).toMatchObject({ workspaceCreated: true, ownerUserId: 'u-boss', pendingOwnerEmail: null });
      const ws = prisma.workspaces.find((w) => w.id === res.workspaceId)!;
      expect(ws).toMatchObject({ name: 'Oadpiz Inc.', slug: 'oadpiz-inc', isCompany: true, ownerId: 'u-boss' });
      expect(prisma.members).toEqual([{ workspaceId: ws.id, userId: 'u-boss', role: 'owner' }]);
      expect(prisma.profiles).toHaveLength(1);
    });

    it('owner 還沒有 User：ownerId 先指向 --executor-email，記 pendingOwnerEmail', async () => {
      prisma.addUser({ id: 'u-exec', email: 'ops@corp.com' });
      const res = await service.init({
        createName: '公司',
        ownerEmail: 'boss@corp.com',
        executorEmail: 'OPS@corp.com',
        ...PROFILE,
      });
      const ws = prisma.workspaces.find((w) => w.id === res.workspaceId)!;
      expect(ws).toMatchObject({ slug: 'company', ownerId: 'u-exec', pendingOwnerEmail: 'boss@corp.com', isCompany: true });
      expect(prisma.members).toEqual([{ workspaceId: ws.id, userId: 'u-exec', role: 'owner' }]);
      expect(res).toMatchObject({ ownerUserId: null, pendingOwnerEmail: 'boss@corp.com' });
    });

    it('owner 還沒有 User 又沒給 --executor-email → 拒絕，不建工作空間', async () => {
      await expect(service.init({ createName: 'Co', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /--executor-email/,
      );
      expect(prisma.workspaces).toHaveLength(0);
    });

    it('重跑同名 --create：沿用既有的公司工作空間，不建第二個', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com' });
      const first = await service.init({ createName: 'Oadpiz', ownerEmail: 'boss@corp.com', ...PROFILE });
      const second = await service.init({ createName: 'oadpiz', ownerEmail: 'boss@corp.com' });
      expect(second).toMatchObject({ workspaceId: first.workspaceId, workspaceCreated: false, profile: 'existing' });
      expect(prisma.workspaces).toHaveLength(1);
      expect(companies()).toHaveLength(1);
    });

    it('已有另一個（不同名稱）的公司工作空間 → 拒絕', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com' });
      prisma.addWorkspace({ id: 'ws-co', name: 'Real Co', ownerId: 'u-boss', isCompany: true });
      await expect(service.init({ createName: 'Another', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /--workspace ws-co/,
      );
      expect(prisma.workspaces).toHaveLength(1);
    });

    it('slug 撞名時加 -2；可用 --slug 指定', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com' });
      prisma.addWorkspace({ id: 'ws-x', slug: 'oadpiz', ownerId: 'u-boss' });
      const res = await service.init({ createName: 'Oadpiz', ownerEmail: 'boss@corp.com', ...PROFILE });
      expect(prisma.workspaces.find((w) => w.id === res.workspaceId)!.slug).toBe('oadpiz-2');
    });

    it('DB 的唯一索引擋下同時建立的第二個公司工作空間 → CompanyInitError', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com' });
      // 檢查時還沒有公司工作空間，寫入時才有（模擬兩個 company:init 同時跑）
      const realFindFirst = prisma.workspace.findFirst.getMockImplementation()!;
      prisma.workspace.findFirst.mockImplementationOnce(async (args: any) => {
        const res = await realFindFirst(args);
        prisma.addWorkspace({ id: 'ws-race', ownerId: 'u-boss', isCompany: true });
        return res;
      });
      await expect(service.init({ createName: 'Co', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        CompanyInitError,
      );
      expect(companies().map((w) => w.id)).toEqual(['ws-race']);
    });
  });

  it('--workspace 與 --create 必須二選一；owner email 必須合法', async () => {
    await expect(service.init({ ownerEmail: 'boss@corp.com' })).rejects.toThrow(/其中一個/);
    await expect(service.init({ workspaceId: 'a', createName: 'b', ownerEmail: 'boss@corp.com' })).rejects.toThrow(
      /其中一個/,
    );
    await expect(service.init({ createName: 'b', ownerEmail: 'nope' })).rejects.toThrow(/owner-email/);
  });

  it('slugify', () => {
    expect(slugify('Oadpiz Inc.')).toBe('oadpiz-inc');
    expect(slugify('歐迪')).toBe('company');
  });
});
