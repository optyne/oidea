import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('任務')
@Controller('tasks')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TasksController {
  constructor(private tasksService: TasksService) {}

  @Post()
  @ApiOperation({ summary: '建立任務' })
  async create(@Req() req: any, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(req.user.userId, dto);
  }

  @Get('project/:projectId')
  @ApiOperation({ summary: '取得專案任務列表' })
  async findByProject(@Req() req: any, @Param('projectId') projectId: string) {
    return this.tasksService.findByProject(req.user.userId, projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得任務詳情' })
  async findById(@Req() req: any, @Param('id') id: string) {
    return this.tasksService.findById(req.user.userId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新任務' })
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasksService.update(req.user.userId, id, dto);
  }

  @Put(':id/move')
  @ApiOperation({ summary: '移動任務（拖曳）' })
  async move(@Req() req: any, @Param('id') id: string, @Body() body: { columnId: string; position: number }) {
    return this.tasksService.move(req.user.userId, id, body.columnId, body.position);
  }

  @Delete(':id')
  @ApiOperation({ summary: '刪除任務' })
  async delete(@Req() req: any, @Param('id') id: string) {
    return this.tasksService.delete(req.user.userId, id);
  }

  @Post(':id/comments')
  @ApiOperation({ summary: '新增任務評論' })
  async addComment(@Req() req: any, @Param('id') id: string, @Body() body: { content: string }) {
    return this.tasksService.addComment(req.user.userId, id, body.content);
  }

  @Post(':id/subtasks')
  @ApiOperation({ summary: '新增子任務' })
  async addSubtask(@Param('id') id: string, @Body() body: { title: string }) {
    return this.tasksService.addSubtask(id, body.title);
  }

  @Put('subtasks/:subtaskId/toggle')
  @ApiOperation({ summary: '切換子任務完成狀態' })
  async toggleSubtask(@Param('subtaskId') subtaskId: string) {
    return this.tasksService.toggleSubtask(subtaskId);
  }
}
