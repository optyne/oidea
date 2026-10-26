import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Clock } from '../common/clock';
import { UserStatusService } from './user-status.service';
import { SocketRegistry } from './socket-registry';
import { AuthenticatedUser, isAccessPayload } from './token-types';

/** setTimeout 的上限（約 24.8 天）；更久的到期時間分段等待。 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** 握手失敗時給客戶端的錯誤（socket.io 的 connect_error：err.message / err.data）。 */
export const WS_UNAUTHORIZED_CODE = 'unauthorized';
/** token 到期、後端主動斷線前送出的事件名稱。 */
export const WS_AUTH_EXPIRED_EVENT = 'auth_expired';

export class WsAuthError extends Error {
  readonly data = { code: WS_UNAUTHORIZED_CODE };
  constructor(readonly reason: string) {
    super('身分驗證失敗');
  }
}

/** middleware 需要的最小 socket 介面（socket.io 的 Socket 符合）。 */
export interface AuthSocket {
  id: string;
  handshake: { auth?: Record<string, unknown> };
  data: Record<string, any>;
  /** socket.io 的 `socket.connected`；握手完成後才是 true，斷線後變 false。 */
  connected?: boolean;
  emit(event: string, ...args: unknown[]): unknown;
  disconnect(close?: boolean): unknown;
  on(event: 'disconnect', listener: (...args: unknown[]) => void): unknown;
}

type Next = (err?: Error) => void;

/** socket.io Server 與 Namespace 都有 `use()`。 */
export interface MiddlewareHost {
  use(fn: (socket: any, next: Next) => void): unknown;
}

export interface VerifiedAccessToken extends AuthenticatedUser {
  /** token 的 exp（unix 秒） */
  exp: number;
}

/**
 * WebSocket 身分驗證（spec §4.3「Socket」），messages 與 whiteboard 兩個 gateway 共用。
 *
 * - 只讀 `handshake.auth.token`（access token，可帶或不帶 `Bearer ` 前綴）；
 *   客戶端自報的 userId 欄位一律不看，身分只來自驗證過的 token。
 * - 驗簽、驗 exp（用注入的時鐘）、只接受 `typ: "access"`、檢查使用者是否停用、`tv` 是否等於現在的 tokenVersion（review R1）。
 * - middleware 只驗 token，成功後 `socket.data.userId` / `socket.data.email` / `socket.data.tokenExp` 有值。
 * - 登記到 SocketRegistry（H2 離職時斷線用）與排到期計時器，要等 gateway 的 handleConnection
 *   呼叫 `onConnected()` 才做，因為 handleConnection 只在握手真的完成後才跑。若在 middleware 裡做，
 *   客戶端在非同步驗證途中斷線時，socket.io 只 `_cleanup()`、不 emit `disconnect`，
 *   registry 項目與計時器就永遠留著。
 * - token 到期時先 emit `auth_expired` 再斷線。伺服器主動斷線時 socket.io 客戶端**不會**自動重連，
 *   客戶端要先 refresh 拿新的 access token，再自行 `connect()`。
 */
@Injectable()
export class WsAuthService {
  private readonly logger = new Logger(WsAuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly userStatus: UserStatusService,
    private readonly clock: Clock,
    private readonly registry: SocketRegistry,
  ) {}

  /** 在 gateway 的 afterInit(server) 呼叫。 */
  attach(host: MiddlewareHost, gatewayName = 'ws'): void {
    host.use((socket: AuthSocket, next: Next) => {
      this.authenticateSocket(socket).then(
        () => next(),
        (err: unknown) => {
          const reason = err instanceof WsAuthError ? err.reason : 'error';
          if (!(err instanceof WsAuthError)) {
            this.logger.warn(`[${gatewayName}] socket auth error: ${(err as Error)?.message}`);
          }
          next(err instanceof WsAuthError ? err : new WsAuthError(reason));
        },
      );
    });
  }

  async verifyAccessToken(raw: unknown): Promise<VerifiedAccessToken> {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new WsAuthError('missing_token');
    }
    const token = raw.replace(/^Bearer\s+/i, '').trim();

    let payload: unknown;
    try {
      payload = this.jwt.verify(token, {
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
    } catch {
      throw new WsAuthError('invalid_token');
    }
    if (!isAccessPayload(payload) || typeof payload.exp !== 'number') {
      throw new WsAuthError('wrong_token_type');
    }
    const check = await this.userStatus.checkAccessToken(payload.sub, payload.tv);
    if (check === 'disabled') {
      throw new WsAuthError('user_disabled');
    }
    if (check === 'stale') {
      throw new WsAuthError('token_revoked');
    }
    return { userId: payload.sub, email: payload.email, exp: payload.exp };
  }

  /** middleware 用：只驗 token 並把結果放到 `socket.data`，不登記、不排計時器。 */
  async authenticateSocket(socket: AuthSocket): Promise<VerifiedAccessToken> {
    const verified = await this.verifyAccessToken(socket.handshake?.auth?.token);

    socket.data.userId = verified.userId;
    socket.data.email = verified.email;
    socket.data.tokenExp = verified.exp;
    return verified;
  }

  /**
   * gateway 的 handleConnection 呼叫：連線真的建立後才登記到 SocketRegistry 並排到期斷線。
   * 沒通過 middleware 的 socket（沒有 `data.userId`）直接斷線；已經斷掉的 socket 不登記。
   * 回傳是否已登記。
   */
  onConnected(socket: AuthSocket): boolean {
    const userId = socket.data?.userId;
    const exp = socket.data?.tokenExp;
    if (typeof userId !== 'string' || !userId || typeof exp !== 'number') {
      socket.disconnect(true);
      return false;
    }
    if (socket.connected === false) return false;
    if (socket.data.wsAuthRegistered) return true;
    socket.data.wsAuthRegistered = true;

    this.registry.add(userId, socket);
    const cancel = this.scheduleExpiry(socket, exp);
    socket.on('disconnect', () => {
      cancel();
      this.registry.remove(userId, socket);
    });
    return true;
  }

  /** token 到期時斷線；回傳取消函式。 */
  private scheduleExpiry(socket: AuthSocket, expSeconds: number): () => void {
    let timer: NodeJS.Timeout | undefined;
    const expire = () => {
      timer = undefined;
      socket.emit(WS_AUTH_EXPIRED_EVENT, { code: 'token_expired' });
      socket.disconnect(true);
    };
    const arm = (remaining: number) => {
      const delay = Math.max(0, Math.min(remaining, MAX_TIMER_MS));
      timer = setTimeout(() => (remaining > delay ? arm(remaining - delay) : expire()), delay);
      timer.unref?.();
    };
    arm(expSeconds * 1000 - this.clock.now().getTime());
    return () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
  }
}
