import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { MessagesGateway } from '../messages/messages.gateway';
import { WhiteboardGateway } from '../whiteboard/whiteboard.gateway';
import { UserStatusService } from './user-status.service';
import { SocketRegistry } from './socket-registry';
import { RefreshTokenService } from './refresh-token.service';
import { Clock } from '../common/clock';

/**
 * DI 接線冒煙測試：整個 AppModule 能初始化（各 module controller 上的 JwtAuthGuard
 * 都解析得到 UserStatusService、兩個 gateway 解析得到 WsAuthService）。
 * Prisma／Redis 換成假的，不連任何外部服務。
 */
describe('AppModule wiring（H0 auth providers）', () => {
  const env = { ...process.env };

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.AI_ENABLED = 'false';
  });

  afterAll(() => {
    process.env = env;
  });

  it('app.init() 成功，H0 的 provider 是全域單例', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ $connect: async () => undefined, $disconnect: async () => undefined })
      .overrideProvider(RedisService)
      .useValue({
        get: async () => null,
        set: async () => undefined,
        del: async () => undefined,
        publish: async () => undefined,
        subscribe: async () => undefined,
        getClient: () => ({}),
      })
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    try {
      expect(moduleRef.get(MessagesGateway)).toBeDefined();
      expect(moduleRef.get(WhiteboardGateway)).toBeDefined();
      for (const token of [UserStatusService, SocketRegistry, RefreshTokenService, Clock]) {
        expect(moduleRef.get(token as any, { strict: false })).toBeDefined();
      }
    } finally {
      await app.close();
    }
  });
});
