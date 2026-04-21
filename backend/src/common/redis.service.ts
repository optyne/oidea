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

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
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
