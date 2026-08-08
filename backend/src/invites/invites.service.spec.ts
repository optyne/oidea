import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { InvitesService } from './invites.service';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';

// tx mock：$transaction(callback) 直接把 txMock 餵給 callback
const buildTx = () => ({
  workspaceInvite: { updateMany: jest.fn() },
  workspaceMember: { create: jest.fn() },
});

describe('InvitesService.accept — TOCTOU 回歸（單次使用保證）', () => {
  let service: InvitesService;
  let prisma: any;
  let tx: ReturnType<typeof buildTx>;

  const INVITE = {
    id: 'inv-1',
    token: 'tok-1',
    workspaceId: 'ws-1',
    role: 'member',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 3600_000),
  };

  beforeEach(async () => {
    tx = buildTx();
    prisma = {
      workspaceInvite: { findUnique: jest.fn().mockResolvedValue(INVITE), updateMany: jest.fn() },
      workspaceMember: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get(InvitesService);
  });

  it('搶到 invite（updateMany count=1）→ 建立 member', async () => {
    tx.workspaceInvite.updateMany.mockResolvedValue({ count: 1 });
    tx.workspaceMember.create.mockResolvedValue({ id: 'm-1', workspaceId: 'ws-1' });

    await service.accept('u-1', 'tok-1');

    expect(tx.workspaceInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'inv-1', consumedAt: null }),
      }),
    );
    expect(tx.workspaceMember.create).toHaveBeenCalled();
  });

  it('沒搶到（count=0，被併發者先消費）→ Forbidden，不建 member', async () => {
    tx.workspaceInvite.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.accept('u-2', 'tok-1')).rejects.toThrow(ForbiddenException);
    expect(tx.workspaceInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'inv-1', consumedAt: null }),
      }),
    );
    expect(tx.workspaceMember.create).not.toHaveBeenCalled();
  });

  it('已是成員 → 走條件式 updateMany 消費（帶 consumedAt:null 過濾），不建 member', async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue({ id: 'm-0', role: 'admin' });
    prisma.workspaceInvite.updateMany.mockResolvedValue({ count: 1 });

    await service.accept('u-3', 'tok-1');

    expect(prisma.workspaceInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ consumedAt: null }),
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
