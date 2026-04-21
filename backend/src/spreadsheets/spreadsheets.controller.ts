import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SpreadsheetsService } from './spreadsheets.service';

@ApiTags('試算表')
@Controller('spreadsheets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SpreadsheetsController {
  constructor(private svc: SpreadsheetsService) {}

  @Post()
  @ApiOperation({ summary: '建立試算表' })
  async create(
    @Req() req: any,
    @Body() body: { workspaceId: string; title: string; description?: string },
  ) {
    return this.svc.create(req.user.userId, body.workspaceId, body.title, body.description);
  }

  @Get('workspace/:workspaceId')
  @ApiOperation({ summary: '取得工作空間試算表列表' })
  async list(@Req() req: any, @Param('workspaceId') workspaceId: string) {
    return this.svc.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得試算表詳情（含 cells JSON）' })
  async findOne(@Req() req: any, @Param('id') id: string) {
    return this.svc.findById(req.user.userId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新標題/描述' })
  async updateMeta(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { title?: string; description?: string },
  ) {
    return this.svc.updateMeta(req.user.userId, id, body);
  }

  @Put(':id/data')
  @ApiOperation({
    summary: '儲存試算表內容（整份 JSON）',
    description: '前端 debounce 呼叫；server 不解析 cells 結構，整份覆寫。',
  })
  async saveData(@Req() req: any, @Param('id') id: string, @Body() body: { data: unknown }) {
    return this.svc.saveData(req.user.userId, id, body.data);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除試算表（軟刪）' })
  async softDelete(@Req() req: any, @Param('id') id: string) {
    return this.svc.softDelete(req.user.userId, id);
  }
}
