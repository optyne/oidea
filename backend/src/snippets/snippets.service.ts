import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateSnippetDto } from './dto/create-snippet.dto';
import { UpdateSnippetDto } from './dto/update-snippet.dto';

@Injectable()
export class SnippetsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateSnippetDto) {
    await this.assertWorkspaceMember(userId, dto.workspaceId);
    return this.prisma.messageSnippet.create({
      data: {
        workspaceId: dto.workspaceId,
        createdBy: userId,
        name: dto.name,
        content: dto.content,
        shortcut: dto.shortcut,
        visibility: dto.visibility ?? 'personal',
      },
    });
  }

  /**
   * 回傳「使用者在此 workspace 可看到的」snippet：
   *   - visibility = 'workspace' 的全部
   *   - visibility = 'personal' 且 createdBy = 自己
   * 不回傳其他人的 personal。
   */
  async findByWorkspace(userId: string, workspaceId: string) {
    await this.assertWorkspaceMember(userId, workspaceId);
    return this.prisma.messageSnippet.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [{ visibility: 'workspace' }, { createdBy: userId }],
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const snippet = await this.loadSnippetOrThrow(id);
    await this.assertWorkspaceMember(userId, snippet.workspaceId);
    if (snippet.visibility === 'personal' && snippet.createdBy !== userId) {
      throw new ForbiddenException('此 snippet 為他人私人範本');
    }
    return snippet;
  }

  async update(userId: string, id: string, dto: UpdateSnippetDto) {
    const snippet = await this.loadSnippetOrThrow(id);
    await this.assertWorkspaceMember(userId, snippet.workspaceId);
    if (snippet.createdBy !== userId) {
      throw new ForbiddenException('僅能編輯自己建立的範本');
    }
    return this.prisma.messageSnippet.update({
      where: { id },
      data: {
        name: dto.name,
        content: dto.content,
        shortcut: dto.shortcut,
        visibility: dto.visibility,
      },
    });
  }

  async remove(userId: string, id: string) {
    const snippet = await this.loadSnippetOrThrow(id);
    await this.assertWorkspaceMember(userId, snippet.workspaceId);
    if (snippet.createdBy !== userId) {
      throw new ForbiddenException('僅能刪除自己建立的範本');
    }
    return this.prisma.messageSnippet.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ---------- 內部 ----------

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
  }

  private async loadSnippetOrThrow(id: string) {
    const snippet = await this.prisma.messageSnippet.findUnique({
      where: { id },
    });
    if (!snippet || snippet.deletedAt) {
      throw new NotFoundException('範本不存在');
    }
    return snippet;
  }
}
