import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('專案')
@Controller('projects')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ProjectsController {
  constructor(private projectsService: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: '建立專案' })
  async create(@Req() req: any, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(req.user.userId, dto.workspaceId, dto);
  }

  @Get('workspace/:workspaceId')
  @ApiOperation({ summary: '取得工作空間專案列表' })
  async findByWorkspace(@Req() req: any, @Param('workspaceId') workspaceId: string) {
    return this.projectsService.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得專案詳情（含看板）' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.projectsService.findById(req.user.userId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新專案' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除專案' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.projectsService.delete(req.user.userId, id);
  }

  @Post(':id/columns')
  @ApiOperation({ summary: '新增看板欄位' })
  async addColumn(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name: string; color?: string },
  ) {
    return this.projectsService.addColumn(req.user.userId, id, body.name, body.color);
  }

  @Put('columns/:columnId')
  @ApiOperation({ summary: '更新看板欄位' })
  async updateColumn(@Param('columnId') columnId: string, @Body() body: { name?: string; color?: string; position?: number }) {
    return this.projectsService.updateColumn(columnId, body);
  }

  @Delete('columns/:columnId')
  @ApiOperation({ summary: '刪除看板欄位' })
  async deleteColumn(@Param('columnId') columnId: string) {
    return this.projectsService.deleteColumn(columnId);
  }
}
