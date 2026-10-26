import { ForbiddenException } from '@nestjs/common';
import { InvitesService } from '../invites/invites.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { CompanyService } from './company.service';

/**
 * spec §4.3「邀請」：公司工作空間的成員只由員工生命週期決定。所有邀請／加人入口都回 403，
 * 而且在寫入任何東西之前就擋下。一般工作空間照舊。另外公司工作空間不能刪除（§4.1）。
 */
describe('公司工作空間不接受邀請', () => {
  const COMPANY = 'ws-co';
  const OTHER = 'ws-other';
  let prisma: any;
  let invites: InvitesService;
  let workspaces: WorkspacesService;

  beforeEach(() => {
    prisma = {
      workspace: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === COMPANY || where.id === OTHER ? { id: where.id, isCompany: where.id === COMPANY } : null,
        ),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
      workspaceMember: {
        // 呼叫者是兩個工作空間的 owner；被邀請的人還不是成員
        findUnique: jest.fn(async ({ where }: any) =>
          where.workspaceId_userId.userId === 'u-admin' ? { role: 'owner' } : null,
        ),
        create: jest.fn(async ({ data }: any) => ({ id: 'm-new', ...data })),
      },
      workspaceInvite: {
        create: jest.fn(async ({ data }: any) => ({ id: 'inv-new', ...data })),
        findUnique: jest.fn(async ({ where }: any) => ({
          id: `inv-${where.token}`,
          token: where.token,
          workspaceId: where.token === 'tok-co' ? COMPANY : OTHER,
          role: 'member',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      user: {
        findFirst: jest.fn(async () => ({ id: 'u-bob', email: 'bob@x.com', username: 'bob', displayName: 'Bob' })),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
    };
    const company = new CompanyService(prisma);
    invites = new InvitesService(prisma, { record: jest.fn() } as any, company);
    workspaces = new WorkspacesService(prisma, company);
  });

  const expectNoWrites = () => {
    expect(prisma.workspaceInvite.create).not.toHaveBeenCalled();
    expect(prisma.workspaceInvite.updateMany).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  };

  it('建立邀請連結（/invite/:token 用的 token）→ 403', async () => {
    await expect(invites.create('u-admin', COMPANY, {})).rejects.toBeInstanceOf(ForbiddenException);
    expectNoWrites();
  });

  it('接受 company:init 之前發出的公司工作空間邀請 → 403，不消耗邀請、不加成員', async () => {
    await expect(invites.accept('u-new', 'tok-co')).rejects.toBeInstanceOf(ForbiddenException);
    expectNoWrites();
  });

  it('已是成員的人接受公司工作空間邀請 → 403', async () => {
    await expect(invites.accept('u-admin', 'tok-co')).rejects.toBeInstanceOf(ForbiddenException);
    expectNoWrites();
  });

  it('inviteMember（用 userId 加人）→ 403', async () => {
    await expect(workspaces.inviteMember('u-admin', COMPANY, 'u-bob')).rejects.toBeInstanceOf(ForbiddenException);
    expectNoWrites();
  });

  it('inviteByIdentifier（用 email／username 加人）→ 403', async () => {
    await expect(workspaces.inviteByIdentifier('u-admin', COMPANY, 'bob@x.com')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expectNoWrites();
  });

  it('刪除公司工作空間 → 403', async () => {
    await expect(workspaces.delete('u-admin', COMPANY)).rejects.toThrow('公司工作空間不能刪除');
    expectNoWrites();
  });

  it('一般工作空間：四個入口照常可用、可以刪除', async () => {
    await expect(invites.create('u-admin', OTHER, {})).resolves.toMatchObject({ workspaceId: OTHER });
    await expect(invites.accept('u-new', 'tok-other')).resolves.toMatchObject({ workspaceId: OTHER });
    await expect(workspaces.inviteMember('u-admin', OTHER, 'u-bob')).resolves.toMatchObject({ userId: 'u-bob' });
    await expect(workspaces.inviteByIdentifier('u-admin', OTHER, 'bob@x.com')).resolves.toMatchObject({
      userId: 'u-bob',
    });
    await expect(workspaces.delete('u-admin', OTHER)).resolves.toMatchObject({ id: OTHER });
  });
});

describe('CompanyService', () => {
  it('findCompanyOwnership：ownerId 或成員角色 owner 才算；已刪除的公司工作空間不算', async () => {
    const ws: any = { id: 'ws-co', ownerId: 'u-main', deletedAt: null };
    const prisma: any = {
      workspace: { findFirst: jest.fn(async () => ws) },
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) => {
          const role = { 'u-co': 'owner', 'u-admin': 'admin' }[where.workspaceId_userId.userId as string];
          return role ? { role } : null;
        }),
      },
    };
    const company = new CompanyService(prisma);
    expect(await company.isCompanyOwner('u-main')).toBe(true);
    expect(await company.isCompanyOwner('u-co')).toBe(true);
    expect(await company.isCompanyOwner('u-admin')).toBe(false);
    expect(await company.isCompanyOwner('u-none')).toBe(false);
    ws.deletedAt = new Date();
    expect(await company.isCompanyOwner('u-main')).toBe(false);
    prisma.workspace.findFirst.mockResolvedValue(null);
    expect(await company.findCompanyWorkspace()).toBeNull();
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { isCompany: true } }));
  });
});
