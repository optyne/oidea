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
      },
    });
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
}
