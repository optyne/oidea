import { forwardRef, Global, Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiService } from './ai.service';

/**
 * Global 讓 MessagesModule 可以注入 AiService 而不需 circular import workaround。
 * forwardRef(MessagesModule) 避免 bootstrap 解析環。
 */
@Global()
@Module({
  imports: [forwardRef(() => MessagesModule), NotificationsModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
