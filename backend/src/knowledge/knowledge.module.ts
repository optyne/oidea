import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { PageAccessService } from './page-access.service';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, PageAccessService],
  exports: [KnowledgeService, PageAccessService],
})
export class KnowledgeModule {}
