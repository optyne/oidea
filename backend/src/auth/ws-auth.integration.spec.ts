import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { WsAuthService } from './ws-auth';
import { SocketRegistry } from './socket-registry';
import { UserStatusService } from './user-status.service';
import { Clock, SystemClock } from '../common/clock';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { FakePrisma, FakeRedis } from './testing/auth-fakes';
import { MessagesGateway } from '../messages/messages.gateway';
import { MessagesService } from '../messages/messages.service';
import { WhiteboardGateway } from '../whiteboard/whiteboard.gateway';
import { WhiteboardService } from '../whiteboard/whiteboard.service';

/**
 * 真的 Nest app ＋ 真的 socket.io server；客戶端用 Node 22 內建 WebSocket 直接講 socket.io v5 協定
 * （不需要額外安裝 socket.io-client）。證明兩個 gateway 的 middleware 真的掛在對的 namespace 上。
 *
 * 協定：engine.io 開啟後伺服器送 `0{...}`；客戶端送 `40<nsp>,{auth}`；
 * 成功回 `40<nsp>,{"sid":...}`，middleware 拒絕回 `44<nsp>,{"message":...,"data":...}`。
 */
describe('socket.io 握手（真的 server）', () => {
  let app: INestApplication;
  let port: number;
  let jwt: JwtService;

  beforeAll(async () => {
    const prisma = new FakePrisma(new SystemClock() as any);
    prisma.addUser({ id: 'u-1', email: 'alice@example.com' });
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret', signOptions: { expiresIn: '15m' } })],
      providers: [
        MessagesGateway,
        WhiteboardGateway,
        WsAuthService,
        SocketRegistry,
        UserStatusService,
        { provide: Clock, useClass: SystemClock },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: new FakeRedis() },
        { provide: MessagesService, useValue: {} },
        { provide: WhiteboardService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = app.getHttpServer().address().port;
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 連上 namespace，回傳伺服器對 CONNECT 的第一個回應封包。 */
  const handshake = (nsp: string, auth: Record<string, unknown>) =>
    new Promise<string>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
      const prefix = nsp === '/' ? '' : `${nsp},`;
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
      sock.onmessage = (ev) => {
        const msg = String(ev.data);
        if (msg.startsWith('0{')) {
          sock.send(`40${prefix}${JSON.stringify(auth)}`);
        } else if (msg.startsWith('40') || msg.startsWith('44')) {
          clearTimeout(timer);
          sock.close();
          resolve(msg);
        }
      };
      sock.onerror = () => reject(new Error('ws error'));
    });

  const access = () => jwt.sign({ sub: 'u-1', email: 'alice@example.com', typ: 'access' });

  describe.each([
    ['messages', '/'],
    ['whiteboard', '/whiteboard'],
  ])('%s（namespace %s）', (_name, nsp) => {
    const prefix = nsp === '/' ? '' : `${nsp},`;

    it('有效 access token → CONNECT 成功', async () => {
      const res = await handshake(nsp, { token: access() });
      expect(res.startsWith(`40${prefix}{"sid"`)).toBe(true);
    });

    it.each([
      ['不帶 token', {}],
      ['只帶假的 userId', { userId: 'u-1' }],
      ['refresh token（不透明字串）', { token: 'b3BhcXVlLXJlZnJlc2gtdG9rZW4tdmFsdWUtMTIzNDU2Nzg5MA' }],
    ])('%s → CONNECT_ERROR unauthorized', async (_label, auth) => {
      const res = await handshake(nsp, auth);
      expect(res.startsWith(`44${prefix}`)).toBe(true);
      expect(JSON.parse(res.slice(2 + prefix.length))).toMatchObject({ data: { code: 'unauthorized' } });
    });

    it('過期 token → CONNECT_ERROR', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = new JwtService({ secret: 'test-secret' }).sign({ sub: 'u-1', email: 'a', typ: 'access', iat: now - 100, exp: now - 10 });
      const res = await handshake(nsp, { token: expired });
      expect(res.startsWith(`44${prefix}`)).toBe(true);
    });
  });
});
