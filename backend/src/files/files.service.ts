import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import * as Minio from 'minio';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private minioClient: Minio.Client;
  private bucket: string;
  /** MinIO 連線成功才會 true；否則檔案 API 回 503，其他模組不受影響。 */
  private minioReady = false;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.bucket = this.configService.get('MINIO_BUCKET', 'oidea-uploads');
    this.minioClient = new Minio.Client({
      endPoint: this.configService.get('MINIO_ENDPOINT', 'localhost'),
      port: this.configService.get<number>('MINIO_PORT', 9000),
      useSSL: false,
      accessKey: this.configService.get('MINIO_ACCESS_KEY', 'oidea_minio'),
      secretKey: this.configService.get('MINIO_SECRET_KEY', 'oidea_minio_secret_dev'),
    });

    // 初始化是非同步的，失敗不要讓 Nest crash —— 只 log 警告，讓其他模組繼續跑。
    this.ensureBucket().catch((err) => {
      this.logger.warn(
        `MinIO 初始化失敗（檔案上傳功能暫時不可用）：${(err as Error).message}`,
      );
    });
  }

  private async ensureBucket() {
    const exists = await this.minioClient.bucketExists(this.bucket);
    if (!exists) {
      await this.minioClient.makeBucket(this.bucket);
    }
    this.minioReady = true;
    this.logger.log(`MinIO 連線成功，bucket=${this.bucket}`);
  }

  private assertMinioReady() {
    if (!this.minioReady) {
      throw new ServiceUnavailableException(
        '檔案儲存服務暫時不可用（MinIO 未連線）',
      );
    }
  }

  async upload(
    userId: string,
    workspaceId: string,
    file: Express.Multer.File,
    messageId?: string,
    taskId?: string,
    folderPath?: string,
  ) {
    this.assertMinioReady();
    const key = `${workspaceId}/${Date.now()}-${file.originalname}`;
    await this.minioClient.putObject(this.bucket, key, file.buffer, file.size, {
      'Content-Type': file.mimetype,
    });

    const url = `${this.configService.get('MINIO_ENDPOINT')}:${this.configService.get('MINIO_PORT')}/${this.bucket}/${key}`;

    return this.prisma.file.create({
      data: {
        workspaceId,
        uploaderId: userId,
        messageId,
        taskId,
        fileName: file.originalname,
        fileType: file.mimetype,
        fileSize: file.size,
        url,
        folderPath: this.normalizeFolderPath(folderPath),
      },
    });
  }

  /// 正規化資料夾路徑：去首尾 `/`、折疊連續 `/`、trim。空字串視為 null（根目錄）。
  private normalizeFolderPath(raw?: string | null): string | null {
    if (!raw) return null;
    const cleaned = raw
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/');
    return cleaned.length > 0 ? cleaned : null;
  }

  async moveToFolder(userId: string, id: string, folderPath: string | null) {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('檔案不存在');
    return this.prisma.file.update({
      where: { id },
      data: { folderPath: this.normalizeFolderPath(folderPath) },
    });
  }

  /// 回傳工作空間中所有已使用的資料夾路徑（包含「含子資料夾」的前綴）。
  /// 例：檔案 A 在 `work/2026/Q2` → 回傳 `['work', 'work/2026', 'work/2026/Q2']`。
  async listFolders(workspaceId: string): Promise<string[]> {
    const rows = await this.prisma.file.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        folderPath: { not: null },
      },
      select: { folderPath: true },
      distinct: ['folderPath'],
    });
    const all = new Set<string>();
    for (const r of rows) {
      const p = r.folderPath;
      if (!p) continue;
      const segments = p.split('/');
      for (let i = 1; i <= segments.length; i++) {
        all.add(segments.slice(0, i).join('/'));
      }
    }
    return Array.from(all).sort();
  }

  async findById(id: string) {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('檔案不存在');
    return file;
  }

  async delete(id: string) {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file) throw new NotFoundException('檔案不存在');

    const key = file.url.split(`/${this.bucket}/`)[1];
    if (key && this.minioReady) {
      try {
        await this.minioClient.removeObject(this.bucket, key);
      } catch (err) {
        // MinIO 移除失敗不擋 DB 軟刪；之後可補 GC
        this.logger.warn(
          `MinIO 移除物件失敗：${(err as Error).message}`,
        );
      }
    }

    return this.prisma.file.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async findByWorkspace(workspaceId: string) {
    return this.prisma.file.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * 檔案庫頁面專用查詢：支援類別篩選、檔名搜尋、分頁。
   *
   * type 分類規則（用 `fileType` 即 MIME 做粗分）：
   *   - `image`: image/*
   *   - `pdf`: application/pdf
   *   - `doc`: 文件類（Office、csv、tsv、純文字、markdown、rtf、odf 系列）
   *   - `video`: video/*
   *   - `audio`: audio/*
   *   - `other`: 以上都不是
   *   - `all` / 未指定：全部
   */
  async browse(
    workspaceId: string,
    opts: {
      type?: 'all' | 'image' | 'pdf' | 'doc' | 'video' | 'audio' | 'other';
      search?: string;
      limit?: number;
      offset?: number;
      /** 資料夾篩選：undefined = 忽略；"" = 根（folderPath IS NULL）；
       *  其它字串 = 此資料夾及子資料夾（前綴比對）。 */
      folderPath?: string;
    } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const q = opts.search?.trim();
    const folder = opts.folderPath === undefined
      ? undefined
      : this.normalizeFolderPath(opts.folderPath);

    // MIME 篩選條件映射到 Prisma where
    const typeWhere = (() => {
      switch (opts.type) {
        case 'image':
          return { fileType: { startsWith: 'image/' } };
        case 'pdf':
          return { fileType: 'application/pdf' };
        case 'video':
          return { fileType: { startsWith: 'video/' } };
        case 'audio':
          return { fileType: { startsWith: 'audio/' } };
        case 'doc':
          return {
            OR: [
              { fileType: { startsWith: 'text/' } },
              // Office 系列
              { fileType: { contains: 'officedocument' } },
              { fileType: { contains: 'msword' } },
              { fileType: { contains: 'ms-excel' } },
              { fileType: { contains: 'ms-powerpoint' } },
              { fileType: { contains: 'opendocument' } },
              { fileType: 'application/rtf' },
            ],
          };
        case 'other':
          return {
            AND: [
              { fileType: { not: { startsWith: 'image/' } } },
              { fileType: { not: { startsWith: 'video/' } } },
              { fileType: { not: { startsWith: 'audio/' } } },
              { fileType: { not: { startsWith: 'text/' } } },
              { fileType: { not: 'application/pdf' } },
              { fileType: { not: { contains: 'officedocument' } } },
              { fileType: { not: { contains: 'msword' } } },
              { fileType: { not: { contains: 'ms-excel' } } },
              { fileType: { not: { contains: 'ms-powerpoint' } } },
              { fileType: { not: { contains: 'opendocument' } } },
              { fileType: { not: 'application/rtf' } },
            ],
          };
        default:
          return {};
      }
    })();

    const folderWhere = (() => {
      if (folder === undefined) return {};
      if (folder === null) return { folderPath: null };
      // 此資料夾或其子資料夾：精確等於 `folder`，或以 `folder/` 開頭。
      return {
        OR: [
          { folderPath: folder },
          { folderPath: { startsWith: `${folder}/` } },
        ],
      };
    })();

    const where: any = {
      workspaceId,
      deletedAt: null,
      ...typeWhere,
      ...folderWhere,
      ...(q ? { fileName: { contains: q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.file.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          uploader: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      }),
      this.prisma.file.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
