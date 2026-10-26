import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { BotAuthGuard } from './bot-auth.guard';
import { BotsService } from './bots.service';
import { CompanyService } from '../company/company.service';
import { UserStatusService } from '../auth/user-status.service';

jest.mock('bcrypt', () => ({
  compare: jest.fn(async (secret: string, hash: string) => hash === `hashed:${secret}`),
  hash: jest.fn(async (s: string) => `hashed:${s}`),
}));

const ctxFor = (req: any) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

/**
 * H2 follow-up：`/bot/*`（BotAuthGuard）也要拒絕「建立者已停用」的 bot，用跟 JwtStrategy 同一套
 * UserStatusService 快取；公司工作空間不能建立 bot。
 */
describe('BotAuthGuard／BotsService（H2）', () => {
  const BOT = {
    id: 'bot-1',
    tokenHash: 'hashed:s3cret',
    revokedAt: null,
    userId: 'bot-user-1',
    workspaceId: 'ws-1',
    createdById: 'creator-1',
    workspace: { isCompany: false },
  };
  let prisma: any;
  let redis: any;
  let service: BotsService;
  let guard: BotAuthGuard;
  let userStatus: UserStatusService;
  const req = () => ({ headers: { authorization: 'Bearer bot_abcdef.s3cret' } }) as any;

  beforeEach(() => {
    prisma = {
      botAccount: { findUnique: jest.fn().mockResolvedValue(BOT), update: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ disabledAt: null, deletedAt: null, tokenVersion: 0 }) },
      workspace: { findUnique: jest.fn().mockResolvedValue({ isCompany: false }) },
      workspaceMember: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    const store = new Map<string, string>();
    redis = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
      setNx: jest.fn(async (k: string, v: string) => (store.has(k) ? false : (store.set(k, v), true))),
      del: jest.fn(async (k: string) => void store.delete(k)),
    };
    userStatus = new UserStatusService(prisma, redis);
    service = new BotsService(prisma, { record: jest.fn() } as any, userStatus, new CompanyService(prisma));
    guard = new BotAuthGuard(service);
  });

  it('建立者沒停用 → 通過，req.bot 有值', async () => {
    const r = req();
    await expect(guard.canActivate(ctxFor(r))).resolves.toBe(true);
    expect(r.bot).toEqual({ botId: 'bot-1', userId: 'bot-user-1', workspaceId: 'ws-1' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'creator-1' } }));
  });

  it('建立者已停用（DB）→ 401', async () => {
    prisma.user.findUnique.mockResolvedValue({ disabledAt: new Date(), deletedAt: null, tokenVersion: 0 });
    await expect(guard.canActivate(ctxFor(req()))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('離職時 markDisabled() 寫的快取 → 立刻 401（跟 JwtStrategy 同一個快取 key）', async () => {
    await expect(guard.canActivate(ctxFor(req()))).resolves.toBe(true); // 快取：沒停用
    await userStatus.markDisabled('creator-1');
    await expect(guard.canActivate(ctxFor(req()))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(redis.set).toHaveBeenCalledWith(UserStatusService.cacheKey('creator-1'), '1', expect.any(Number));
  });

  it('查停用狀態時 DB 出錯 → 拒絕（不會放行）', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const r = req();
    await expect(guard.canActivate(ctxFor(r))).rejects.toThrow('db down');
    expect(r.bot).toBeUndefined();
  });

  it('已撤銷、secret 不符、公司工作空間的 bot → 401', async () => {
    prisma.botAccount.findUnique.mockResolvedValueOnce({ ...BOT, revokedAt: new Date() });
    await expect(guard.canActivate(ctxFor(req()))).rejects.toBeInstanceOf(UnauthorizedException);
    prisma.botAccount.findUnique.mockResolvedValueOnce({ ...BOT, tokenHash: 'hashed:other' });
    await expect(guard.canActivate(ctxFor(req()))).rejects.toBeInstanceOf(UnauthorizedException);
    prisma.botAccount.findUnique.mockResolvedValueOnce({ ...BOT, workspace: { isCompany: true } });
    await expect(guard.canActivate(ctxFor(req()))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('在公司工作空間建立 bot → 403，什麼都沒寫', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ isCompany: true });
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: 'owner' });
    await expect(service.create('u-owner', 'ws-company', { name: 'helper' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
