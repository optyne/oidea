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
      select: { disabledAt: true, deletedAt: true, tokenVersion: true },
    });
    expect(redis.setNx).toHaveBeenCalledWith(key, 't:0', USER_STATUS_CACHE_TTL_SECONDS);
    expect(redis.store.get(key)).toBe('t:0');
  });

  it('停用的結果也快取', async () => {
    prisma.users.get('u-1')!.disabledAt = new Date();
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(key, '1', USER_STATUS_CACHE_TTL_SECONDS);
  });

  it('快取命中 → 不查 DB', async () => {
    redis.store.set(key, '1');
    await expect(svc.isDisabled('u-1')).resolves.toBe(true);
    redis.store.set(key, 't:0');
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
      const snapshot = { disabledAt: null, deletedAt: null, tokenVersion: 0 }; // 讀到的是停用前的狀態
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
      expect(redis.store.get(key)).toBe('t:0');
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

  describe('review R1：tokenVersion（SSO 綁定後舊 access token 失效，沒有同一秒的空窗）', () => {
    const bind = () => (prisma.users.get('u-1')!.tokenVersion += 1);

    it('tv 等於現在的版本 → ok；快取記成 t:<版本>，之後命中不查 DB', async () => {
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('ok');
      expect(redis.store.get(key)).toBe('t:0');
      prisma.user.findUnique.mockClear();
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('ok');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('tv 不等於現在的版本（舊的或比較新的都不行）→ stale', async () => {
      prisma.users.get('u-1')!.tokenVersion = 3;
      await expect(svc.checkAccessToken('u-1', 2)).resolves.toBe('stale');
      await expect(svc.checkAccessToken('u-1', 4)).resolves.toBe('stale');
      await expect(svc.checkAccessToken('u-1', 3)).resolves.toBe('ok');
    });

    it('沒有 tv（H0 簽的 token）或格式不對 → stale', async () => {
      for (const tv of [undefined, null, '0', 0.5, -1, Number.NaN, {}]) {
        await expect(svc.checkAccessToken('u-1', tv)).resolves.toBe('stale');
      }
    });

    it('停用優先於版本', async () => {
      prisma.users.get('u-1')!.disabledAt = new Date();
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('disabled');
    });

    it.each([['0'], ['0:1760000000'], ['t:abc'], ['t:'], ['t:-1'], ['t:1.5']])(
      '舊格式或壞掉的快取值 %s → 當成 miss 回 DB（不會當成「沒停用」放行）',
      async (raw) => {
        redis.store.set(key, raw);
        bind();
        await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('stale');
        expect(prisma.user.findUnique).toHaveBeenCalled();
      },
    );

    it('DB 讀不到版本（不該發生）→ 當成停用', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ disabledAt: null, deletedAt: null } as any);
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('disabled');
    });

    it('refresh 覆寫快取：舊版本的快取立刻被換掉', async () => {
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('ok'); // 快取 t:0
      bind(); // SSO 綁定
      await expect(svc.refresh('u-1')).resolves.toBe(true);
      expect(redis.set).toHaveBeenLastCalledWith(key, 't:1', USER_STATUS_CACHE_TTL_SECONDS);
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('stale');
      await expect(svc.checkAccessToken('u-1', 1)).resolves.toBe('ok');
    });

    it('refresh 之後才到的舊 NX 寫入（綁定前讀的 DB）蓋不掉新版本', async () => {
      let release!: () => void;
      let entered!: () => void;
      const inRead = new Promise<void>((r) => (entered = r));
      prisma.user.findUnique.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ disabledAt: null, deletedAt: null, tokenVersion: 0 });
            entered();
          }) as any,
      );
      const pending = svc.checkAccessToken('u-1', 0); // 請求 R：綁定前讀 DB
      await inRead;
      bind();
      await svc.refresh('u-1');
      release();
      await expect(pending).resolves.toBe('ok'); // R 本身已在途
      expect(redis.store.get(key)).toBe('t:1');
      await expect(svc.checkAccessToken('u-1', 0)).resolves.toBe('stale');
    });

    it('refresh 時 Redis 出錯 → 回 false，不拋錯', async () => {
      redis.mode = 'throw';
      await expect(svc.refresh('u-1')).resolves.toBe(false);
    });
  });

  it('invalidate 時 Redis 出錯 → 回 false，不拋錯', async () => {
    redis.mode = 'throw';
    await expect(svc.invalidate('u-1')).resolves.toBe(false);
  });
});
