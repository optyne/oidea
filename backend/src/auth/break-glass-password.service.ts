import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CompanyService } from '../company/company.service';
import { resolveUserIdByEmail } from '../common/email-lookup';

export const BREAK_GLASS_MIN_LENGTH = 12;
/** bcrypt 只看前 72 bytes；超過的部分會被默默忽略，所以直接拒絕。 */
export const BREAK_GLASS_MAX_BYTES = 72;

/** 操作者看的錯誤。訊息裡絕不放密碼。 */
export class BreakGlassPasswordError extends Error {}

/**
 * `npm run auth:set-break-glass-password -- <email>`（spec §4.3「開發與緊急登入」）。
 * 只允許公司工作空間的 owner；密碼由呼叫端從 stdin 讀進來，這裡只做 bcrypt（cost 12，跟註冊相同）。
 * 要能真的登入，email 還必須在 BREAK_GLASS_OWNER_EMAILS 裡（或帳密登入是開著的）。
 */
@Injectable()
export class BreakGlassPasswordService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private company: CompanyService,
  ) {}

  async setPassword(email: string, password: string): Promise<{ userId: string; workspaceId: string }> {
    if (typeof password !== 'string' || password.length < BREAK_GLASS_MIN_LENGTH) {
      throw new BreakGlassPasswordError(`密碼至少要 ${BREAK_GLASS_MIN_LENGTH} 個字元`);
    }
    if (Buffer.byteLength(password, 'utf8') > BREAK_GLASS_MAX_BYTES) {
      throw new BreakGlassPasswordError(`密碼不能超過 ${BREAK_GLASS_MAX_BYTES} bytes（bcrypt 的上限）`);
    }
    const needle = typeof email === 'string' ? email.trim() : '';
    if (!needle) throw new BreakGlassPasswordError('必須提供 email');

    // 完全相同優先、只差大小寫的多筆 → 拒絕；比對不用 ILIKE（review S8）
    const id = await resolveUserIdByEmail(this.prisma, needle);
    if (id === 'ambiguous') {
      throw new BreakGlassPasswordError('這個 email 對到多個只差大小寫的使用者帳號，無法判斷是哪一個');
    }
    const user = id
      ? await this.prisma.user.findUnique({
          where: { id, deletedAt: null },
          select: { id: true, disabledAt: true, botAccount: { select: { id: true } } },
        })
      : null;
    if (!user || user.disabledAt || user.botAccount) {
      throw new BreakGlassPasswordError('找不到可用的使用者帳號（不存在、已停用或是 bot）');
    }
    const company = await this.company.findCompanyOwnership(user.id);
    if (!company) {
      throw new BreakGlassPasswordError('只有公司工作空間的 owner 可以設定緊急登入密碼');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await this.audit.record({
      actorId: null,
      workspaceId: company.id,
      action: 'auth.break_glass_password_set',
      targetType: 'user',
      targetId: user.id,
    });
    return { userId: user.id, workspaceId: company.id };
  }
}
