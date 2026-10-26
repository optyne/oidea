import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from '../common/prisma.service';

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
