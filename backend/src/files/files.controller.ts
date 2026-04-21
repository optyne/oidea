import { Body, Controller, Get, Patch, Post, Delete, Param, UseGuards, Req, UploadedFile, UseInterceptors, Query } from '@nestjs/common';
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
    @Query('folderPath') folderPath?: string,
  ) {
    return this.filesService.upload(
      req.user.userId,
      workspaceId,
      file,
      messageId,
      taskId,
      folderPath,
    );
  }

  @Get('workspace/:workspaceId/folders')
  @ApiOperation({ summary: '列出工作空間所有資料夾路徑（含前綴）' })
  async listFolders(@Param('workspaceId') workspaceId: string) {
    return this.filesService.listFolders(workspaceId);
  }

  @Patch(':id/folder')
  @ApiOperation({
    summary: '移動檔案到指定資料夾',
    description: 'folderPath 傳 null 或空字串即移到根。路徑中的 / 會被正規化。',
  })
  async moveToFolder(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { folderPath?: string | null },
  ) {
    return this.filesService.moveToFolder(req.user.userId, id, body.folderPath ?? null);
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

  @Get('workspace/:workspaceId/browse')
  @ApiOperation({
    summary: '檔案庫：依類別 / 關鍵字 / 分頁',
    description:
      '類別（type）可用 all/image/pdf/doc/video/audio/other；search 對 fileName 做不分大小寫子字串比對；limit 上限 200。',
  })
  async browse(
    @Param('workspaceId') workspaceId: string,
    @Query('type') type?: 'all' | 'image' | 'pdf' | 'doc' | 'video' | 'audio' | 'other',
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('folderPath') folderPath?: string,
  ) {
    return this.filesService.browse(workspaceId, {
      type,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      folderPath,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除檔案' })
  async delete(@Param('id') id: string) {
    return this.filesService.delete(id);
  }
}
