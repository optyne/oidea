import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { parseTrustProxy } from './common/trust-proxy';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 在反向代理（Traefik，可能再加 Cloudflare）後面時，req.ip 要靠 trust proxy 才是客戶端 IP。
  // 未設定 TRUST_PROXY 就維持原本行為（不信任代理）。跳數需在 staging 實測後再設。
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  app.use(json({ limit: '20mb' })); // 白板筆跡 base64 上限（spec: >10MB 警告，20mb 留 buffer）

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());

  // 本機 Flutter Web 埠號不固定，開發環境允許任意 origin 較省事；正式環境請改為白名單。
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((s) => s.trim()) : true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Oidea API')
    .setDescription('Oidea 協作平台 API 文件')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Oidea Backend running on http://localhost:${port}`);
}
bootstrap();
