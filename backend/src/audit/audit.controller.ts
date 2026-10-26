import { BadRequestException, Controller, Get, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma.service';
import { PermissionsGuard } from '../common/permissions.guard';
import { RequirePermission } from '../common/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions';
import { apiError } from '../common/api-error';

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

/** 不透明 cursor：`<createdAt ISO>|<id>` 的 base64url。 */
export function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeAuditCursor(raw: string): { createdAt: Date; id: string } | null {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sep = text.indexOf('|');
  if (sep <= 0) return null;
  const createdAt = new Date(text.slice(0, sep));
  const id = text.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id || id.length > 64) return null;
  return { createdAt, id };
}

/** ISO 8601 時間；空的回 undefined，格式錯回 400 invalid_date。 */
function parseInstant(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const d = new Date(raw);
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(d.getTime())) {
    throw apiError(HttpStatus.BAD_REQUEST, 'invalid_date', `${field} 必須是 ISO 8601 時間`);
  }
  return d;
}

/** action 過濾：完全相同，或以 `.*` 結尾的前綴（例如 `employee.*`）。 */
export function actionFilter(raw: string | undefined): Prisma.StringFilter | string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw.length > 64 || !/^[a-z_]+(\.[a-z_]+)*(\.\*)?$/.test(raw)) {
    throw new BadRequestException('action 格式不正確（例如 employee.terminate 或 employee.*）');
  }
  return raw.endsWith('.*') ? { startsWith: raw.slice(0, -1) } : raw;
}

/**
 * 只讀端點。需 `audit.read`（owner / admin）。
 *
 * H2 起回傳 `{ items, nextCursor }`（原本回陣列；Flutter 當時沒有呼叫這個端點）：
 * - 排序 `createdAt desc, id desc`；`cursor` 是上一頁的 `nextCursor`（不透明字串）。
 * - `from`／`to`：ISO 時間，`to` 不含。
 * - `action`：完全相同，或 `prefix.*`。
 * - `limit` 預設 50，上限 200。
 */
@ApiTags('審計日誌')
@Controller('audit')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get('workspaces/:workspaceId')
  @RequirePermission(PERMISSIONS.AUDIT_READ)
  @ApiOperation({ summary: '列出工作空間審計事件（owner / admin）' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'action', required: false, description: '完全相同（auth.login_failed）或前綴（employee.*）' })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO 時間（含）' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO 時間（不含）' })
  @ApiQuery({ name: 'cursor', required: false })
  async listWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ) {
    const take = Math.min(Math.max(parseInt(limit ?? String(AUDIT_PAGE_DEFAULT), 10) || AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX);
    const fromAt = parseInstant(from, 'from');
    const toAt = parseInstant(to, 'to');
    const actionWhere = actionFilter(action);
    const after = cursor ? decodeAuditCursor(cursor) : null;
    if (cursor && !after) throw new BadRequestException('cursor 不正確');

    const and: Prisma.AuditLogWhereInput[] = [];
    if (fromAt || toAt) {
      and.push({ createdAt: { ...(fromAt ? { gte: fromAt } : {}), ...(toAt ? { lt: toAt } : {}) } });
    }
    if (after) {
      and.push({
        OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }],
      });
    }

    const rows = await this.prisma.auditLog.findMany({
      where: {
        workspaceId,
        ...(actionWhere !== undefined ? { action: actionWhere } : {}),
        ...(actorId ? { actorId } : {}),
        ...(and.length > 0 ? { AND: and } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      select: {
        id: true,
        action: true,
        actorId: true,
        targetType: true,
        targetId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        actor: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        actor: r.actor ?? null,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        ipAddress: r.ipAddress,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > take && last ? encodeAuditCursor(last.createdAt, last.id) : null,
    };
  }
}
