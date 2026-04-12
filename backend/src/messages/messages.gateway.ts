import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { MessagesService } from './messages.service';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
})
export class MessagesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(forwardRef(() => MessagesService))
    private readonly messagesService: MessagesService,
  ) {}

  async handleConnection(client: Socket) {
    const userId = client.handshake.auth?.userId;
    if (!userId) {
      client.disconnect();
      return;
    }
    client.data.userId = userId;
  }

  handleDisconnect(client: Socket) {
    // Leave all rooms
    const rooms = client.rooms;
    rooms.forEach((room) => client.leave(room));
  }

  @SubscribeMessage('joinChannel')
  async handleJoinChannel(client: Socket, channelId: string) {
    client.join(`channel:${channelId}`);
    client.to(`channel:${channelId}`).emit('userJoined', { userId: client.data.userId });
  }

  @SubscribeMessage('leaveChannel')
  async handleLeaveChannel(client: Socket, channelId: string) {
    client.leave(`channel:${channelId}`);
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(client: Socket, payload: { channelId: string; content: string; type?: string; parentId?: string }) {
    return this.messagesService.create(client.data.userId, {
      channelId: payload.channelId,
      content: payload.content,
      type: payload.type || 'text',
      parentId: payload.parentId,
    });
  }

  /** REST 與 WS 建立訊息後，由 MessagesService 呼叫以同步所有在房間內的客戶端 */
  emitNewMessage(channelId: string, message: unknown) {
    this.server.to(`channel:${channelId}`).emit('newMessage', message);
  }

  @SubscribeMessage('typing')
  async handleTyping(client: Socket, payload: { channelId: string }) {
    client.to(`channel:${payload.channelId}`).emit('userTyping', {
      userId: client.data.userId,
      channelId: payload.channelId,
    });
  }

  @SubscribeMessage('stopTyping')
  async handleStopTyping(client: Socket, payload: { channelId: string }) {
    client.to(`channel:${payload.channelId}`).emit('userStopTyping', {
      userId: client.data.userId,
      channelId: payload.channelId,
    });
  }
}
