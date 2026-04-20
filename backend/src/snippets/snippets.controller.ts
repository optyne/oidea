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
import { SnippetsService } from './snippets.service';
import { CreateSnippetDto } from './dto/create-snippet.dto';
import { UpdateSnippetDto } from './dto/update-snippet.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('訊息範本')
@Controller('snippets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SnippetsController {
  constructor(private snippets: SnippetsService) {}

  @Post()
  @ApiOperation({ summary: '建立訊息範本' })
  create(@Req() req: any, @Body() dto: CreateSnippetDto) {
    return this.snippets.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '取得工作空間可見範本 (自己的 + workspace 共用)' })
  findByWorkspace(@Req() req: any, @Query('workspaceId') workspaceId: string) {
    return this.snippets.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得單一範本' })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.snippets.findById(req.user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新範本 (僅作者)' })
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateSnippetDto,
  ) {
    return this.snippets.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '軟刪除範本 (僅作者)' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.snippets.remove(req.user.userId, id);
  }
}
