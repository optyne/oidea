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
  const role = (ws: string, user: string) => prisma.members.find((m) => m.workspaceId === ws && m.userId === user)?.role;

  describe('--workspace <id>（指定既有工作空間）', () => {
    beforeEach(() => {
      prisma.addUser({ id: 'u-old', email: 'old@corp.com' });
      prisma.addWorkspace({ id: 'ws-1', name: 'Oadpiz', ownerId: 'u-old' });
      prisma.addMember('ws-1', 'u-old', 'owner');
    });

    it('owner 的 User 已綁定 SSO（email 不分大小寫）：設 isCompany、ownerId 指向他、成為 owner 成員、原 owner 降為 admin、建立員工資料（不綁 userId）', async () => {
      prisma.addUser({ id: 'u-boss', email: 'Boss@Corp.com', displayName: 'Boss', ssoBound: true });
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE });

      expect(res).toMatchObject({
        workspaceId: 'ws-1',
        workspaceCreated: false,
        ownerUserId: 'u-boss',
        pendingOwnerEmail: null,
        profile: 'created',
        existingMembers: null,
      });
      const ws = prisma.workspaces.find((w) => w.id === 'ws-1')!;
      expect(ws).toMatchObject({ isCompany: true, ownerId: 'u-boss', pendingOwnerEmail: null });
      expect(role('ws-1', 'u-boss')).toBe('owner');
      expect(role('ws-1', 'u-old')).toBe('admin');
      expect(prisma.profiles).toEqual([
        expect.objectContaining({ workspaceId: 'ws-1', email: 'boss@corp.com', employeeNo: 'E000', userId: null }),
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'company.init',
          workspaceId: 'ws-1',
          targetId: 'ws-1',
          metadata: expect.objectContaining({ previousOwnerDemoted: true, ownerUserNotSsoBound: false }),
        }),
      );
    });

    it('review B1：owner 的 email 已有帳密 User、但還沒綁定 SSO → 不給 owner，只記 pendingOwnerEmail（等第一次 SSO 綁定清理後才移交）', async () => {
      prisma.addUser({ id: 'u-squat', email: 'boss@corp.com', passwordHash: 'hash:attacker' });
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE });

      expect(res).toMatchObject({ ownerUserId: null, pendingOwnerEmail: 'boss@corp.com' });
      expect(prisma.workspaces.find((w) => w.id === 'ws-1')).toMatchObject({
        isCompany: true,
        ownerId: 'u-old',
        pendingOwnerEmail: 'boss@corp.com',
      });
      expect(role('ws-1', 'u-squat')).toBeUndefined();
      expect(role('ws-1', 'u-old')).toBe('owner');
      expect(await new CompanyService(prisma as any).isCompanyOwner('u-squat')).toBe(false);
      expect(prisma.users.find((u) => u.id === 'u-squat')!.passwordHash).toBe('hash:attacker'); // 不動，綁定時才清
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ pendingOwner: true, ownerUserNotSsoBound: true }) }),
      );
    });

    it('還沒綁定 SSO 的 owner：不用他的 displayName 當員工姓名（必須給 --full-name）', async () => {
      prisma.addUser({ id: 'u-squat', email: 'boss@corp.com', displayName: '隨便取的名字' });
      await expect(
        service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', employeeNo: 'E0', hireDate: '2020-01-01' }),
      ).rejects.toThrow(/--full-name/);
    });

    it('email 只差大小寫的帳號有兩個以上、又沒有完全相同的 → 拒絕，什麼都不改', async () => {
      prisma.addUser({ id: 'u-a', email: 'CEO@corp.com', ssoBound: true });
      prisma.addUser({ id: 'u-b', email: 'Ceo@corp.com' });
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'ceo@corp.com', ...PROFILE })).rejects.toThrow(
        /多個只差大小寫/,
      );
      expect(companies()).toHaveLength(0);
      expect(prisma.profiles).toHaveLength(0);
    });

    it('有完全相同（小寫）的帳號就用它，不管其他大小寫變體', async () => {
      prisma.addUser({ id: 'u-exact', email: 'ceo@corp.com', ssoBound: true });
      prisma.addUser({ id: 'u-variant', email: 'CEO@corp.com', ssoBound: true });
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'CEO@corp.com', ...PROFILE });
      expect(res.ownerUserId).toBe('u-exact');
    });

    it('email 裡的 _ 不是萬用字元：tom_lee@ 不會對到 tom.lee@ 的帳號', async () => {
      prisma.addUser({ id: 'u-dot', email: 'tom.lee@corp.com', ssoBound: true });
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'tom_lee@corp.com', ...PROFILE });
      expect(res).toMatchObject({ ownerUserId: null, pendingOwnerEmail: 'tom_lee@corp.com' });
    });

    it('已綁定 SSO 的 User 時 --full-name 可省略（用 displayName）', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', displayName: '王老闆', ssoBound: true });
      await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', employeeNo: 'E0', hireDate: '2020-01-01' });
      expect(prisma.profiles[0].fullName).toBe('王老闆');
    });

    it('重跑同一個工作空間：冪等（不建第二個公司工作空間、不重複建員工資料）', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', ssoBound: true });
      await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE });
      const again = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com' });
      expect(again).toMatchObject({ workspaceId: 'ws-1', profile: 'existing' });
      expect(companies()).toHaveLength(1);
      expect(prisma.profiles).toHaveLength(1);
      expect(prisma.members.filter((m) => m.userId === 'u-boss')).toHaveLength(1);
    });

    it('review M30：已有另一個公司工作空間 → 拒絕（明確的訊息，不是 DB 唯一索引的通用錯誤），什麼都不改', async () => {
      prisma.addWorkspace({ id: 'ws-co', name: 'Real Co', ownerId: 'u-old', isCompany: true });
      await expect(service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /已經有公司工作空間（ws-co「Real Co」），不能再指定另一個/,
      );
      expect(prisma.workspace.update).not.toHaveBeenCalled();
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

    it('只有 owner 一位成員：不需要 --allow-existing-members', async () => {
      const res = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE });
      expect(res.existingMembers).toBeNull();
    });

    describe('review S7：既有工作空間已有其他成員', () => {
      beforeEach(() => {
        prisma.addUser({ id: 'u-ext', email: 'ext@partner.com' });
        prisma.addUser({ id: 'u-adm', email: 'adm@corp.com' });
        prisma.addUser({ id: 'u-hr', email: 'hr@corp.com' });
        prisma.addMember('ws-1', 'u-ext', 'member');
        prisma.addMember('ws-1', 'u-adm', 'admin');
        prisma.addMember('ws-1', 'u-hr', 'hr');
      });

      it('沒加 --allow-existing-members → 拒絕，只印數量（不印 email），什麼都不改', async () => {
        const err = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', ...PROFILE }).catch((e) => e);
        expect(err).toBeInstanceOf(CompanyInitError);
        expect(err.message).toContain('共 4 位成員，其中 3 位不是 owner；4 位不在員工主檔；3 位的角色是 owner/admin/hr/finance');
        expect(err.message).toContain('--allow-existing-members');
        expect(err.message).not.toMatch(/@/);
        expect(companies()).toHaveLength(0);
        expect(prisma.profiles).toHaveLength(0);
        expect(prisma.workspace.update).not.toHaveBeenCalled();
      });

      it('加了 --allow-existing-members → 照做，結果與 audit 都帶數量', async () => {
        const res = await service.init({
          workspaceId: 'ws-1',
          ownerEmail: 'boss@corp.com',
          allowExistingMembers: true,
          ...PROFILE,
        });
        const counts = { total: 4, others: 3, withoutProfile: 4, privileged: 3 };
        expect(res.existingMembers).toEqual(counts);
        expect(companies().map((w) => w.id)).toEqual(['ws-1']);
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: expect.objectContaining({ existingMembers: counts }) }),
        );
      });

      it('已經是公司工作空間（重跑）時不檢查：成員是員工 SSO 登入加入的', async () => {
        await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com', allowExistingMembers: true, ...PROFILE });
        const again = await service.init({ workspaceId: 'ws-1', ownerEmail: 'boss@corp.com' });
        expect(again.existingMembers).toBeNull();
      });
    });
  });

  describe('--create <name>（建立新的工作空間）', () => {
    it('owner 的 User 已綁定 SSO：建立公司工作空間，ownerId 與 owner 成員都是他', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', ssoBound: true });
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

    it('review B1：owner 只有還沒綁 SSO 的帳密 User → 一樣要 --executor-email，他不會被設成 owner', async () => {
      prisma.addUser({ id: 'u-squat', email: 'boss@corp.com', passwordHash: 'hash:attacker' });
      await expect(service.init({ createName: 'Co', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /--executor-email/,
      );
      expect(prisma.workspaces).toHaveLength(0);

      prisma.addUser({ id: 'u-exec', email: 'ops@corp.com' });
      const res = await service.init({
        createName: 'Co',
        ownerEmail: 'boss@corp.com',
        executorEmail: 'ops@corp.com',
        ...PROFILE,
      });
      expect(res).toMatchObject({ ownerUserId: null, pendingOwnerEmail: 'boss@corp.com' });
      const ws = prisma.workspaces.find((w) => w.id === res.workspaceId)!;
      expect(ws.ownerId).toBe('u-exec');
      expect(prisma.members).toEqual([{ workspaceId: ws.id, userId: 'u-exec', role: 'owner' }]);
    });

    it('--executor-email 不能是 owner 自己還沒綁 SSO 的帳號', async () => {
      prisma.addUser({ id: 'u-squat', email: 'boss@corp.com' });
      await expect(
        service.init({ createName: 'Co', ownerEmail: 'boss@corp.com', executorEmail: 'BOSS@corp.com', ...PROFILE }),
      ).rejects.toThrow(/不能是 owner 自己/);
      expect(prisma.workspaces).toHaveLength(0);
    });

    it('owner 還沒有 User 又沒給 --executor-email → 拒絕，不建工作空間', async () => {
      await expect(service.init({ createName: 'Co', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /--executor-email/,
      );
      expect(prisma.workspaces).toHaveLength(0);
    });

    it('重跑同名 --create：沿用既有的公司工作空間，不建第二個', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', ssoBound: true });
      const first = await service.init({ createName: 'Oadpiz', ownerEmail: 'boss@corp.com', ...PROFILE });
      const second = await service.init({ createName: 'oadpiz', ownerEmail: 'boss@corp.com' });
      expect(second).toMatchObject({ workspaceId: first.workspaceId, workspaceCreated: false, profile: 'existing' });
      expect(prisma.workspaces).toHaveLength(1);
      expect(companies()).toHaveLength(1);
    });

    it('已有另一個（不同名稱）的公司工作空間 → 拒絕', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', ssoBound: true });
      prisma.addWorkspace({ id: 'ws-co', name: 'Real Co', ownerId: 'u-boss', isCompany: true });
      await expect(service.init({ createName: 'Another', ownerEmail: 'boss@corp.com', ...PROFILE })).rejects.toThrow(
        /--workspace ws-co/,
      );
      expect(prisma.workspaces).toHaveLength(1);
    });

    it('slug 撞名時加 -2；可用 --slug 指定', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', ssoBound: true });
      prisma.addWorkspace({ id: 'ws-x', slug: 'oadpiz', ownerId: 'u-boss' });
      const res = await service.init({ createName: 'Oadpiz', ownerEmail: 'boss@corp.com', ...PROFILE });
      expect(prisma.workspaces.find((w) => w.id === res.workspaceId)!.slug).toBe('oadpiz-2');
    });

    it('DB 的唯一索引擋下同時建立的第二個公司工作空間 → CompanyInitError', async () => {
      prisma.addUser({ id: 'u-boss', email: 'boss@corp.com', ssoBound: true });
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
