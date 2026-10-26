import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { SSO_PROVIDER } from '../auth/oidc/sso-provider';

export interface CompanyWorkspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  pendingOwnerEmail: string | null;
  deletedAt: Date | null;
}

const COMPANY_SELECT = {
  id: true,
  name: true,
  slug: true,
  ownerId: true,
  pendingOwnerEmail: true,
  deletedAt: true,
} as const;

export const COMPANY_INVITE_FORBIDDEN = '公司工作空間的成員由員工資料決定（SSO 登入時加入、離職時移出），不能用邀請加入';

/**
 * 公司工作空間（`Workspace.isCompany`，全庫最多一個）的查詢工具。所有模組都用這裡判斷，
 * 不要各自寫 `where: { isCompany: true }`。
 */
@Injectable()
export class CompanyService {
  constructor(private prisma: PrismaService) {}

  /** 唯一的公司工作空間；還沒 company:init 時回 null。 */
  async findCompanyWorkspace(): Promise<CompanyWorkspace | null> {
    const ws = await this.prisma.workspace.findFirst({
      where: { isCompany: true },
      select: COMPANY_SELECT,
    });
    return (ws as CompanyWorkspace | null) ?? null;
  }

  async isCompanyWorkspace(workspaceId: string): Promise<boolean> {
    if (!workspaceId) return false;
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { isCompany: true },
    });
    return ws?.isCompany === true;
  }

  /** 公司工作空間不接受任何邀請／手動加人（spec §4.3「邀請」）→ 403。 */
  async assertNotCompanyWorkspace(workspaceId: string, message = COMPANY_INVITE_FORBIDDEN): Promise<void> {
    if (await this.isCompanyWorkspace(workspaceId)) {
      throw new ForbiddenException(message);
    }
  }

  /**
   * userId 是否為公司工作空間的 owner：`Workspace.ownerId`（主 owner）或成員角色為 owner（共同 owner）。
   * 回傳公司工作空間（是 owner 時），否則 null。
   */
  async findCompanyOwnership(userId: string): Promise<CompanyWorkspace | null> {
    if (!userId) return null;
    const company = await this.findCompanyWorkspace();
    if (!company || company.deletedAt) return null;
    if (company.ownerId === userId) return company;
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: company.id, userId } },
      select: { role: true },
    });
    return member?.role === 'owner' ? company : null;
  }

  async isCompanyOwner(userId: string): Promise<boolean> {
    return (await this.findCompanyOwnership(userId)) !== null;
  }

  /**
   * 帳號是否經過 SSO 綁定（有 `authentik` Account；綁定時清過密碼、撤銷過 token 與 bot），
   * 而且沒有停用、沒有刪除。緊急登入與 company:init 的 owner 檢查用（review R2）。
   */
  async isSsoBound(userId: string): Promise<boolean> {
    if (!userId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        disabledAt: true,
        deletedAt: true,
        accounts: { where: { provider: SSO_PROVIDER }, select: { id: true } },
      },
    });
    return !!user && !user.disabledAt && !user.deletedAt && (user.accounts ?? []).length > 0;
  }
}
