import { Controller, Get, Put, Body, UseGuards, Req, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('使用者')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: '取得目前使用者資料' })
  async getMe(@Req() req: any) {
    return this.usersService.findById(req.user.userId);
  }

  @Put('me')
  @ApiOperation({ summary: '更新個人資料' })
  async updateMe(@Req() req: any, @Body() dto: UpdateUserDto) {
    return this.usersService.update(req.user.userId, dto);
  }

  @Get('search')
  @ApiOperation({ summary: '在工作空間成員中搜尋使用者（workspaceId 必填；不含 bot）' })
  async search(
    @Req() req: any,
    @Query('q') query: string,
    @Query('workspaceId') workspaceId: string,
  ) {
    return this.usersService.search(req.user.userId, query, workspaceId);
  }
}
