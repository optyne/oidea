import { MessagesGateway } from './messages.gateway';
import { MessagesService } from './messages.service';
import { FakeWsClient } from '../common/testing/fake-ws-client';
import { WS_ERROR_EVENT } from '../common/ws-response';

/**
 * messages gateway 的房間存取控制：用真的 MessagesService.assertChannelAccess，Prisma 用 mock。
 * 成員關係：u-member 是 ch-1 與 ws-1 的成員；u-outsider 都不是；
 * u-left 還有 ch-1 的 channelMember 列，但已被移出 ws-1。
 */
describe('MessagesGateway — 頻道存取控制', () => {
  let prisma: any;
  let service: MessagesService;
  let gateway: MessagesGateway;

  beforeEach(() => {
    const channelMembers = new Set(['ch-1:u-member', 'ch-1:u-left']);
    const workspaceMembers = new Set(['ws-1:u-member', 'ws-1:u-outsider-other']);
    prisma = {
      channel: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'ch-1'
            ? { workspaceId: 'ws-1', deletedAt: null }
            : where.id === 'ch-deleted'
              ? { workspaceId: 'ws-1', deletedAt: new Date() }
              : null,
        ),
      },
      channelMember: {
        findUnique: jest.fn(async ({ where }: any) => {
          const { channelId, userId } = where.channelId_userId;
          return channelMembers.has(`${channelId}:${userId}`) ? { id: 'cm' } : null;
        }),
      },
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) => {
          const { workspaceId, userId } = where.workspaceId_userId;
          return workspaceMembers.has(`${workspaceId}:${userId}`) ? { id: 'wm' } : null;
        }),
      },
      message: {
        create: jest.fn(async ({ data }: any) => ({
          id: 'msg-1',
          ...data,
          sender: { id: data.senderId, displayName: 'Member' },
        })),
      },
    };
    const gatewayRef = { emitNewMessage: jest.fn() };
    service = new MessagesService(prisma, gatewayRef as any, { create: jest.fn() } as any, null);
    gateway = new MessagesGateway(service, {} as any);
  });

  describe('joinChannel', () => {
    it('成員 → 加入房間，ack ok', async () => {
      const c = new FakeWsClient('u-member');
      await expect(gateway.handleJoinChannel(c as any, 'ch-1')).resolves.toEqual({ ok: true });
      expect(c.rooms.has('channel:ch-1')).toBe(true);
      expect(c.broadcasts).toContainEqual({
        room: 'channel:ch-1',
        event: 'userJoined',
        payload: { userId: 'u-member' },
      });
    });

    it.each([
      ['非頻道成員', 'u-outsider', 'ch-1', 'forbidden'],
      ['頻道成員但已被移出工作空間', 'u-left', 'ch-1', 'forbidden'],
      ['頻道不存在', 'u-member', 'ch-nope', 'not_found'],
      ['頻道已刪除', 'u-member', 'ch-deleted', 'not_found'],
    ])('%s → 拒絕，不加入房間，回錯誤 ack 並 emit ws_error', async (_l, userId, channelId, code) => {
      const c = new FakeWsClient(userId);
      const ack = await gateway.handleJoinChannel(c as any, channelId);
      expect(ack).toMatchObject({ ok: false, error: { code } });
      expect(c.rooms.has(`channel:${channelId}`)).toBe(false);
      expect(c.broadcasts).toEqual([]);
      expect(c.emitted).toContainEqual([WS_ERROR_EVENT, expect.objectContaining({ event: 'joinChannel', code })]);
    });

    it('channelId 不是字串 → bad_request', async () => {
      const c = new FakeWsClient('u-member');
      const ack = await gateway.handleJoinChannel(c as any, { evil: true } as any);
      expect(ack).toMatchObject({ ok: false, error: { code: 'bad_request' } });
      expect(prisma.channel.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('成員 → 建立訊息，ack 帶 message', async () => {
      const c = new FakeWsClient('u-member');
      const ack: any = await gateway.handleMessage(c as any, { channelId: 'ch-1', content: 'hi' });
      expect(ack.ok).toBe(true);
      expect(ack.message).toMatchObject({ channelId: 'ch-1', senderId: 'u-member', content: 'hi' });
    });

    it.each([
      ['非成員', 'u-outsider'],
      ['已被移出工作空間', 'u-left'],
    ])('%s → 拒絕，不建立訊息', async (_l, userId) => {
      const c = new FakeWsClient(userId);
      const ack = await gateway.handleMessage(c as any, { channelId: 'ch-1', content: 'hi' });
      expect(ack).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('typing / stopTyping', () => {
    it('已加入房間 → 轉發', async () => {
      const c = new FakeWsClient('u-member');
      await gateway.handleJoinChannel(c as any, 'ch-1');
      await expect(gateway.handleTyping(c as any, { channelId: 'ch-1' })).resolves.toEqual({ ok: true });
      await expect(gateway.handleStopTyping(c as any, { channelId: 'ch-1' })).resolves.toEqual({ ok: true });
      expect(c.broadcasts.map((b) => b.event)).toEqual(['userJoined', 'userTyping', 'userStopTyping']);
    });

    it('沒加入房間（例如非成員）→ 拒絕，不轉發', async () => {
      const c = new FakeWsClient('u-outsider');
      await gateway.handleJoinChannel(c as any, 'ch-1');
      const ack = await gateway.handleTyping(c as any, { channelId: 'ch-1' });
      expect(ack).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      const ack2 = await gateway.handleStopTyping(c as any, { channelId: 'ch-1' });
      expect(ack2).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(c.broadcasts).toEqual([]);
    });
  });
});
