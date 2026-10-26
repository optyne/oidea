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
    expect(redis.setNx).toHaveBeenCalledWith(key, '0', USER_STATUS_CACHE_TTL_SECONDS);
    expect(redis.store.get(key)).toBe('0');
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

  describe('S7：停用與舊的「沒停用」寫入競爭', () => {
    /** 讓下一次 DB 查詢停在半路：回傳「放行」函式（放行時回傳查詢當下的使用者狀態）。 */
    const holdNextDbRead = () => {
      let release!: () => void;
      let entered!: () => void;
      const inRead = new Promise<void>((r) => (entered = r));
      const snapshot = { disabledAt: null, deletedAt: null }; // 讀到的是停用前的狀態
      prisma.user.findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(snapshot);
            entered();
          }) as any,
      );
      return { inRead, release: () => release() };
    };

    it.each([
      ['markDisabled', async () => svc.markDisabled('u-1')],
      ['invalidate → markDisabled', async () => (await svc.invalidate('u-1')) && svc.markDisabled('u-1')],
    ])('讀 DB（沒停用）→ %s → 舊結果才寫回：快取仍是停用', async (_label, disable) => {
      const hold = holdNextDbRead();
      const pending = svc.isDisabled('u-1'); // 請求 R：快取 miss，去讀 DB
      await hold.inRead;

      prisma.users.get('u-1')!.disabledAt = new Date(); // H2：停用
      await expect(disable()).resolves.toBe(true);

      hold.release(); // R 拿到停用前的結果，嘗試寫回「沒停用」
      await expect(pending).resolves.toBe(false); // R 本身已經在途，照舊
      expect(redis.store.get(key)).toBe('1');

      prisma.user.findUnique.mockClear();
      await expect(svc.isDisabled('u-1')).resolves.toBe(true); // 下一個請求立刻擋下
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('markDisabled 覆寫已快取的「沒停用」', async () => {
      await expect(svc.isDisabled('u-1')).resolves.toBe(false);
      expect(redis.store.get(key)).toBe('0');
      await expect(svc.markDisabled('u-1')).resolves.toBe(true);
      expect(redis.set).toHaveBeenLastCalledWith(key, '1', USER_STATUS_CACHE_TTL_SECONDS);
      await expect(svc.isDisabled('u-1')).resolves.toBe(true);
    });

    it('「停用」結果一律覆寫（不用 NX）', async () => {
      redis.store.set(key, 'garbage');
      prisma.users.get('u-1')!.disabledAt = new Date();
      await expect(svc.isDisabled('u-1')).resolves.toBe(true);
      expect(redis.store.get(key)).toBe('1');
    });

    it('markDisabled 時 Redis 出錯 → 回 false，不拋錯', async () => {
      redis.mode = 'throw';
      await expect(svc.markDisabled('u-1')).resolves.toBe(false);
    });
  });

  it('invalidate 時 Redis 出錯 → 回 false，不拋錯', async () => {
    redis.mode = 'throw';
    await expect(svc.invalidate('u-1')).resolves.toBe(false);
  });
});
