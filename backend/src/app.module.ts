import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ChannelsModule } from './channels/channels.module';
import { MessagesModule } from './messages/messages.module';
import { ProjectsModule } from './projects/projects.module';
import { TasksModule } from './tasks/tasks.module';
import { MeetingsModule } from './meetings/meetings.module';
import { WhiteboardModule } from './whiteboard/whiteboard.module';
import { FilesModule } from './files/files.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DatabasesModule } from './databases/databases.module';
import { RemindersModule } from './reminders/reminders.module';
import { SnippetsModule } from './snippets/snippets.module';
import { ScheduledMessagesModule } from './scheduled-messages/scheduled-messages.module';
import { AutomationModule } from './automation/automation.module';
import { HealthModule } from './health/health.module';
import { ExpensesModule } from './expenses/expenses.module';
import { AttendanceModule } from './attendance/attendance.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { AuditModule } from './audit/audit.module';
import { InvitesModule } from './invites/invites.module';
import { BotsModule } from './bots/bots.module';
import { SpreadsheetsModule } from './spreadsheets/spreadsheets.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // 全域速率限制；auth 等敏感端點另以 @Throttle() 覆寫更嚴格的額度
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 20 },   // 突發：單秒 20 次
      { name: 'default', ttl: 60_000, limit: 120 }, // 一般：每分鐘 120 次
    ]),
    PrismaModule,
    RedisModule,
    AuditModule,
    HealthModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    ChannelsModule,
    MessagesModule,
    ProjectsModule,
    TasksModule,
    MeetingsModule,
    WhiteboardModule,
    FilesModule,
    NotificationsModule,
    DatabasesModule,
    RemindersModule,
    SnippetsModule,
    ScheduledMessagesModule,
    AutomationModule,
    ExpensesModule,
    AttendanceModule,
    KnowledgeModule,
    InvitesModule,
    BotsModule,
    SpreadsheetsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
