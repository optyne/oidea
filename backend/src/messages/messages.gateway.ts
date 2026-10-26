import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { MessagesService } from './messages.service';
import { WsAuthService } from '../auth/ws-auth';
import { corsOriginFromEnv } from '../common/cors-origin';
import { WsAck, isNonEmptyId, wsDeny } from '../common/ws-response';

const roomOf = (channelId: string) => `channel:${channelId}`;

@WebSocketGateway({
  cors: {
    // 與 main.ts 同一套：CORS_ORIGIN 白名單，沒設則允許任何來源
    origin: corsOriginFromEnv,
    credentials: true,
  },
})
export class MessagesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(forwardRef(() => MessagesService))
    private readonly messagesService: MessagesService,
    private readonly wsAuth: WsAuthService,
  ) {}

  /** 握手時以 `handshake.auth.token`（access token）驗身分；失敗的連線不會進到 handleConnection。 */
  afterInit(server: Server) {
    this.wsAuth.attach(server, 'messages');
  }

  /** 連線真的建立後才登記到 SocketRegistry、排到期斷線；沒通過 middleware 的 socket 斷線（防禦）。 */
  async handleConnection(client: Socket) {
    this.wsAuth.onConnected(client);
  }

  handleDisconnect(client: Socket) {
    // Leave all rooms
    const rooms = client.rooms;
    rooms.forEach((room) => client.leave(room));
  }

  /**
   * 加入頻道房間：必須是頻道成員且仍是該工作空間成員（MessagesService.assertChannelAccess）。
   * 被拒時不加入房間，回錯誤 ack 並 emit `ws_error`。
   */
  @SubscribeMessage('joinChannel')
  async handleJoinChannel(client: Socket, channelId: string): Promise<WsAck> {
    if (!isNonEmptyId(channelId)) return wsDeny(client, 'joinChannel', 'bad_request');
    try {
      await this.messagesService.assertChannelAccess(client.data.userId, channelId);
    } catch (err) {
      return wsDeny(client, 'joinChannel', err);
    }
    client.join(roomOf(channelId));
    client.to(roomOf(channelId)).emit('userJoined', { userId: client.data.userId });
    return { ok: true };
  }

  @SubscribeMessage('leaveChannel')
  async handleLeaveChannel(client: Socket, channelId: string) {
    if (isNonEmptyId(channelId)) client.leave(roomOf(channelId));
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    client: Socket,
    payload: { channelId: string; content: string; type?: string; parentId?: string },
  ): Promise<WsAck<{ message: unknown }>> {
    if (!payload || !isNonEmptyId(payload.channelId) || typeof payload.content !== 'string') {
      return wsDeny(client, 'sendMessage', 'bad_request');
    }
    try {
      await this.messagesService.assertChannelAccess(client.data.userId, payload.channelId);
      const message = await this.messagesService.create(client.data.userId, {
        channelId: payload.channelId,
        content: payload.content,
        type: payload.type || 'text',
        parentId: payload.parentId,
      });
      return { ok: true, message };
    } catch (err) {
      return wsDeny(client, 'sendMessage', err);
    }
  }

  /** REST 與 WS 建立訊息後，由 MessagesService 呼叫以同步所有在房間內的客戶端 */
  emitNewMessage(channelId: string, message: unknown) {
    this.server.to(roomOf(channelId)).emit('newMessage', message);
  }

  /** typing 只轉發到已通過 joinChannel 檢查的房間；沒加入房間就拒絕。 */
  @SubscribeMessage('typing')
  async handleTyping(client: Socket, payload: { channelId: string }) {
    return this.relayTyping(client, 'typing', 'userTyping', payload);
  }

  @SubscribeMessage('stopTyping')
  async handleStopTyping(client: Socket, payload: { channelId: string }) {
    return this.relayTyping(client, 'stopTyping', 'userStopTyping', payload);
  }

  private relayTyping(
    client: Socket,
    event: string,
    outEvent: string,
    payload: { channelId: string },
  ): WsAck {
    const channelId = payload?.channelId;
    if (!isNonEmptyId(channelId)) return wsDeny(client, event, 'bad_request');
    if (!client.rooms.has(roomOf(channelId))) {
      return wsDeny(client, event, new ForbiddenException('尚未加入此頻道'));
    }
    client.to(roomOf(channelId)).emit(outEvent, { userId: client.data.userId, channelId });
    return { ok: true };
  }
}
