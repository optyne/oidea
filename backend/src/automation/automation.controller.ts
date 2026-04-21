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
import { AutomationService } from './automation.service';
import { CreateAutomationRuleDto } from './dto/create-rule.dto';
import { UpdateAutomationRuleDto } from './dto/update-rule.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('自動化規則')
@Controller('automation-rules')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AutomationController {
  constructor(private automation: AutomationService) {}

  @Post()
  @ApiOperation({ summary: '建立自動化規則' })
  create(@Req() req: any, @Body() dto: CreateAutomationRuleDto) {
    return this.automation.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: '取得工作空間所有規則' })
  findByWorkspace(@Req() req: any, @Query('workspaceId') workspaceId: string) {
    return this.automation.findByWorkspace(req.user.userId, workspaceId);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得單一規則' })
  findById(@Req() req: any, @Param('id') id: string) {
    return this.automation.findById(req.user.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新規則 (僅建立者)' })
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationRuleDto,
  ) {
    return this.automation.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '軟刪除規則 (僅建立者)' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.automation.remove(req.user.userId, id);
  }
}
