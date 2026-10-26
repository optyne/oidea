import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { PrismaService } from '../common/prisma.service';

/**
 * In-memory fake of the Prisma calls WorkspacesService makes, so tests read like
 * scenarios ("ws-1 has these members") instead of call-by-call mock setup.
 */
function buildWorkspacePrisma(
  members: Record<string, string>,
  ownerId = 'u-owner',
  users: Record<string, any> = {},
) {
  const state = { members: { ...members }, ownerId };
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
      findFirst: jest.fn(async ({ where }: any) => {
        const id = where.OR?.map((c: any) => c.email ?? c.username).find((k: string) => users[k]);
        return id ? users[id] : null;
      }),
    },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  };
  return prisma;
}

describe('WorkspacesService — characterization (happy paths)', () => {
  let service: WorkspacesService;
  let prisma: any;

  const build = async (members: Record<string, string>, users: Record<string, any> = {}) => {
    prisma = buildWorkspacePrisma(members, 'u-owner', users);
    const module: TestingModule = await Test.createTestingModule({
      providers: [WorkspacesService, { provide: PrismaService, useValue: prisma }],
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
