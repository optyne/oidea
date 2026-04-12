import { Controller, Get, Post, Delete, Param, UseGuards, Req, UploadedFile, UseInterceptors, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FilesService } from './files.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Express } from 'express';

@ApiTags('檔案')
@Controller('files')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FilesController {
  constructor(private filesService: FilesService) {}

  @Post('upload')
  @ApiOperation({ summary: '上傳檔案' })
  @UseInterceptors(require('@nestjs/platform-express').FileInterceptor('file'))
  async upload(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Query('workspaceId') workspaceId: string,
    @Query('messageId') messageId?: string,
    @Query('taskId') taskId?: string,
  ) {
    return this.filesService.upload(req.user.userId, workspaceId, file, messageId, taskId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得檔案資訊' })
  async findById(@Param('id') id: string) {
    return this.filesService.findById(id);
  }

  @Get('workspace/:workspaceId')
  @ApiOperation({ summary: '取得工作空間檔案列表' })
  async findByWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.filesService.findByWorkspace(workspaceId);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除檔案' })
  async delete(@Param('id') id: string) {
    return this.filesService.delete(id);
  }
}
