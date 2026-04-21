import { forwardRef, Module } from '@nestjs/common';
import { BotsService } from './bots.service';
import { BotAuthGuard } from './bot-auth.guard';
import { BotSelfController, WorkspaceBotsController } from './bots.controller';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [forwardRef(() => MessagesModule)],
  controllers: [WorkspaceBotsController, BotSelfController],
  providers: [BotsService, BotAuthGuard],
  exports: [BotsService, BotAuthGuard],
})
export class BotsModule {}
