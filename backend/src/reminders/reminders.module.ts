import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { RemindersScheduler } from './reminders.scheduler';

@Module({
  imports: [NotificationsModule],
  controllers: [RemindersController],
  providers: [RemindersService, RemindersScheduler],
  exports: [RemindersService],
})
export class RemindersModule {}
