import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/** 主管鏈與部門樹最多走幾層（資料若有環也一定會停）。 */
export const ORG_WALK_LIMIT = 64;

export interface ManagerSubject {
  id: string;
  workspaceId: string;
  managerProfileId: string | null;
  departmentId: string | null;
}

export interface ResolvedManager {
  id: string;
  fullName: string;
  userId: string;
}

const CANDIDATE_SELECT = {
  id: true,
  workspaceId: true,
  fullName: true,
  userId: true,
  employmentStatus: true,
  user: { select: { disabledAt: true, deletedAt: true } },
} as const;

/**
 * 「主管」是關係不是角色（spec §4.4）：
 * 1. 先看 `EmployeeProfile.managerProfileId`；
 * 2. 沒有（或不合格），沿部門樹往上找第一位部門主管，跳過本人；
 * 3. 都沒有 → null（呼叫端交給 hr）。
 *
 * 不合格的主管一律跳過、繼續往上找：本人、離職（terminated）、還沒有 User（沒登入過）、
 * User 已停用或刪除、不在同一個（公司）工作空間。直屬主管不合格時也改走部門樹（主管離職後部屬自動改走這條找法）。
 * H3 的請假簽核也用這個。
 */
@Injectable()
export class ManagerResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(subject: ManagerSubject): Promise<ResolvedManager | null> {
    if (subject.managerProfileId) {
      const direct = await this.eligible(subject, subject.managerProfileId);
      if (direct) return direct;
    }

    const seen = new Set<string>();
    let departmentId = subject.departmentId;
    for (let i = 0; departmentId && i < ORG_WALK_LIMIT && !seen.has(departmentId); i++) {
      seen.add(departmentId);
      const dept = await this.prisma.department.findFirst({
        where: { id: departmentId, workspaceId: subject.workspaceId },
        select: { parentId: true, managerProfileId: true },
      });
      if (!dept) break;
      if (dept.managerProfileId) {
        const m = await this.eligible(subject, dept.managerProfileId);
        if (m) return m;
      }
      departmentId = dept.parentId;
    }
    return null;
  }

  private async eligible(subject: ManagerSubject, profileId: string): Promise<ResolvedManager | null> {
    if (profileId === subject.id) return null;
    const m = await this.prisma.employeeProfile.findFirst({
      where: { id: profileId, workspaceId: subject.workspaceId },
      select: CANDIDATE_SELECT,
    });
    if (!m || !m.userId || m.employmentStatus === 'terminated') return null;
    if (!m.user || m.user.disabledAt || m.user.deletedAt) return null;
    return { id: m.id, fullName: m.fullName, userId: m.userId };
  }
}
