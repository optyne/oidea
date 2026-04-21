import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DatabasesService } from './databases.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { UpdateDatabaseDto } from './dto/update-database.dto';
import { CreateColumnDto } from './dto/create-column.dto';
import { UpdateColumnDto } from './dto/update-column.dto';
import { UpsertRowDto } from './dto/upsert-row.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('資料庫')
@Controller('databases')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DatabasesController {
  constructor(private databasesService: DatabasesService) {}

  @Post()
  @ApiOperation({ summary: '建立資料庫' })
  create(@Req() req: any, @Body() dto: CreateDatabaseDto) {
    return this.databasesService.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '取得工作空間資料庫列表' })
  findByWorkspace(
    @Req() req: any,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.databasesService.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得資料庫詳情 (含欄位與資料列)' })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.databasesService.findById(req.user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新資料庫基本資料' })
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateDatabaseDto,
  ) {
    return this.databasesService.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '軟刪除資料庫' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.databasesService.remove(req.user.userId, id);
  }

  // ---------- Columns ----------

  @Post(':id/columns')
  @ApiOperation({ summary: '新增欄位' })
  addColumn(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: CreateColumnDto,
  ) {
    return this.databasesService.addColumn(req.user.userId, id, dto);
  }

  @Patch('columns/:columnId')
  @ApiOperation({ summary: '更新欄位' })
  updateColumn(
    @Req() req: any,
    @Param('columnId') columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.databasesService.updateColumn(req.user.userId, columnId, dto);
  }

  @Delete('columns/:columnId')
  @ApiOperation({ summary: '刪除欄位' })
  removeColumn(@Req() req: any, @Param('columnId') columnId: string) {
    return this.databasesService.removeColumn(req.user.userId, columnId);
  }

  // ---------- Rows ----------

  @Post(':id/rows')
  @ApiOperation({ summary: '新增資料列' })
  addRow(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpsertRowDto,
  ) {
    return this.databasesService.addRow(req.user.userId, id, dto);
  }

  @Patch('rows/:rowId')
  @ApiOperation({ summary: '更新資料列 (upsert cells)' })
  updateRow(
    @Req() req: any,
    @Param('rowId') rowId: string,
    @Body() dto: UpsertRowDto,
  ) {
    return this.databasesService.updateRow(req.user.userId, rowId, dto);
  }

  @Delete('rows/:rowId')
  @ApiOperation({ summary: '軟刪除資料列' })
  removeRow(@Req() req: any, @Param('rowId') rowId: string) {
    return this.databasesService.removeRow(req.user.userId, rowId);
  }
}
