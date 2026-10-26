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
import { WhiteboardPagesService } from '../whiteboard/whiteboard-pages.service';

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
  let registry: SocketRegistry;
  let userStatus: UserStatusService;

  beforeAll(async () => {
    const prisma = new FakePrisma(new SystemClock() as any);
    prisma.addUser({ id: 'u-1', email: 'alice@example.com' });
    prisma.addUser({ id: 'u-live', email: 'live@example.com' });
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
        { provide: WhiteboardPagesService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = app.getHttpServer().address().port;
    jwt = moduleRef.get(JwtService);
    registry = moduleRef.get(SocketRegistry);
    userStatus = moduleRef.get(UserStatusService);
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

  // 兩個 gateway 共用同一個 engine.io server（/socket.io/），CORS 設定也已統一
  describe('CORS（與 main.ts 同一套 CORS_ORIGIN）', () => {
    const original = process.env.CORS_ORIGIN;
    afterEach(() => {
      if (original === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = original;
    });

    const preflight = (origin: string) =>
      fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'GET' },
      });

    it('白名單內的來源 → 回 Access-Control-Allow-Origin', async () => {
      process.env.CORS_ORIGIN = 'https://app.example.com';
      const res = await preflight('https://app.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    });

    it('白名單外的來源 → 沒有 Access-Control-Allow-Origin', async () => {
      process.env.CORS_ORIGIN = 'https://app.example.com';
      const res = await preflight('https://evil.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

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

    it('S2：握手完成的連線才登記到 registry，斷線後移除', async () => {
      const token = jwt.sign({ sub: 'u-live', email: 'live@example.com', typ: 'access' });
      const sock = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
      const connected = new Promise<string>((resolve) => {
        sock.onmessage = (ev) => {
          const msg = String(ev.data);
          if (msg.startsWith('0{')) sock.send(`40${prefix}${JSON.stringify({ token })}`);
          else if (msg.startsWith('40') || msg.startsWith('44')) resolve(msg);
        };
      });
      expect((await connected).startsWith(`40${prefix}{"sid"`)).toBe(true);
      await new Promise((r) => setTimeout(r, 50)); // handleConnection runs after CONNECT is sent
      expect(registry.count('u-live')).toBe(1);

      const closed = new Promise<void>((r) => (sock.onclose = () => r()));
      sock.close();
      await closed;
      await new Promise((r) => setTimeout(r, 100));
      expect(registry.count('u-live')).toBe(0);
    });

    it('S2：客戶端在非同步驗證途中斷線 → registry 不留項目', async () => {
      let release!: (disabled: boolean) => void;
      let entered!: () => void;
      const inCheck = new Promise<void>((r) => (entered = r));
      const spy = jest.spyOn(userStatus, 'isDisabled').mockImplementationOnce(
        () =>
          new Promise<boolean>((r) => {
            release = r;
            entered();
          }),
      );
      try {
        const token = jwt.sign({ sub: 'u-abort', email: 'abort@example.com', typ: 'access' });
        const sock = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
        const closed = new Promise<void>((r) => (sock.onclose = () => r()));
        sock.onmessage = (ev) => {
          if (String(ev.data).startsWith('0{')) sock.send(`40${prefix}${JSON.stringify({ token })}`);
        };
        await inCheck; // middleware is now awaiting the disabled check
        sock.close();
        await closed;
        await new Promise((r) => setTimeout(r, 100)); // let the server see the close
        release(false); // auth passes, but the connection is already gone
        await new Promise((r) => setTimeout(r, 100));
        expect(registry.count('u-abort')).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('過期 token → CONNECT_ERROR', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = new JwtService({ secret: 'test-secret' }).sign({ sub: 'u-1', email: 'a', typ: 'access', iat: now - 100, exp: now - 10 });
      const res = await handshake(nsp, { token: expired });
      expect(res.startsWith(`44${prefix}`)).toBe(true);
    });
  });
});
