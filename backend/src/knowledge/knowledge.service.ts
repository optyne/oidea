import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';

@Injectable()
export class KnowledgeService {
  constructor(private prisma: PrismaService) {}

  // ─────────────────── Pages ───────────────────

  async createPage(userId: string, dto: CreatePageDto) {
    await this.assertMember(userId, dto.workspaceId);
    if (dto.parentId) {
      const parent = await this.prisma.knowledgePage.findUnique({
        where: { id: dto.parentId },
        select: { workspaceId: true },
      });
      if (!parent || parent.workspaceId !== dto.workspaceId) {
        throw new NotFoundException('父頁面不存在');
      }
    }

    const siblingCount = await this.prisma.knowledgePage.count({
      where: { workspaceId: dto.workspaceId, parentId: dto.parentId ?? null, deletedAt: null },
    });

    return this.prisma.knowledgePage.create({
      data: {
        workspaceId: dto.workspaceId,
        parentId: dto.parentId,
        createdById: userId,
        title: dto.title ?? 'Untitled',
        icon: dto.icon,
        kind: dto.kind ?? 'page',
        position: siblingCount,
      },
    });
  }

  async listWorkspacePages(userId: string, workspaceId: string) {
    await this.assertMember(userId, workspaceId);
    return this.prisma.knowledgePage.findMany({
      where: { workspaceId, deletedAt: null, archived: false },
      orderBy: [{ parentId: 'asc' }, { position: 'asc' }],
      select: {
        id: true,
        parentId: true,
        title: true,
        icon: true,
        kind: true,
        position: true,
        updatedAt: true,
      },
    });
  }

  async getPage(userId: string, id: string) {
    const page = await this.prisma.knowledgePage.findUnique({
      where: { id, deletedAt: null },
      include: {
        blocks: {
          where: { parentBlockId: null },
          orderBy: { position: 'asc' },
        },
        database: {
          include: {
            properties: { orderBy: { position: 'asc' } },
          },
        },
      },
    });
    if (!page) throw new NotFoundException('頁面不存在');
    await this.assertMember(userId, page.workspaceId);
    return page;
  }

  async updatePage(userId: string, id: string, dto: UpdatePageDto) {
    const page = await this.prisma.knowledgePage.findUnique({ where: { id } });
    if (!page) throw new NotFoundException('頁面不存在');
    await this.assertMember(userId, page.workspaceId);

    return this.prisma.knowledgePage.update({
      where: { id },
      data: {
        title: dto.title,
        icon: dto.icon,
        coverUrl: dto.coverUrl,
        parentId: dto.parentId,
        position: dto.position,
        archived: dto.archived,
      },
    });
  }

  async deletePage(userId: string, id: string) {
    const page = await this.prisma.knowledgePage.findUnique({ where: { id } });
    if (!page) throw new NotFoundException('頁面不存在');
    await this.assertMember(userId, page.workspaceId);
    return this.prisma.knowledgePage.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ─────────────────── Blocks ───────────────────

  async listBlocks(userId: string, pageId: string) {
    const page = await this.prisma.knowledgePage.findUnique({
      where: { id: pageId },
      select: { workspaceId: true },
    });
    if (!page) throw new NotFoundException('頁面不存在');
    await this.assertMember(userId, page.workspaceId);

    return this.prisma.knowledgeBlock.findMany({
      where: { pageId },
      orderBy: [{ parentBlockId: 'asc' }, { position: 'asc' }],
    });
  }

  /**
   * 以「整頁覆蓋」方式儲存 block 陣列——前端送出當前 block 順序與內容即可。
   * 新 id 會建立、消失的 id 會刪除、保留的 id 會 upsert。
   */
  async replaceBlocks(
    userId: string,
    pageId: string,
    blocks: Array<{
      id?: string;
      type: string;
      content: any;
      position: number;
      parentBlockId?: string | null;
    }>,
  ) {
    const page = await this.prisma.knowledgePage.findUnique({
      where: { id: pageId },
      select: { workspaceId: true },
    });
    if (!page) throw new NotFoundException('頁面不存在');
    await this.assertMember(userId, page.workspaceId);

    const existing = await this.prisma.knowledgeBlock.findMany({
      where: { pageId },
      select: { id: true },
    });
    const keepIds = new Set(
      blocks.map((b) => b.id).filter((v): v is string => Boolean(v)),
    );
    const toDelete = existing.filter((b) => !keepIds.has(b.id)).map((b) => b.id);

    await this.prisma.$transaction([
      ...toDelete.map((id) => this.prisma.knowledgeBlock.delete({ where: { id } })),
      ...blocks.map((b, i) =>
        b.id
          ? this.prisma.knowledgeBlock.update({
              where: { id: b.id },
              data: {
                type: b.type,
                content: b.content ?? {},
                position: b.position ?? i,
                parentBlockId: b.parentBlockId ?? null,
                lastEditedById: userId,
              },
            })
          : this.prisma.knowledgeBlock.create({
              data: {
                pageId,
                type: b.type,
                content: b.content ?? {},
                position: b.position ?? i,
                parentBlockId: b.parentBlockId ?? null,
                lastEditedById: userId,
              },
            }),
      ),
      this.prisma.knowledgePage.update({
        where: { id: pageId },
        data: { updatedAt: new Date() },
      }),
    ]);

    return this.prisma.knowledgeBlock.findMany({
      where: { pageId },
      orderBy: [{ parentBlockId: 'asc' }, { position: 'asc' }],
    });
  }

  // ─────────────────── Database ───────────────────

  async createDatabase(
    userId: string,
    workspaceId: string,
    opts: {
      parentId?: string;
      title: string;
      icon?: string;
      template?: 'finance_log' | null;
      properties?: Array<{ key: string; name: string; type: string; config?: any }>;
    },
  ) {
    await this.assertMember(userId, workspaceId);

    const page = await this.prisma.knowledgePage.create({
      data: {
        workspaceId,
        parentId: opts.parentId,
        createdById: userId,
        kind: 'database',
        title: opts.title,
        icon: opts.icon,
      },
    });

    const properties = opts.properties ?? [];
    const db = await this.prisma.knowledgeDatabase.create({
      data: {
        pageId: page.id,
        template: opts.template ?? null,
        properties: {
          create: properties.map((p, i) => ({
            key: p.key,
            name: p.name,
            type: p.type,
            config: p.config ?? {},
            position: i,
          })),
        },
      },
      include: { properties: { orderBy: { position: 'asc' } } },
    });

    return { page, database: db };
  }

  /**
   * 預設範本：記帳資料庫。
   * 屬性：date / category / amount / account / note。
   */
  async createFinanceLog(userId: string, workspaceId: string, parentId?: string) {
    return this.createDatabase(userId, workspaceId, {
      parentId,
      title: '💰 記帳',
      icon: '💰',
      template: 'finance_log',
      properties: [
        { key: 'date', name: '日期', type: 'date', config: {} },
        {
          key: 'category',
          name: '類別',
          type: 'select',
          config: {
            options: [
              { id: 'food', label: '餐飲', color: 'orange' },
              { id: 'transport', label: '交通', color: 'blue' },
              { id: 'shopping', label: '購物', color: 'purple' },
              { id: 'entertainment', label: '娛樂', color: 'pink' },
              { id: 'housing', label: '居住', color: 'teal' },
              { id: 'income', label: '收入', color: 'green' },
              { id: 'other', label: '其他', color: 'grey' },
            ],
          },
        },
        { key: 'amount', name: '金額', type: 'currency', config: { code: 'TWD' } },
        { key: 'account', name: '帳戶', type: 'select',
          config: { options: [
            { id: 'cash', label: '現金', color: 'grey' },
            { id: 'credit', label: '信用卡', color: 'blue' },
            { id: 'bank', label: '銀行帳戶', color: 'green' },
          ] } },
        { key: 'note', name: '備註', type: 'text', config: {} },
      ],
    });
  }

  async addProperty(
    userId: string,
    databaseId: string,
    dto: { key: string; name: string; type: string; config?: any },
  ) {
    const db = await this.prisma.knowledgeDatabase.findUnique({
      where: { id: databaseId },
      include: { page: { select: { workspaceId: true } } },
    });
    if (!db) throw new NotFoundException('資料庫不存在');
    await this.assertMember(userId, db.page.workspaceId);

    const count = await this.prisma.dbProperty.count({ where: { databaseId } });
    return this.prisma.dbProperty.create({
      data: {
        databaseId,
        key: dto.key,
        name: dto.name,
        type: dto.type,
        config: dto.config ?? {},
        position: count,
      },
    });
  }

  async listRows(userId: string, databaseId: string) {
    const db = await this.prisma.knowledgeDatabase.findUnique({
      where: { id: databaseId },
      include: { page: { select: { workspaceId: true } } },
    });
    if (!db) throw new NotFoundException('資料庫不存在');
    await this.assertMember(userId, db.page.workspaceId);

    return this.prisma.dbRow.findMany({
      where: { databaseId },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
  }

  async createRow(userId: string, databaseId: string, values: Record<string, any>) {
    const db = await this.prisma.knowledgeDatabase.findUnique({
      where: { id: databaseId },
      include: { page: { select: { workspaceId: true } } },
    });
    if (!db) throw new NotFoundException('資料庫不存在');
    await this.assertMember(userId, db.page.workspaceId);

    const count = await this.prisma.dbRow.count({ where: { databaseId } });
    return this.prisma.dbRow.create({
      data: {
        databaseId,
        createdById: userId,
        values,
        position: count,
      },
    });
  }

  async updateRow(userId: string, rowId: string, values: Record<string, any>) {
    const row = await this.prisma.dbRow.findUnique({
      where: { id: rowId },
      include: { database: { include: { page: { select: { workspaceId: true } } } } },
    });
    if (!row) throw new NotFoundException('資料列不存在');
    await this.assertMember(userId, row.database.page.workspaceId);

    return this.prisma.dbRow.update({
      where: { id: rowId },
      data: { values: { ...(row.values as any), ...values } },
    });
  }

  async deleteRow(userId: string, rowId: string) {
    const row = await this.prisma.dbRow.findUnique({
      where: { id: rowId },
      include: { database: { include: { page: { select: { workspaceId: true } } } } },
    });
    if (!row) throw new NotFoundException('資料列不存在');
    await this.assertMember(userId, row.database.page.workspaceId);

    return this.prisma.dbRow.delete({ where: { id: rowId } });
  }

  /**
   * 記帳專用彙總：以 row.values 中的 amount / category / date 為基礎，回傳指定月份的
   * 總收入、總支出、分類小計、逐日序列。
   */
  async financeSummary(userId: string, databaseId: string, yearMonth: string) {
    const db = await this.prisma.knowledgeDatabase.findUnique({
      where: { id: databaseId },
      include: { page: { select: { workspaceId: true } } },
    });
    if (!db) throw new NotFoundException('資料庫不存在');
    await this.assertMember(userId, db.page.workspaceId);

    const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
    if (!match) throw new ForbiddenException('yearMonth 必須為 YYYY-MM 格式');
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const start = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const end = `${endYear.toString().padStart(4, '0')}-${endMonth.toString().padStart(2, '0')}-01`;

    const rows = await this.prisma.dbRow.findMany({
      where: { databaseId },
      orderBy: { position: 'asc' },
    });

    const byCategory: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    let totalIncome = 0;
    let totalExpense = 0;

    for (const row of rows) {
      const v = (row.values ?? {}) as Record<string, any>;
      const date = String(v.date ?? '').slice(0, 10);
      if (!date || date < start || date >= end) continue;
      const amountNum = Number(v.amount ?? 0);
      if (!Number.isFinite(amountNum)) continue;
      const category = String(v.category ?? 'other');

      if (category === 'income' || amountNum < 0) {
        totalIncome += Math.abs(amountNum);
      } else {
        totalExpense += amountNum;
        byCategory[category] = (byCategory[category] ?? 0) + amountNum;
      }
      byDay[date] = (byDay[date] ?? 0) + (category === 'income' ? -Math.abs(amountNum) : amountNum);
    }

    return {
      yearMonth,
      totalIncome,
      totalExpense,
      net: totalIncome - totalExpense,
      byCategory,
      byDay,
    };
  }

  // ─────────────────── helpers ───────────────────

  private async assertMember(userId: string, workspaceId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!m) throw new ForbiddenException('非此工作空間成員');
  }
}
