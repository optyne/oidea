import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WhiteboardService } from './whiteboard.service';
import { CreateWhiteboardDto } from './dto/create-whiteboard.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('白板')
@Controller('whiteboard')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class WhiteboardController {
  constructor(private whiteboardService: WhiteboardService) {}

  @Post()
  @ApiOperation({ summary: '建立白板' })
  async create(@Req() req: any, @Body() dto: CreateWhiteboardDto) {
    return this.whiteboardService.create(req.user.userId, dto);
  }

  @Get('workspace/:workspaceId')
  @ApiOperation({ summary: '取得工作空間白板列表' })
  async findByWorkspace(@Req() req: any, @Param('workspaceId') workspaceId: string) {
    return this.whiteboardService.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得白板詳情' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.whiteboardService.findById(req.user.userId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新白板資訊' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: { title?: string; description?: string }) {
    return this.whiteboardService.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除白板' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.whiteboardService.delete(req.user.userId, id);
  }

  @Get('templates/:workspaceId')
  @ApiOperation({ summary: '取得白板範本' })
  async getTemplates(@Param('workspaceId') workspaceId: string) {
    return this.whiteboardService.getTemplates(workspaceId);
  }

  @Post('from-template/:templateId')
  @ApiOperation({ summary: '從範本建立白板' })
  async duplicateFromTemplate(@Req() req: any, @Param('templateId') templateId: string, @Body() body: { title: string }) {
    return this.whiteboardService.duplicateFromTemplate(req.user.userId, templateId, body.title);
  }
}
