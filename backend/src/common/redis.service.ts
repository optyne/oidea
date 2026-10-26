import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(private configService: ConfigService) {
    this.client = new Redis(this.buildOptions({ maxRetriesPerRequest: null }));
  }

  /** 集中建立 ioredis options，讓主 client 和 subscribe 新建的 client 用同一套連線參數。 */
  private buildOptions(extra: RedisOptions = {}): RedisOptions {
    const password = this.configService.get<string>('REDIS_PASSWORD', '');
    const username = this.configService.get<string>('REDIS_USERNAME', '');
    return {
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      username: username || undefined,
      password: password || undefined,
      ...extra,
    };
  }

  getClient(): Redis {
    return this.client;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  /** `SET key value EX ttl NX`：key 不存在才寫入。回傳是否寫入。 */
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * 原子地取出並刪除（Redis ≥ 6.2 `GETDEL`）。用在只能使用一次的值（OIDC ticket 等）：
   * 兩個併發呼叫只有一個拿得到值。錯誤照樣往上拋，由呼叫端決定要不要 fail closed。
   */
  async getdel(key: string): Promise<string | null> {
    return this.client.getdel(key);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const subscriber = new Redis(this.buildOptions());
    await subscriber.subscribe(channel);
    subscriber.on('message', (_, message) => callback(message));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
