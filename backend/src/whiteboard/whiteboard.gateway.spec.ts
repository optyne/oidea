import { WhiteboardGateway } from './whiteboard.gateway';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { FakeWsClient } from '../common/testing/fake-ws-client';
import { WS_ERROR_EVENT } from '../common/ws-response';

/**
 * whiteboard gateway 的房間存取控制：用真的 WhiteboardPagesService.assertAccess（HTTP 同一套），
 * Prisma 用 mock。u-member 是 ws-1 成員；u-outsider 不是。
 */
describe('WhiteboardGateway — 白板存取控制', () => {
  let prisma: any;
  let whiteboard: { getState: jest.Mock; saveState: jest.Mock };
  let gateway: WhiteboardGateway;

  beforeEach(() => {
    prisma = {
      whiteboard: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'wb-1' ? { id: 'wb-1', workspaceId: 'ws-1', deletedAt: null } : null,
        ),
      },
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.workspaceId_userId.userId === 'u-member' ? { id: 'wm' } : null,
        ),
      },
    };
    whiteboard = {
      getState: jest.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
      saveState: jest.fn().mockResolvedValue({}),
    };
    const pages = new WhiteboardPagesService(prisma, {} as any);
    gateway = new WhiteboardGateway(whiteboard as any, {} as any, pages);
  });

  describe('joinBoard', () => {
    it('工作空間成員 → 加入房間、收到 boardState、ack ok', async () => {
      const c = new FakeWsClient('u-member');
      await expect(gateway.handleJoinBoard(c as any, 'wb-1')).resolves.toEqual({ ok: true });
      expect(c.rooms.has('board:wb-1')).toBe(true);
      expect(c.emitted).toContainEqual(['boardState', Buffer.from([1, 2, 3])]);
      expect(c.broadcasts).toContainEqual({ room: 'board:wb-1', event: 'userJoined', payload: { userId: 'u-member' } });
    });

    it('非工作空間成員 → 拒絕，不加入房間、不送 boardState', async () => {
      const c = new FakeWsClient('u-outsider');
      const ack = await gateway.handleJoinBoard(c as any, 'wb-1');
      expect(ack).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(c.rooms.has('board:wb-1')).toBe(false);
      expect(whiteboard.getState).not.toHaveBeenCalled();
      expect(c.emitted).toEqual([[WS_ERROR_EVENT, expect.objectContaining({ event: 'joinBoard', code: 'forbidden' })]]);
      expect(c.broadcasts).toEqual([]);
    });

    it('白板不存在 → not_found', async () => {
      const c = new FakeWsClient('u-member');
      const ack = await gateway.handleJoinBoard(c as any, 'wb-nope');
      expect(ack).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(c.rooms.has('board:wb-nope')).toBe(false);
    });

    it('boardId 不是字串 → bad_request', async () => {
      const c = new FakeWsClient('u-member');
      const ack = await gateway.handleJoinBoard(c as any, 123 as any);
      expect(ack).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    });
  });

  describe('boardUpdate', () => {
    const update = new Uint8Array([9]);

    it('已加入的成員 → 轉發並存檔', async () => {
      const c = new FakeWsClient('u-member');
      await gateway.handleJoinBoard(c as any, 'wb-1');
      await expect(gateway.handleBoardUpdate(c as any, { boardId: 'wb-1', update })).resolves.toEqual({ ok: true });
      expect(c.broadcasts).toContainEqual({ room: 'board:wb-1', event: 'remoteUpdate', payload: update });
      expect(whiteboard.saveState).toHaveBeenCalledWith('wb-1', update);
    });

    it('沒加入房間（非成員）→ 拒絕，不轉發、不存檔', async () => {
      const c = new FakeWsClient('u-outsider');
      await gateway.handleJoinBoard(c as any, 'wb-1');
      const ack = await gateway.handleBoardUpdate(c as any, { boardId: 'wb-1', update });
      expect(ack).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(whiteboard.saveState).not.toHaveBeenCalled();
      expect(c.broadcasts).toEqual([]);
    });

    it('加入後被移出工作空間 → 下一次 update 被拒', async () => {
      const c = new FakeWsClient('u-member');
      await gateway.handleJoinBoard(c as any, 'wb-1');
      prisma.workspaceMember.findUnique.mockResolvedValue(null);
      const ack = await gateway.handleBoardUpdate(c as any, { boardId: 'wb-1', update });
      expect(ack).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(whiteboard.saveState).not.toHaveBeenCalled();
      expect(c.broadcasts.filter((b) => b.event === 'remoteUpdate')).toEqual([]);
    });
  });
});
