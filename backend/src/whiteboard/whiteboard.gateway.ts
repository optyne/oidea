import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WhiteboardService } from './whiteboard.service';

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:5000'],
    credentials: true,
  },
  namespace: '/whiteboard',
})
export class WhiteboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private whiteboardService: WhiteboardService) {}

  async handleConnection(client: Socket) {
    const userId = client.handshake.auth?.userId;
    if (!userId) {
      client.disconnect();
      return;
    }
    client.data.userId = userId;
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
