import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { PrismaService } from '../common/prisma.service';
import { CompanyService } from '../company/company.service';

/**
 * In-memory fake of the Prisma calls WorkspacesService makes, so tests read like
 * scenarios ("ws-1 has these members") instead of call-by-call mock setup.
 */
function buildWorkspacePrisma(
  members: Record<string, string>,
  ownerId = 'u-owner',
  users: Record<string, any> = {},
) {
  const state = {
    members: { ...members },
    ownerId,
    /** Per-user flags for `user.findUnique` (default: active human user). */
    userFlags: {} as Record<string, { disabledAt?: Date; deletedAt?: Date; bot?: boolean; missing?: boolean }>,
  };
  const memberRow = (userId: string) =>
    state.members[userId] ? { workspaceId: 'ws-1', userId, role: state.members[userId] } : null;
  const prisma: any = {
    state,
    workspace: {
      create: jest.fn(async ({ data }: any) => ({ id: 'ws-new', ...data, members: [] })),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'ws-1'
          ? {
              id: 'ws-1',
              ownerId: state.ownerId,
              members: Object.keys(state.members).map((u) => memberRow(u)),
            }
          : null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        if (data.ownerId) state.ownerId = data.ownerId;
        return { id: where.id, ownerId: state.ownerId, ...data };
      }),
    },
    workspaceMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return workspaceId === 'ws-1' ? memberRow(userId) : null;
      }),
      findMany: jest.fn(async () => Object.keys(state.members).map((u) => memberRow(u))),
      count: jest.fn(async ({ where }: any) =>
        Object.values(state.members).filter((r) => !where?.role || r === where.role).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        state.members[data.userId] = data.role;
        return { id: `m-${data.userId}`, ...data };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const { userId } = where.workspaceId_userId;
        state.members[userId] = data.role;
        return { ...memberRow(userId) };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const { userId } = where.workspaceId_userId;
        const row = memberRow(userId);
        delete state.members[userId];
        return row;
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const f = state.userFlags[where.id] ?? {};
        if (f.missing) return null;
        return {
          id: where.id,
          disabledAt: f.disabledAt ?? null,
          deletedAt: f.deletedAt ?? null,
          botAccount: f.bot ? { id: `bot-${where.id}` } : null,
        };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const id = where.OR?.map((c: any) => c.email ?? c.username).find((k: string) => users[k]);
        return id ? users[id] : null;
      }),
    },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
    $executeRaw: jest.fn(async () => 1),
  };
  return prisma;
}

describe('WorkspacesService — characterization (happy paths)', () => {
  let service: WorkspacesService;
  let prisma: any;

  const build = async (members: Record<string, string>, users: Record<string, any> = {}) => {
    prisma = buildWorkspacePrisma(members, 'u-owner', users);
    const module: TestingModule = await Test.createTestingModule({
      providers: [WorkspacesService, CompanyService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(WorkspacesService);
  };

  beforeEach(() =>
    build({ 'u-owner': 'owner', 'u-admin': 'admin', 'u-member': 'member' }, {
      'bob@x.com': { id: 'u-bob', email: 'bob@x.com', username: 'bob', displayName: 'Bob' },
    }),
  );

  it('create makes the caller owner (ownerId + owner member row)', async () => {
    await service.create('u-1', { name: 'A', slug: 'a' } as any);
    const data = prisma.workspace.create.mock.calls[0][0].data;
    expect(data.ownerId).toBe('u-1');
    expect(data.members).toEqual({ create: { userId: 'u-1', role: 'owner' } });
  });

  it('findById: member ok, non-member forbidden, missing 404', async () => {
    await expect(service.findById('u-member', 'ws-1')).resolves.toEqual(expect.objectContaining({ id: 'ws-1' }));
    await expect(service.findById('u-x', 'ws-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.findById('u-member', 'ws-404')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('admin updates workspace; owner deletes (soft)', async () => {
    await service.update('u-admin', 'ws-1', { name: 'B' } as any);
    expect(prisma.workspace.update).toHaveBeenCalled();
    const res: any = await service.delete('u-owner', 'ws-1');
    expect(res.deletedAt).toBeInstanceOf(Date);
  });

  it('member cannot update; admin cannot delete', async () => {
    await expect(service.update('u-member', 'ws-1', { name: 'B' } as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.delete('u-admin', 'ws-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin invites by userId and by identifier; duplicate invite forbidden', async () => {
    const m: any = await service.inviteMember('u-admin', 'ws-1', 'u-new');
    expect(m).toEqual(expect.objectContaining({ userId: 'u-new', role: 'member' }));
    const m2: any = await service.inviteByIdentifier('u-admin', 'ws-1', 'bob@x.com', 'finance');
    expect(m2).toEqual(expect.objectContaining({ userId: 'u-bob', role: 'finance' }));
    await expect(service.inviteMember('u-admin', 'ws-1', 'u-member')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.inviteByIdentifier('u-admin', 'ws-1', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('member cannot invite', async () => {
    await expect(service.inviteMember('u-member', 'ws-1', 'u-new')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('admin removes a member', async () => {
    await service.removeMember('u-admin', 'ws-1', 'u-member');
    expect(prisma.state.members['u-member']).toBeUndefined();
  });

  it('admin changes a member role; invalid role and self-demotion to member rejected', async () => {
    await service.updateMemberRole('u-admin', 'ws-1', 'u-member', 'hr');
    expect(prisma.state.members['u-member']).toBe('hr');
    await expect(service.updateMemberRole('u-admin', 'ws-1', 'u-member', 'god')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.updateMemberRole('u-admin', 'ws-1', 'u-admin', 'member')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('listMembers: member ok, non-member forbidden', async () => {
    await expect(service.listMembers('u-member', 'ws-1')).resolves.toHaveLength(3);
    await expect(service.listMembers('u-x', 'ws-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('WorkspacesService — H0 roles & owner rules', () => {
  let service: WorkspacesService;
  let prisma: any;

  const build = async (members: Record<string, string>, ownerId = 'u-owner') => {
    prisma = buildWorkspacePrisma(members, ownerId);
    const module: TestingModule = await Test.createTestingModule({
      providers: [WorkspacesService, CompanyService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(WorkspacesService);
  };

  beforeEach(() =>
    build({
      'u-owner': 'owner',
      'u-admin': 'admin',
      'u-hr': 'hr',
      'u-fin': 'finance',
      'u-member': 'member',
    }),
  );

  describe.each(['u-hr', 'u-fin'])('%s (no rank equivalence with admin)', (actor) => {
    it('cannot change anyone’s role', async () => {
      await expect(service.updateMemberRole(actor, 'ws-1', 'u-member', 'admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.workspaceMember.update).not.toHaveBeenCalled();
    });

    it('cannot remove members, including the owner', async () => {
      await expect(service.removeMember(actor, 'ws-1', 'u-member')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.removeMember(actor, 'ws-1', 'u-owner')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.workspaceMember.delete).not.toHaveBeenCalled();
    });

    it('cannot promote anyone (including self) to owner', async () => {
      await expect(service.updateMemberRole(actor, 'ws-1', actor, 'owner')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.updateMemberRole(actor, 'ws-1', 'u-member', 'owner')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.state.members[actor]).not.toBe('owner');
    });

    it('cannot invite or update the workspace', async () => {
      await expect(service.inviteMember(actor, 'ws-1', 'u-new')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.update(actor, 'ws-1', { name: 'x' } as any)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('cannot transfer ownership', async () => {
      await expect(service.transferOwnership(actor, 'ws-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.state.ownerId).toBe('u-owner');
    });
  });

  describe('admin cannot act on an owner', () => {
    it('cannot demote or remove the owner', async () => {
      await expect(service.updateMemberRole('u-admin', 'ws-1', 'u-owner', 'member')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.removeMember('u-admin', 'ws-1', 'u-owner')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.state.members['u-owner']).toBe('owner');
    });

    it('cannot assign owner by role change or invite', async () => {
      await expect(service.updateMemberRole('u-admin', 'ws-1', 'u-member', 'owner')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.inviteMember('u-admin', 'ws-1', 'u-new', 'owner')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.state.members['u-new']).toBeUndefined();
    });

    it('cannot act on a co-owner either', async () => {
      prisma.state.members['u-co'] = 'owner';
      await expect(service.updateMemberRole('u-admin', 'ws-1', 'u-co', 'admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.removeMember('u-admin', 'ws-1', 'u-co')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('can still manage non-owner members', async () => {
      await service.updateMemberRole('u-admin', 'ws-1', 'u-member', 'hr');
      expect(prisma.state.members['u-member']).toBe('hr');
      await service.removeMember('u-admin', 'ws-1', 'u-fin');
      expect(prisma.state.members['u-fin']).toBeUndefined();
    });
  });

  describe('owner invariants', () => {
    it('the only owner cannot demote themselves', async () => {
      await expect(service.updateMemberRole('u-owner', 'ws-1', 'u-owner', 'admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.state.members['u-owner']).toBe('owner');
    });

    it('the only owner cannot remove themselves', async () => {
      await expect(service.removeMember('u-owner', 'ws-1', 'u-owner')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.state.members['u-owner']).toBe('owner');
    });

    it('≥1 owner kept even when ownerId is out of sync with member roles', async () => {
      await build({ 'u-owner': 'owner', 'u-admin': 'admin' }, 'u-legacy');
      await expect(service.updateMemberRole('u-owner', 'ws-1', 'u-owner', 'admin')).rejects.toThrow(
        /至少要保留一位 owner/,
      );
    });

    it('the main owner (ownerId) cannot be demoted by a co-owner until transferred', async () => {
      prisma.state.members['u-co'] = 'owner';
      await expect(service.updateMemberRole('u-co', 'ws-1', 'u-owner', 'admin')).rejects.toThrow(/先移交/);
      await expect(service.removeMember('u-co', 'ws-1', 'u-owner')).rejects.toThrow(/先移交/);
    });

    it('owner may assign a co-owner and demote a co-owner (ownerId unchanged)', async () => {
      await service.updateMemberRole('u-owner', 'ws-1', 'u-admin', 'owner');
      expect(prisma.state.members['u-admin']).toBe('owner');
      expect(prisma.state.ownerId).toBe('u-owner');
      await service.updateMemberRole('u-owner', 'ws-1', 'u-admin', 'admin');
      expect(prisma.state.members['u-admin']).toBe('admin');
    });

    it('invalid invite role → 400', async () => {
      await expect(service.inviteMember('u-admin', 'ws-1', 'u-new', 'god')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('acting on a non-member target → 404', async () => {
      await expect(service.updateMemberRole('u-admin', 'ws-1', 'u-ghost', 'hr')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.removeMember('u-admin', 'ws-1', 'u-ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('transferOwnership', () => {
    it('owner transfers: target becomes owner, Workspace.ownerId updated, previous owner becomes admin', async () => {
      const res = await service.transferOwnership('u-owner', 'ws-1', 'u-admin');
      expect(prisma.state.ownerId).toBe('u-admin');
      expect(prisma.state.members['u-admin']).toBe('owner');
      expect(prisma.state.members['u-owner']).toBe('admin');
      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { ownerId: 'u-admin' },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(res).toEqual(expect.objectContaining({ ownerId: 'u-admin', previousOwnerId: 'u-owner' }));
    });

    it('after transfer the previous owner can no longer act on the new owner', async () => {
      await service.transferOwnership('u-owner', 'ws-1', 'u-member');
      await expect(service.updateMemberRole('u-owner', 'ws-1', 'u-member', 'admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('admin cannot transfer; target must be a member; cannot transfer to self', async () => {
      await expect(service.transferOwnership('u-admin', 'ws-1', 'u-admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.transferOwnership('u-owner', 'ws-1', 'u-ghost')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.transferOwnership('u-owner', 'ws-1', 'u-owner')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.state.ownerId).toBe('u-owner');
    });

    it('a co-owner cannot transfer, so cannot strip and then remove the main owner (S1)', async () => {
      prisma.state.members['u-co'] = 'owner';
      await expect(service.transferOwnership('u-co', 'ws-1', 'u-member')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.state.ownerId).toBe('u-owner');
      expect(prisma.state.members['u-member']).toBe('member');
      expect(prisma.state.members['u-co']).toBe('owner');
      // The second step of the attack therefore still hits the main-owner guard.
      await expect(service.removeMember('u-co', 'ws-1', 'u-owner')).rejects.toThrow(/先移交/);
      expect(prisma.state.members['u-owner']).toBe('owner');
    });

    it.each([
      ['disabled', { disabledAt: new Date('2026-10-01') }],
      ['deleted', { deletedAt: new Date('2026-10-01') }],
      ['missing', { missing: true }],
    ])('a co-owner can take over the transfer when the main owner is %s', async (_label, flags) => {
      prisma.state.members['u-co'] = 'owner';
      prisma.state.userFlags['u-owner'] = flags;
      const res = await service.transferOwnership('u-co', 'ws-1', 'u-member');
      expect(prisma.state.ownerId).toBe('u-member');
      expect(prisma.state.members['u-member']).toBe('owner');
      expect(prisma.state.members['u-co']).toBe('owner');
      expect(res).toEqual(expect.objectContaining({ previousOwnerId: 'u-owner', actorNewRole: 'owner' }));
    });

    it('a co-owner can take over the transfer when the main owner is no longer a member', async () => {
      prisma.state.members['u-co'] = 'owner';
      delete prisma.state.members['u-owner'];
      await service.transferOwnership('u-co', 'ws-1', 'u-member');
      expect(prisma.state.ownerId).toBe('u-member');
    });

    it.each([
      ['a bot account', { bot: true }],
      ['a disabled user', { disabledAt: new Date('2026-10-01') }],
      ['a deleted user', { deletedAt: new Date('2026-10-01') }],
      ['a user row that no longer exists', { missing: true }],
    ])('target cannot be %s → 400, nothing changes (S1)', async (_label, flags) => {
      prisma.state.userFlags['u-member'] = flags;
      await expect(service.transferOwnership('u-owner', 'ws-1', 'u-member')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.state.ownerId).toBe('u-owner');
      expect(prisma.state.members['u-member']).toBe('member');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([[undefined], [null], [''], ['   '], [123], [{ id: 'u-member' }], [['u-member']]])(
      'body.userId %p that is not a non-empty string → 400 before any DB write (N6)',
      async (bad) => {
        await expect(service.transferOwnership('u-owner', 'ws-1', bad as any)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(1); // only the caller's permission check
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });
});

describe('WorkspacesService — H2 review S3/S4', () => {
  let service: WorkspacesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = buildWorkspacePrisma({ 'u-owner': 'owner', 'u-admin': 'admin', 'u-member': 'member' });
    const row = { id: 'ws-1', ownerId: 'u-owner', isCompany: true, pendingOwnerEmail: 'boss@corp.com' };
    prisma.workspace.findMany = jest.fn(async () => [{ ...row, _count: { members: 3, channels: 0, projects: 0 } }]);
    const findUnique = prisma.workspace.findUnique;
    prisma.workspace.findUnique = jest.fn(async (args: any) => {
      const ws = await findUnique(args);
      return ws ? { ...ws, isCompany: true, pendingOwnerEmail: 'boss@corp.com' } : ws;
    });
    prisma.workspaceMember.findMany = jest.fn(async ({ where }: any) =>
      Object.entries(prisma.state.members)
        .filter(([u]) => !where?.userId || u === where.userId)
        .map(([userId, role]) => ({ workspaceId: 'ws-1', userId, role })),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [WorkspacesService, CompanyService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(WorkspacesService);
  });

  it('S4: pendingOwnerEmail is only returned to owner/admin; isCompany stays', async () => {
    const [asMember] = await service.findAll('u-member');
    expect(asMember).not.toHaveProperty('pendingOwnerEmail');
    expect(asMember).toMatchObject({ id: 'ws-1', isCompany: true });
    expect((await service.findAll('u-admin'))[0]).toMatchObject({ pendingOwnerEmail: 'boss@corp.com' });
    expect((await service.findAll('u-owner'))[0]).toMatchObject({ pendingOwnerEmail: 'boss@corp.com' });

    const byIdMember = await service.findById('u-member', 'ws-1');
    expect(byIdMember).not.toHaveProperty('pendingOwnerEmail');
    expect(byIdMember).toMatchObject({ isCompany: true });
    expect(await service.findById('u-admin', 'ws-1')).toMatchObject({ pendingOwnerEmail: 'boss@corp.com' });
  });

  it('S3: create takes the user lock and refuses a disabled (terminated) user', async () => {
    prisma.state.userFlags['u-gone'] = { disabledAt: new Date() };
    await expect(service.create('u-gone', { name: 'A', slug: 'a' } as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspace.create).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('S3: transfer re-checks the target under the user lock (terminated meanwhile → 400, nothing written)', async () => {
    const original = prisma.user.findUnique;
    let calls = 0;
    // 第一次（交易外的預檢）看到在職，第二次（鎖底下）看到剛被停用
    prisma.user.findUnique = jest.fn(async (args: any) => {
      const u = await original(args);
      if (args.where.id === 'u-member' && ++calls >= 2) return { ...u, disabledAt: new Date() };
      return u;
    });
    await expect(service.transferOwnership('u-owner', 'ws-1', 'u-member')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.state.ownerId).toBe('u-owner');
    expect(prisma.state.members['u-member']).toBe('member');
  });

  it('S3: inviting or promoting to owner a disabled user is refused', async () => {
    // 一般工作空間（公司工作空間本來就不能邀請）
    prisma.workspace.findUnique = jest.fn(async ({ where }: any) =>
      where.id === 'ws-1' ? { id: 'ws-1', ownerId: 'u-owner', isCompany: false } : null,
    );
    prisma.state.userFlags['u-gone'] = { disabledAt: new Date() };
    await expect(service.inviteMember('u-owner', 'ws-1', 'u-gone')).rejects.toBeInstanceOf(BadRequestException);
    prisma.state.userFlags['u-member'] = { disabledAt: new Date() };
    await expect(service.updateMemberRole('u-owner', 'ws-1', 'u-member', 'owner')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.state.members['u-member']).toBe('member');
  });
});
