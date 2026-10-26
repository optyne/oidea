import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        statusMessage: true,
        createdAt: true,
      },
    });
    if (!user) throw new NotFoundException('使用者不存在');
    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email, deletedAt: null },
    });
  }

  async findByUsername(username: string) {
    return this.prisma.user.findUnique({
      where: { username, deletedAt: null },
    });
  }

  async create(data: {
    email: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }) {
    return this.prisma.user.create({ data });
  }

  async update(id: string, dto: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data: {
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl,
        status: dto.status,
        statusMessage: dto.statusMessage,
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
        statusMessage: true,
      },
    });
  }

  /**
   * 在指定工作空間的成員中搜尋（不含 bot）。workspaceId 必填，呼叫者必須是該工作空間成員。
   */
  async search(userId: string, query: string, workspaceId: string) {
    if (!workspaceId || !workspaceId.trim()) {
      throw new BadRequestException('缺少 workspaceId');
    }
    const self = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!self) throw new ForbiddenException('非此工作空間成員');

    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        botAccount: { is: null },
        workspaceMembers: { some: { workspaceId } },
        OR: [
          { username: { contains: query, mode: 'insensitive' } },
          { displayName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        status: true,
      },
      take: 20,
    });
  }
}
