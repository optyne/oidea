import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchService } from './search.service';

@ApiTags('搜尋')
@Controller('search')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SearchController {
  constructor(private svc: SearchService) {}

  @Get()
  @ApiOperation({
    summary: '跨類別模糊搜尋',
    description:
      'types 為 CSV，可包含 messages/tasks/pages/files，預設全部。每類別回傳前 limit 筆（預設 5）。',
  })
  async search(
    @Req() req: any,
    @Query('workspaceId') workspaceId: string,
    @Query('q') q: string,
    @Query('types') typesCsv?: string,
    @Query('limit') limit?: string,
  ) {
    const types = new Set(
      (typesCsv?.trim() || 'messages,tasks,pages,files').split(',').map((t) => t.trim()),
    );
    const perTypeLimit = limit ? Math.min(Math.max(parseInt(limit, 10), 1), 20) : 5;
    return this.svc.search(req.user.userId, workspaceId, q ?? '', types, perTypeLimit);
  }
}
