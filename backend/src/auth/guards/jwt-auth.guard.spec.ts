import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

jest.mock('bcrypt', () => ({
  compare: jest.fn(async (secret: string, hash: string) => hash === `hashed:${secret}`),
}));

const ctxFor = (req: any) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

/**
 * 特徵測試：bot token 路徑（`Bearer bot_<prefix>.<secret>`）。
 */
describe('JwtAuthGuard — bot token path (characterization)', () => {
  const BOT = {
    id: 'bot-1',
    tokenHash: 'hashed:s3cret',
    revokedAt: null,
    userId: 'bot-user-1',
    workspaceId: 'ws-1',
    createdById: 'creator-1',
  };
  let prisma: any;
  let guard: JwtAuthGuard;
  let userStatus: { isDisabled: jest.Mock };

  beforeEach(() => {
    prisma = {
      botAccount: {
        findUnique: jest.fn().mockResolvedValue(BOT),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    userStatus = { isDisabled: jest.fn().mockResolvedValue(false) };
    guard = new JwtAuthGuard(prisma, userStatus as any);
  });

  it('有效 bot token → 通過，req.user 為 bot 身分', async () => {
    const req: any = { headers: { authorization: 'Bearer bot_abcdef.s3cret' } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(prisma.botAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenPrefix: 'bot_abcdef' } }),
    );
    expect(req.user).toEqual({
      userId: 'bot-user-1',
      botId: 'bot-1',
      workspaceId: 'ws-1',
      isBot: true,
    });
  });

  it('格式錯誤（沒有 secret）→ 401', async () => {
    const req: any = { headers: { authorization: 'Bearer bot_abcdef' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toThrow(UnauthorizedException);
  });

  it('已撤銷 → 401', async () => {
    prisma.botAccount.findUnique.mockResolvedValue({ ...BOT, revokedAt: new Date() });
    const req: any = { headers: { authorization: 'Bearer bot_abcdef.s3cret' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toThrow(UnauthorizedException);
  });

  it('secret 不符 → 401', async () => {
    const req: any = { headers: { authorization: 'Bearer bot_abcdef.wrong' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toThrow(UnauthorizedException);
    expect(req.user).toBeUndefined();
  });

  // H0：bot 的建立者被停用 → bot 一起失效
  it('建立者已停用 → 401，且以 createdById 查停用狀態', async () => {
    userStatus.isDisabled.mockResolvedValue(true);
    const req: any = { headers: { authorization: 'Bearer bot_abcdef.s3cret' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toThrow(UnauthorizedException);
    expect(userStatus.isDisabled).toHaveBeenCalledWith('creator-1');
    expect(req.user).toBeUndefined();
  });

  it('review S2：建立者的帳號在 SSO 綁定時重設過，bot 建立時間早於 sessionsValidAfter → 401', async () => {
    const createdAt = new Date('2026-10-01T00:00:00Z');
    prisma.botAccount.findUnique.mockResolvedValue({ ...BOT, createdAt });
    const isIssuedBeforeCutoff = jest.fn().mockResolvedValue(true);
    guard = new JwtAuthGuard(prisma, { ...userStatus, isIssuedBeforeCutoff } as any);
    const req: any = { headers: { authorization: 'Bearer bot_abcdef.s3cret' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toThrow(UnauthorizedException);
    expect(isIssuedBeforeCutoff).toHaveBeenCalledWith('creator-1', createdAt);
    expect(req.user).toBeUndefined();

    isIssuedBeforeCutoff.mockResolvedValue(false);
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
  });

  it('查停用狀態出錯 → 拒絕（fail closed）', async () => {
    userStatus.isDisabled.mockRejectedValue(new Error('db down'));
    const req: any = { headers: { authorization: 'Bearer bot_abcdef.s3cret' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toThrow();
    expect(req.user).toBeUndefined();
  });
});
