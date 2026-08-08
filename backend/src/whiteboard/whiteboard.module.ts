import { Module } from '@nestjs/common';
import { WhiteboardController } from './whiteboard.controller';
import { WhiteboardService } from './whiteboard.service';
import { WhiteboardGateway } from './whiteboard.gateway';
import { WhiteboardPagesController } from './whiteboard-pages.controller';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [FilesModule],
  controllers: [WhiteboardController, WhiteboardPagesController],
  providers: [WhiteboardService, WhiteboardGateway, WhiteboardPagesService],
  exports: [WhiteboardService],
})
export class WhiteboardModule {}
