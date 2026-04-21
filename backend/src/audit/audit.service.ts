import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'knowledge.share'
  | 'knowledge.unshare'
  | 'knowledge.visibility_change'
  | 'knowledge.delete'
  | 'expense.approve'
  | 'expense.reject'
  | 'expense.mark_paid'
  | 'expense.cancel'
  | 'workspace.role_change'
  | 'workspace.member_remove';

export interface AuditRequestContext {
  ip?: string | string[];
  headers?: Record<string, any>;
}

export interface AuditInput {
  actorId?: string | null;
  workspaceId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, any>;
  req?: AuditRequestContext;
}

/**
 * 集中寫入審計日誌。記錄不可逆事件（登入、權限/可見性變更、審批、刪除）。
 * 失敗時只 log 不丟錯 —— 審計不應該中斷主流程。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    const { actorId, workspaceId, action, targetType, targetId, metadata, req } = input;
    const { ip, userAgent } = this.extractFromReq(req);
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: actorId ?? null,
          workspaceId: workspaceId ?? null,
          action,
          targetType,
          targetId,
          metadata: metadata ?? undefined,
          ipAddress: ip,
          userAgent,
        },
      });
    } catch (err) {
      // 審計寫入失敗時只 log，不向上拋 —— 避免因審計故障讓業務操作回滾
      this.logger.warn(
        `audit write failed for ${action}: ${(err as Error).message}`,
      );
    }
  }

  private extractFromReq(req?: AuditRequestContext): { ip?: string; userAgent?: string } {
    if (!req) return {};
    const rawIp = req.ip;
    const ip = Array.isArray(rawIp) ? rawIp[0] : rawIp;
    const ua = req.headers?.['user-agent'];
    return {
      ip: typeof ip === 'string' ? ip.slice(0, 64) : undefined,
      userAgent: typeof ua === 'string' ? ua.slice(0, 256) : undefined,
    };
  }
}
