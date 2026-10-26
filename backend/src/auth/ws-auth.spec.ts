import { JwtService } from '@nestjs/jwt';
import { WsAuthService, WS_AUTH_EXPIRED_EVENT, WS_UNAUTHORIZED_CODE } from './ws-auth';
import { SocketRegistry } from './socket-registry';
import { UserStatusService } from './user-status.service';
import { FakeClock } from '../common/clock';
import { FakePrisma, FakeRedis } from './testing/auth-fakes';
import { MessagesGateway } from '../messages/messages.gateway';
import { WhiteboardGateway } from '../whiteboard/whiteboard.gateway';

const NOW = Date.parse('2026-10-26T00:00:00Z');
const nowSec = Math.floor(NOW / 1000);

type Mw = (socket: any, next: (err?: any) => void) => void;

class FakeSocket {
  static seq = 0;
  id = `s-${++FakeSocket.seq}`;
  data: Record<string, any> = {};
  rooms = new Set<string>();
  emitted: Array<[string, unknown]> = [];
  disconnected = false;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(public handshake: { auth?: Record<string, unknown> }) {}

  emit(event: string, payload?: unknown) {
    this.emitted.push([event, payload]);
    return true;
  }
  on(event: string, fn: () => void) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  disconnect = jest.fn((_close?: boolean) => {
    if (this.disconnected) return this;
    this.disconnected = true;
    (this.listeners.disconnect ?? []).forEach((fn) => fn());
    return this;
  });
  leave() {}
}

/** 讓 middleware 跑完，回傳交給 next 的錯誤（undefined = 通過）。 */
const runMiddleware = (mw: Mw, socket: FakeSocket) =>
  new Promise<any>((resolve) => mw(socket, (err?: any) => resolve(err)));

const gateways: Array<{
  name: string;
  build: (ws: WsAuthService) => { afterInit(server: any): void; handleConnection(c: any): Promise<void> };
}> = [
  { name: 'messages', build: (ws) => new MessagesGateway({} as any, ws) },
  { name: 'whiteboard', build: (ws) => new WhiteboardGateway({} as any, ws, {} as any) },
];

describe.each(gateways)('$name gateway：握手驗身分（H0）', ({ build }) => {
  let clock: FakeClock;
  let prisma: FakePrisma;
  let jwt: JwtService;
  let registry: SocketRegistry;
  let ws: WsAuthService;
  let gateway: ReturnType<(typeof gateways)[number]['build']>;
  let mw: Mw;

  const access = (overrides: Record<string, unknown> = {}) =>
    jwt.sign({ sub: 'u-1', email: 'alice@example.com', typ: 'access', iat: nowSec, exp: nowSec + 900, ...overrides });

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    clock = new FakeClock(NOW);
    prisma = new FakePrisma(clock);
    prisma.addUser({ id: 'u-1', email: 'alice@example.com' });
    prisma.addUser({ id: 'u-2', email: 'bob@example.com' });
    jwt = new JwtService({ secret: 'test-secret' });
    registry = new SocketRegistry();
    ws = new WsAuthService(jwt, new UserStatusService(prisma as any, new FakeRedis() as any), clock, registry);
    gateway = build(ws);
    const server = { use: jest.fn((fn: Mw) => (mw = fn)) };
    gateway.afterInit(server);
    expect(server.use).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const expectRejected = (err: any, socket: FakeSocket) => {
    expect(err).toBeInstanceOf(Error);
    expect(err.data).toEqual({ code: WS_UNAUTHORIZED_CODE });
    expect(socket.data.userId).toBeUndefined();
    expect(registry.count('u-1')).toBe(0);
  };

  it('不帶 token → 拒絕', async () => {
    const s = new FakeSocket({ auth: {} });
    expectRejected(await runMiddleware(mw, s), s);
    const s2 = new FakeSocket({});
    expectRejected(await runMiddleware(mw, s2), s2);
  });

  it('只帶假的 userId → 拒絕（不再讀 handshake.auth.userId）', async () => {
    const s = new FakeSocket({ auth: { userId: 'u-1' } });
    expectRejected(await runMiddleware(mw, s), s);
  });

  it('帶過期 token → 拒絕', async () => {
    const s = new FakeSocket({ auth: { token: access({ iat: nowSec - 1000, exp: nowSec - 1 }) } });
    expectRejected(await runMiddleware(mw, s), s);
  });

  it('帶 refresh token（不透明字串）→ 拒絕', async () => {
    const s = new FakeSocket({ auth: { token: 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5' } });
    expectRejected(await runMiddleware(mw, s), s);
  });

  it('帶舊格式（沒有 typ）或 typ=refresh 的 JWT → 拒絕', async () => {
    const legacy = jwt.sign({ sub: 'u-1', email: 'alice@example.com', exp: nowSec + 900 });
    const s1 = new FakeSocket({ auth: { token: legacy } });
    expectRejected(await runMiddleware(mw, s1), s1);
    const s2 = new FakeSocket({ auth: { token: access({ typ: 'refresh' }) } });
    expectRejected(await runMiddleware(mw, s2), s2);
  });

  it('簽章錯誤 → 拒絕', async () => {
    const forged = new JwtService({ secret: 'other' }).sign({ sub: 'u-1', typ: 'access', exp: nowSec + 900 });
    const s = new FakeSocket({ auth: { token: forged } });
    expectRejected(await runMiddleware(mw, s), s);
  });

  it('使用者已停用 → 拒絕', async () => {
    prisma.users.get('u-1')!.disabledAt = new Date(NOW);
    const s = new FakeSocket({ auth: { token: access() } });
    expectRejected(await runMiddleware(mw, s), s);
  });

  it('有效 access token → 通過；userId 取自 token，不理會 handshake 的 userId', async () => {
    const s = new FakeSocket({ auth: { token: `Bearer ${access()}`, userId: 'u-2' } });
    expect(await runMiddleware(mw, s)).toBeUndefined();
    expect(s.data.userId).toBe('u-1');
    expect(s.data.tokenExp).toBe(nowSec + 900);
    await gateway.handleConnection(s);
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(registry.count('u-1')).toBe(1);
  });

  it('handleConnection 遇到沒通過驗證的 socket → 斷線（防禦）', async () => {
    const s = new FakeSocket({ auth: { userId: 'u-1' } });
    await gateway.handleConnection(s);
    expect(s.disconnect).toHaveBeenCalled();
  });

  it('access token 到期時後端主動斷線（假時鐘）', async () => {
    const s = new FakeSocket({ auth: { token: access({ exp: nowSec + 60 }) } });
    expect(await runMiddleware(mw, s)).toBeUndefined();

    jest.advanceTimersByTime(59_000);
    expect(s.disconnect).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_000);
    expect(s.emitted).toContainEqual([WS_AUTH_EXPIRED_EVENT, { code: 'token_expired' }]);
    expect(s.disconnect).toHaveBeenCalledWith(true);
    expect(registry.count('u-1')).toBe(0);
  });

  it('客戶端先斷線 → 計時器取消，不會再斷一次', async () => {
    const s = new FakeSocket({ auth: { token: access({ exp: nowSec + 60 }) } });
    await runMiddleware(mw, s);
    s.disconnect();
    expect(registry.count('u-1')).toBe(0);
    jest.advanceTimersByTime(120_000);
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(s.emitted).toEqual([]);
  });

  it('SocketRegistry.disconnectUser 斷開該使用者全部連線，其他人不受影響', async () => {
    const a1 = new FakeSocket({ auth: { token: access() } });
    const a2 = new FakeSocket({ auth: { token: access() } });
    const b = new FakeSocket({ auth: { token: access({ sub: 'u-2', email: 'bob@example.com' }) } });
    for (const s of [a1, a2, b]) expect(await runMiddleware(mw, s)).toBeUndefined();

    expect(registry.disconnectUser('u-1')).toBe(2);
    expect(a1.disconnect).toHaveBeenCalledWith(true);
    expect(a2.disconnect).toHaveBeenCalledWith(true);
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(registry.count('u-2')).toBe(1);
  });
});

describe('原始碼不再讀 handshake.auth.userId', () => {
  it.each(['../messages/messages.gateway.ts', '../whiteboard/whiteboard.gateway.ts', './ws-auth.ts'])(
    '%s',
    (rel) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const src: string = require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8');
      expect(src).not.toMatch(/auth\??\.userId/);
    },
  );
});
