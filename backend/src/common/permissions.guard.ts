import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { PERMISSION_METADATA_KEY } from './require-permission.decorator';
import { hasPermission } from './permissions';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(PERMISSION_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const userId = req.user?.userId;
    if (!userId) throw new ForbiddenException('未登入');

    const workspaceId =
      req.params?.workspaceId ??
      req.query?.workspaceId ??
      req.body?.workspaceId;
    if (!workspaceId) {
      throw new BadRequestException('缺少 workspaceId 無法驗證權限');
    }

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');

    if (!hasPermission(member.role, required)) {
      throw new ForbiddenException(`權限不足：需要 ${required}`);
    }

    // 讓 controller / service 免再查一次。
    req.workspaceMemberRole = member.role;
    return true;
  }
}
