import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('ERP・費用報銷')
@Controller('expenses')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Post()
  @ApiOperation({ summary: '提交報銷單' })
  async create(@Req() req: any, @Body() dto: CreateExpenseDto) {
    return this.expenses.create(req.user.userId, dto);
  }

  @Get('workspace/:workspaceId')
  @ApiOperation({ summary: '列出工作空間內的報銷單（非審核者僅見自己）' })
  async list(
    @Req() req: any,
    @Param('workspaceId') workspaceId: string,
    @Query('status') status?: string,
  ) {
    return this.expenses.list(req.user.userId, workspaceId, status);
  }

  @Get('workspace/:workspaceId/stats')
  @ApiOperation({ summary: '報銷狀態彙總' })
  async stats(@Req() req: any, @Param('workspaceId') workspaceId: string) {
    return this.expenses.stats(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得報銷單詳情' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.expenses.findById(req.user.userId, id);
  }

  @Put(':id/approve')
  @ApiOperation({ summary: '核准報銷（需 expense.approve 權限）' })
  async approve(@Req() req: any, @Param('id') id: string, @Body() body: { comment?: string }) {
    return this.expenses.approve(req.user.userId, id, body?.comment);
  }

  @Put(':id/reject')
  @ApiOperation({ summary: '退回報銷（需 expense.approve 權限）' })
  async reject(@Req() req: any, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.expenses.reject(req.user.userId, id, body?.reason);
  }

  @Put(':id/paid')
  @ApiOperation({ summary: '標記已付款（需 expense.mark_paid 權限）' })
  async markPaid(@Req() req: any, @Param('id') id: string) {
    return this.expenses.markPaid(req.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: '取消（僅 pending 狀態）' })
  async cancel(@Req() req: any, @Param('id') id: string) {
    return this.expenses.cancel(req.user.userId, id);
  }

  @Post(':id/receipts')
  @ApiOperation({ summary: '附加發票（傳入已上傳的 file 資料）' })
  async addReceipt(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { fileName: string; fileType: string; fileSize: number; url: string },
  ) {
    return this.expenses.addReceipt(req.user.userId, id, body);
  }
}
