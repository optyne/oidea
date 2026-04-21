import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * 設為 Global，其他 module 無需 imports 就可注入 AuditService。
 * 讀取 API 則仍透過 AuditController（只允許管理員）。
 */
@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
