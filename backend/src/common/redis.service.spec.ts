import { RedisService } from './redis.service';

const client = {
  getdel: jest.fn(),
  set: jest.fn(),
  quit: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => client),
}));

describe('RedisService.setNx', () => {
  const config = { get: (_k: string, d?: unknown) => d } as any;

  it('送 SET key value EX ttl NX；OK → true，null（key 已存在）→ false', async () => {
    const svc = new RedisService(config);
    client.set.mockResolvedValueOnce('OK');
    await expect(svc.setNx('k', 'v', 30)).resolves.toBe(true);
    expect(client.set).toHaveBeenLastCalledWith('k', 'v', 'EX', 30, 'NX');
    client.set.mockResolvedValueOnce(null);
    await expect(svc.setNx('k', 'v', 30)).resolves.toBe(false);
  });
});

describe('RedisService.getdel', () => {
  const config = { get: (_k: string, d?: unknown) => d } as any;

  beforeEach(() => {
    client.getdel.mockReset();
  });

  it('呼叫 Redis GETDEL 並回傳值', async () => {
    client.getdel.mockResolvedValue('payload');
    const svc = new RedisService(config);
    await expect(svc.getdel('ticket:abc')).resolves.toBe('payload');
    expect(client.getdel).toHaveBeenCalledWith('ticket:abc');
  });

  it('key 不存在 → null', async () => {
    client.getdel.mockResolvedValue(null);
    const svc = new RedisService(config);
    await expect(svc.getdel('ticket:none')).resolves.toBeNull();
  });

  it('Redis 錯誤 → 往上拋（呼叫端 fail closed）', async () => {
    client.getdel.mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new RedisService(config);
    await expect(svc.getdel('ticket:x')).rejects.toThrow('ECONNREFUSED');
  });
});
