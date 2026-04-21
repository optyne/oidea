import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * 工作空間全域搜尋：跨訊息 / 任務 / 筆記頁 / 檔案 做模糊比對。
 *
 * 這一代用 Postgres 的 `contains + insensitive`（=`ILIKE %q%`），沒有全文索引。
 * 對 <100k 列的工作空間足夠快；超過規模後再補 `pg_trgm` 或 tsvector。
 *
 * Security: 所有查詢都強制 `workspaceId` 過濾，且呼叫端必須是該 workspace 的成員。
 */
@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  private async assertMember(userId: string, workspaceId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!m) throw new ForbiddenException('非此工作空間成員');
  }

  async search(
    userId: string,
    workspaceId: string,
    rawQuery: string,
    types: Set<string>,
    perTypeLimit = 5,
  ) {
    const q = rawQuery.trim();
    if (!q) return this.emptyResult(types);
    await this.assertMember(userId, workspaceId);

    const wantMessages = types.has('messages');
    const wantTasks = types.has('tasks');
    const wantPages = types.has('pages');
    const wantFiles = types.has('files');

    const [messages, tasks, pages, files] = await Promise.all([
      wantMessages ? this.searchMessages(workspaceId, q, perTypeLimit) : Promise.resolve([]),
      wantTasks ? this.searchTasks(workspaceId, q, perTypeLimit) : Promise.resolve([]),
      wantPages ? this.searchPages(workspaceId, q, perTypeLimit) : Promise.resolve([]),
      wantFiles ? this.searchFiles(workspaceId, q, perTypeLimit) : Promise.resolve([]),
    ]);

    return { query: q, messages, tasks, pages, files };
  }

  private emptyResult(types: Set<string>) {
    return {
      query: '',
      messages: types.has('messages') ? [] : [],
      tasks: types.has('tasks') ? [] : [],
      pages: types.has('pages') ? [] : [],
      files: types.has('files') ? [] : [],
    };
  }

  private async searchMessages(workspaceId: string, q: string, limit: number) {
    const rows = await this.prisma.message.findMany({
      where: {
        deletedAt: null,
        content: { contains: q, mode: 'insensitive' },
        channel: { workspaceId, deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        content: true,
        createdAt: true,
        channelId: true,
        senderId: true,
        channel: { select: { name: true } },
        sender: { select: { displayName: true, avatarUrl: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      channelId: r.channelId,
      channelName: r.channel.name,
      senderName: r.sender.displayName,
      senderAvatar: r.sender.avatarUrl,
      snippet: this.snippetAround(r.content ?? '', q),
      createdAt: r.createdAt,
    }));
  }

  private async searchTasks(workspaceId: string, q: string, limit: number) {
    const rows = await this.prisma.task.findMany({
      where: {
        deletedAt: null,
        project: { workspaceId, deletedAt: null },
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        description: true,
        priority: true,
        projectId: true,
        project: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      projectId: r.projectId,
      projectName: r.project.name,
      priority: r.priority,
      snippet: r.description ? this.snippetAround(r.description, q) : null,
    }));
  }

  private async searchPages(workspaceId: string, q: string, limit: number) {
    const rows = await this.prisma.knowledgePage.findMany({
      where: {
        workspaceId,
        archived: false,
        title: { contains: q, mode: 'insensitive' },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { id: true, title: true, icon: true, parentId: true, kind: true },
    });
    return rows;
  }

  private async searchFiles(workspaceId: string, q: string, limit: number) {
    const rows = await this.prisma.file.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        fileName: { contains: q, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        fileName: true,
        fileType: true,
        fileSize: true,
        url: true,
      },
    });
    return rows;
  }

  /**
   * 擷取命中關鍵字周圍 ~80 字給前端當 snippet，命中詞以 `«...»` 包起來
   * 讓前端可做 highlight 時一眼看到範圍。不做 regex escape 就不 regex；
   * 直接用字串 indexOf + splice。
   */
  private snippetAround(text: string, q: string, windowChars = 80): string {
    if (!text) return '';
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx < 0) return text.length > windowChars * 2 ? text.substring(0, windowChars * 2) + '…' : text;
    const start = Math.max(0, idx - windowChars);
    const end = Math.min(text.length, idx + q.length + windowChars);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    const before = text.substring(start, idx);
    const hit = text.substring(idx, idx + q.length);
    const after = text.substring(idx + q.length, end);
    return `${prefix}${before}«${hit}»${after}${suffix}`;
  }
}
