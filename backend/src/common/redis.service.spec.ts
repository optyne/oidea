import { RedisService } from './redis.service';

const client = {
  getdel: jest.fn(),
  quit: jest.fn(),
};

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => client),
}));

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
