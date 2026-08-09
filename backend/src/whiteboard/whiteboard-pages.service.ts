import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { FilesService } from '../files/files.service';

const PAGE_FORMATS = new Set(['pencilkit', 'excalidraw']);

/**
 * 筆記本的「頁」：drawing 是 PKDrawing dataRepresentation（不透明 bytes），
 * server 不解析；縮圖 PNG 走 FilesService 進 MinIO，供非 iOS 平台唯讀檢視。
 */
@Injectable()
export class WhiteboardPagesService {
  private readonly logger = new Logger(WhiteboardPagesService.name);

  constructor(
    private prisma: PrismaService,
    private files: FilesService,
  ) {}

  /** 確認白板存在且呼叫者是該 workspace 成員；回傳 board 供後續取 workspaceId。 */
  private async assertAccess(userId: string, whiteboardId: string) {
    const board = await this.prisma.whiteboard.findUnique({
      where: { id: whiteboardId, deletedAt: null },
    });
    if (!board) throw new NotFoundException('白板不存在');
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: board.workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
    return board;
  }

  private async getLivePage(whiteboardId: string, pageId: string) {
    const page = await this.prisma.whiteboardPage.findUnique({ where: { id: pageId } });
    if (!page || page.deletedAt || page.whiteboardId !== whiteboardId) {
      throw new NotFoundException('頁面不存在');
    }
    return page;
  }

  async listPages(userId: string, whiteboardId: string) {
    await this.assertAccess(userId, whiteboardId);
    const pages = await this.prisma.whiteboardPage.findMany({
      where: { whiteboardId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, format: true, thumbnailId: true, updatedAt: true },
    });
    const thumbIds = pages.map((p) => p.thumbnailId).filter((x): x is string => !!x);
    const thumbs = thumbIds.length
      ? await this.prisma.file.findMany({ where: { id: { in: thumbIds } }, select: { id: true, url: true } })
      : [];
    const urlById = new Map(thumbs.map((f) => [f.id, f.url]));
    return pages.map(({ thumbnailId, ...p }) => ({
      ...p,
      thumbnailUrl: thumbnailId ? (urlById.get(thumbnailId) ?? null) : null,
    }));
  }

  async getPage(userId: string, whiteboardId: string, pageId: string) {
    await this.assertAccess(userId, whiteboardId);
    const page = await this.getLivePage(whiteboardId, pageId);
    return {
      id: page.id,
      position: page.position,
      format: page.format,
      drawing: page.drawing ? Buffer.from(page.drawing).toString('base64') : null,
    };
  }

  async createPage(userId: string, whiteboardId: string, format = 'pencilkit') {
    if (!PAGE_FORMATS.has(format)) {
      throw new BadRequestException(`format 必須是 ${[...PAGE_FORMATS].join(' | ')}`);
    }
    await this.assertAccess(userId, whiteboardId);
    const agg = await this.prisma.whiteboardPage.aggregate({
      where: { whiteboardId, deletedAt: null },
      _max: { position: true },
    });
    const position = (agg._max.position ?? -1) + 1;
    return this.prisma.whiteboardPage.create({
      data: { whiteboardId, position, format },
      select: { id: true, position: true, format: true },
    });
  }

  async savePage(
    userId: string,
    whiteboardId: string,
    pageId: string,
    drawingBase64: string,
    thumbnailPngBase64?: string,
  ) {
    const board = await this.assertAccess(userId, whiteboardId);
    await this.getLivePage(whiteboardId, pageId);

    let thumbnailId: string | undefined;
    if (thumbnailPngBase64) {
      try {
        const buf = Buffer.from(thumbnailPngBase64, 'base64');
        const uploaded = await this.files.upload(userId, board.workspaceId, {
          originalname: `whiteboard-page-${pageId}.png`,
          mimetype: 'image/png',
          size: buf.length,
          buffer: buf,
        } as Express.Multer.File);
        thumbnailId = uploaded.id;
      } catch (err) {
        // 縮圖上傳失敗不得連坐筆跡存檔：筆跡是唯一真跡，縮圖只是唯讀檢視用的衍生物。
        this.logger.warn(`縮圖上傳失敗（頁 ${pageId}），筆跡仍會存檔：${err}`);
      }
    }

    return this.prisma.whiteboardPage.update({
      where: { id: pageId },
      data: {
        drawing: Buffer.from(drawingBase64, 'base64'),
        ...(thumbnailId ? { thumbnailId } : {}),
      },
      select: { id: true, updatedAt: true },
    });
  }

  async reorderPages(userId: string, whiteboardId: string, orderedIds: string[]) {
    await this.assertAccess(userId, whiteboardId);
    const live = await this.prisma.whiteboardPage.findMany({
      where: { whiteboardId, deletedAt: null },
      select: { id: true },
    });
    const liveIds = new Set(live.map((p) => p.id));
    const sameSize =
      liveIds.size === orderedIds.length &&
      new Set(orderedIds).size === orderedIds.length;
    if (!sameSize || !orderedIds.every((id) => liveIds.has(id))) {
      throw new NotFoundException('orderedIds 與現存頁面不一致');
    }
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.whiteboardPage.update({ where: { id }, data: { position: index } }),
      ),
    );
    return { count: orderedIds.length };
  }

  async deletePage(userId: string, whiteboardId: string, pageId: string) {
    await this.assertAccess(userId, whiteboardId);
    await this.getLivePage(whiteboardId, pageId);
    await this.prisma.whiteboardPage.update({
      where: { id: pageId },
      data: { deletedAt: new Date() },
    });
    return { id: pageId };
  }
}
