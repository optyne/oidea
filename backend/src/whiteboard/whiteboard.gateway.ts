import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { WhiteboardService } from './whiteboard.service';
import { WsAuthService } from '../auth/ws-auth';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:5000'],
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

  @SubscribeMessage('joinBoard')
  async handleJoinBoard(client: Socket, boardId: string) {
    client.join(`board:${boardId}`);

    const state = await this.whiteboardService.getState(boardId);
    client.emit('boardState', state);

    client.to(`board:${boardId}`).emit('userJoined', { userId: client.data.userId });
  }

  @SubscribeMessage('leaveBoard')
  async handleLeaveBoard(client: Socket, boardId: string) {
    client.leave(`board:${boardId}`);
  }

  @SubscribeMessage('boardUpdate')
  async handleBoardUpdate(client: Socket, payload: { boardId: string; update: Uint8Array }) {
    client.to(`board:${payload.boardId}`).emit('remoteUpdate', payload.update);

    await this.whiteboardService.saveState(payload.boardId, payload.update);
  }
}
