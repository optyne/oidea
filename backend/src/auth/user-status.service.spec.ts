import { UserStatusService, USER_STATUS_CACHE_TTL_SECONDS } from './user-status.service';
import { FakeClock } from '../common/clock';
import { FakePrisma, FakeRedis } from './testing/auth-fakes';

describe('UserStatusService（停用檢查＋30 秒快取）', () => {
  let prisma: FakePrisma;
  let redis: FakeRedis;
  let svc: UserStatusService;
  const key = UserStatusService.cacheKey('u-1');

  beforeEach(() => {
    prisma = new FakePrisma(new FakeClock());
    prisma.addUser({ id: 'u-1', email: 'a@example.com' });
    redis = new FakeRedis();
    svc = new UserStatusService(prisma as any, redis as any);
  });

  it('快取 miss → 主鍵查 DB，並把「沒停用」也寫進快取（TTL 30 秒）', async () => {
    await expect(svc.isDisabled('u-1')).resolves.toBe(false);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      select: { disabledAt: true, deletedAt: true },
    });
    expect(redis.set).toHaveBeenCalledWith(key, '0', USER_STATUS_CACHE_TTL_SECONDS);
  });

  it('停用的結果也快取', async () => {
    prisma.users.get('u-1')!.disabledAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(key, '1', USER_STATUS_CACHE_TTL_SECONDS);
  });

  it('快取命中 → 不查 DB', async () => {
    redis.store.set(key, '1');
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
    redis.store.set(key, '0');
    await expect(svc.isDisabled('u-1')).resolves.toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('快取值看不懂 → 當成 miss 回 DB', async () => {
    redis.store.set(key, 'garbage');
    prisma.users.get('u-1')!.disabledAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
  });

  it('Redis 出錯 → 回 DB 查（不把錯誤當成沒停用）', async () => {
    redis.mode = 'throw';
    prisma.users.get('u-1')!.disabledAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalled();
  });

  it('Redis 卡住（斷線排隊）→ 逾時後回 DB 查', async () => {
    redis.mode = 'hang';
    prisma.users.get('u-1')!.disabledAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
  });

  it('使用者不存在或已刪除 → 視為停用', async () => {
    await expect(svc.isDisabled('ghost')).resolves.toBe(true);
    prisma.users.get('u-1')!.deletedAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
  });

  it('DB 出錯 → 往上拋（呼叫端拒絕請求）', async () => {
    prisma.user.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.isDisabled('u-1')).rejects.toThrow('db down');
  });

  it('invalidate 清掉快取，下一次回 DB 拿到最新狀態', async () => {
    await expect(svc.isDisabled('u-1')).resolves.toBe(false);
    prisma.users.get('u-1')!.disabledAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(false); // 快取仍是舊值
    await expect(svc.invalidate('u-1')).resolves.toBe(true);
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
  });

  it('invalidate 時 Redis 出錯 → 回 false，不拋錯', async () => {
    redis.mode = 'throw';
    await expect(svc.invalidate('u-1')).resolves.toBe(false);
  });
});
