import { Global, Module } from '@nestjs/common';
import { CompanyService } from './company.service';

/** 設為 Global：workspaces、invites、auth、employees 都要判斷公司工作空間。 */
@Global()
@Module({
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompanyModule {}
