import { CanActivate, ExecutionContext, ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../common/prisma.service';
import { PERMISSION_METADATA_KEY } from '../common/require-permission.decorator';
import { hasPermission } from '../common/permissions';
import { apiError } from '../common/api-error';
import { CompanyService } from './company.service';

export const COMPANY_NOT_CONFIGURED = 'company_not_configured';

export function companyNotConfigured() {
  return apiError(HttpStatus.NOT_FOUND, COMPANY_NOT_CONFIGURED, '公司工作空間尚未設定，請先執行 company:init');
}

/** guard 通過後放在 `req.company`。 */
export interface CompanyRequestContext {
  workspaceId: string;
  role: string;
}

/**
 * `/admin/*` 用的權限守衛（spec §4.4、H2 contract）：工作空間一律是伺服器端找出的公司工作空間，
 * 客戶端不送 workspaceId；權限看呼叫者**在公司工作空間**的角色。
 *
 * - 要搭配 `JwtAuthGuard`（放在它後面）。
 * - 沒有公司工作空間 → 404 `company_not_configured`。
 * - handler 沒有宣告 `@RequirePermission` → 403（fail closed：漏寫就是不開放）。
 * - bot token → 403：後台只給人用。
 * - 不是公司成員、角色沒有這個 key → 403。
 */
@Injectable()
export class CompanyPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();
    const userId: string | undefined = req.user?.userId;
    if (!userId) throw new ForbiddenException('未登入');
    if (req.user?.isBot) throw new ForbiddenException('bot 不能使用後台');

    const company = await this.company.findCompanyWorkspace();
    if (!company || company.deletedAt) throw companyNotConfigured();

    if (!required) throw new ForbiddenException('此端點未設定權限');

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: company.id, userId } },
      select: { role: true },
    });
    if (!member) throw new ForbiddenException('非公司工作空間成員');
    if (!hasPermission(member.role, required)) {
      throw new ForbiddenException(`權限不足：需要 ${required}`);
    }
    const ctx: CompanyRequestContext = { workspaceId: company.id, role: member.role };
    req.company = ctx;
    return true;
  }
}
