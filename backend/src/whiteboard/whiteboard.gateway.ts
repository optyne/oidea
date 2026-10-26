import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { ForbiddenException } from '@nestjs/common';
import { Namespace, Socket } from 'socket.io';
import { WhiteboardService } from './whiteboard.service';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { WsAuthService } from '../auth/ws-auth';
import { corsOriginFromEnv } from '../common/cors-origin';
import { WsAck, isNonEmptyId, wsDeny } from '../common/ws-response';

const roomOf = (boardId: string) => `board:${boardId}`;

@WebSocketGateway({
  cors: {
    // 與 main.ts 同一套：CORS_ORIGIN 白名單，沒設則允許任何來源
    origin: corsOriginFromEnv,
    credentials: true,
  },
  namespace: '/whiteboard',
})
export class WhiteboardGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  /** 有 namespace 的 gateway，注入的是 Namespace（`.use()` 只作用在 /whiteboard）。 */
  @WebSocketServer()
  server: Namespace;

  constructor(
    private whiteboardService: WhiteboardService,
    private readonly wsAuth: WsAuthService,
    private readonly pages: WhiteboardPagesService,
  ) {}

  /** 握手時以 `handshake.auth.token`（access token）驗身分；失敗的連線不會進到 handleConnection。 */
  afterInit(server: Namespace) {
    this.wsAuth.attach(server, 'whiteboard');
  }

  async handleConnection(client: Socket) {
    // 防禦：理論上沒通過 middleware 的連線到不了這裡
    if (!client.data?.userId) {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const rooms = client.rooms;
    rooms.forEach((room) => client.leave(room));
  }

  /**
   * 加入白板房間：白板存在且呼叫者是該工作空間成員（與 HTTP 同一個 assertAccess）。
   * 被拒時不加入房間、不送 boardState，回錯誤 ack 並 emit `ws_error`。
   */
  @SubscribeMessage('joinBoard')
  async handleJoinBoard(client: Socket, boardId: string): Promise<WsAck> {
    if (!isNonEmptyId(boardId)) return wsDeny(client, 'joinBoard', 'bad_request');
    try {
      await this.pages.assertAccess(client.data.userId, boardId);
      const state = await this.whiteboardService.getState(boardId);
      client.join(roomOf(boardId));
      client.emit('boardState', state);
    } catch (err) {
      return wsDeny(client, 'joinBoard', err);
    }
    client.to(roomOf(boardId)).emit('userJoined', { userId: client.data.userId });
    return { ok: true };
  }

  @SubscribeMessage('leaveBoard')
  async handleLeaveBoard(client: Socket, boardId: string) {
    if (isNonEmptyId(boardId)) client.leave(roomOf(boardId));
  }

  /** 寫入操作：要先 joinBoard 過，而且每次都重新檢查存取權（被移出工作空間就停止生效）。 */
  @SubscribeMessage('boardUpdate')
  async handleBoardUpdate(
    client: Socket,
    payload: { boardId: string; update: Uint8Array },
  ): Promise<WsAck> {
    const boardId = payload?.boardId;
    if (!isNonEmptyId(boardId) || payload.update == null) {
      return wsDeny(client, 'boardUpdate', 'bad_request');
    }
    if (!client.rooms.has(roomOf(boardId))) {
      return wsDeny(client, 'boardUpdate', new ForbiddenException('尚未加入此白板'));
    }
    try {
      await this.pages.assertAccess(client.data.userId, boardId);
      client.to(roomOf(boardId)).emit('remoteUpdate', payload.update);
      await this.whiteboardService.saveState(boardId, payload.update);
    } catch (err) {
      return wsDeny(client, 'boardUpdate', err);
    }
    return { ok: true };
  }
}
