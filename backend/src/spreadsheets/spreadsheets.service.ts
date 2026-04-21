import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * 試算表模組：
 * - 整張 sheet 的 cells 以 JSON 整份存在 `data` 欄位；server 不解析、不 rebuild。
 * - 僅工作空間成員能讀寫；per-sheet ACL 留給未來（可比照 KnowledgePage）。
 */
@Injectable()
export class SpreadsheetsService {
  constructor(private prisma: PrismaService) {}

  private async assertMember(userId: string, workspaceId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!m) throw new ForbiddenException('非此工作空間成員');
  }

  async create(userId: string, workspaceId: string, title: string, description?: string) {
    await this.assertMember(userId, workspaceId);
    const defaultData = {
      cols: 26,
      rows: 50,
      cells: {},
    };
    return this.prisma.spreadsheet.create({
      data: { workspaceId, title, description, data: defaultData },
    });
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    await this.assertMember(userId, workspaceId);
    return this.prisma.spreadsheet.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findById(userId: string, id: string) {
    const s = await this.prisma.spreadsheet.findUnique({ where: { id } });
    if (!s || s.deletedAt) throw new NotFoundException('試算表不存在');
    await this.assertMember(userId, s.workspaceId);
    return s;
  }

  async updateMeta(userId: string, id: string, patch: { title?: string; description?: string }) {
    const s = await this.findById(userId, id);
    return this.prisma.spreadsheet.update({
      where: { id: s.id },
      data: {
        title: patch.title ?? undefined,
        description: patch.description ?? undefined,
      },
    });
  }

  /** 整份 cells/rows/cols 覆寫。前端 debounce 後呼叫。 */
  async saveData(userId: string, id: string, data: unknown) {
    const s = await this.findById(userId, id);
    return this.prisma.spreadsheet.update({
      where: { id: s.id },
      data: { data: data as any },
      select: { id: true, updatedAt: true },
    });
  }

  async softDelete(userId: string, id: string) {
    const s = await this.findById(userId, id);
    return this.prisma.spreadsheet.update({
      where: { id: s.id },
      data: { deletedAt: new Date() },
    });
  }
}
