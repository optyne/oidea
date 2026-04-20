import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { ScheduledMessagesController } from './scheduled-messages.controller';
import { ScheduledMessagesService } from './scheduled-messages.service';
import { ScheduledMessagesScheduler } from './scheduled-messages.scheduler';

@Module({
  imports: [MessagesModule],
  controllers: [ScheduledMessagesController],
  providers: [ScheduledMessagesService, ScheduledMessagesScheduler],
  exports: [ScheduledMessagesService],
})
export class ScheduledMessagesModule {}
