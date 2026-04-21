import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { AutomationEngine } from './automation.engine';

@Module({
  imports: [MessagesModule, NotificationsModule],
  controllers: [AutomationController],
  providers: [AutomationService, AutomationEngine],
  exports: [AutomationService, AutomationEngine],
})
export class AutomationModule {}
