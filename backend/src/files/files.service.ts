import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import * as Minio from 'minio';

@Injectable()
export class FilesService {
  private minioClient: Minio.Client;
  private bucket: string;

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

    this.ensureBucket();
  }

  private async ensureBucket() {
    const exists = await this.minioClient.bucketExists(this.bucket);
    if (!exists) {
      await this.minioClient.makeBucket(this.bucket);
    }
  }

  async upload(
    userId: string,
    workspaceId: string,
    file: Express.Multer.File,
    messageId?: string,
    taskId?: string,
  ) {
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
    if (key) {
      await this.minioClient.removeObject(this.bucket, key);
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
