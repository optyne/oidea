import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CreateDatabaseDto } from './dto/create-database.dto';
import { UpdateDatabaseDto } from './dto/update-database.dto';
import {
  CreateColumnDto,
  COLUMN_TYPES,
  ColumnType,
} from './dto/create-column.dto';
import { UpdateColumnDto } from './dto/update-column.dto';
import { UpsertRowDto } from './dto/upsert-row.dto';

@Injectable()
export class DatabasesService {
  constructor(private prisma: PrismaService) {}

  // ---------- Database CRUD ----------

  async create(userId: string, dto: CreateDatabaseDto) {
    await this.assertWorkspaceMember(userId, dto.workspaceId);
    return this.prisma.database.create({
      data: {
        workspaceId: dto.workspaceId,
        name: dto.name,
        description: dto.description,
        icon: dto.icon,
        createdBy: userId,
      },
    });
  }

  async findByWorkspace(userId: string, workspaceId: string) {
    await this.assertWorkspaceMember(userId, workspaceId);
    return this.prisma.database.findMany({
      where: { workspaceId, deletedAt: null },
      include: { _count: { select: { rows: true, columns: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findById(userId: string, databaseId: string) {
    const db = await this.loadDatabaseOrThrow(databaseId);
    await this.assertWorkspaceMember(userId, db.workspaceId);
    return this.prisma.database.findUnique({
      where: { id: databaseId },
      include: {
        columns: { orderBy: { position: 'asc' } },
        rows: {
          where: { deletedAt: null },
          orderBy: { position: 'asc' },
          include: { cells: true },
        },
      },
    });
  }

  async update(userId: string, databaseId: string, dto: UpdateDatabaseDto) {
    const db = await this.loadDatabaseOrThrow(databaseId);
    await this.assertWorkspaceMember(userId, db.workspaceId);
    return this.prisma.database.update({
      where: { id: databaseId },
      data: { name: dto.name, description: dto.description, icon: dto.icon },
    });
  }

  async remove(userId: string, databaseId: string) {
    const db = await this.loadDatabaseOrThrow(databaseId);
    await this.assertWorkspaceMember(userId, db.workspaceId);
    return this.prisma.database.update({
      where: { id: databaseId },
      data: { deletedAt: new Date() },
    });
  }

  // ---------- Column CRUD ----------

  async addColumn(userId: string, databaseId: string, dto: CreateColumnDto) {
    const db = await this.loadDatabaseOrThrow(databaseId);
    await this.assertWorkspaceMember(userId, db.workspaceId);
    this.validateColumnOptions(dto.type, dto.options);

    return this.prisma.databaseColumn.create({
      data: {
        databaseId,
        name: dto.name,
        type: dto.type,
        options: (dto.options ?? undefined) as any,
        position: dto.position ?? 0,
        required: dto.required ?? false,
      },
    });
  }

  async updateColumn(userId: string, columnId: string, dto: UpdateColumnDto) {
    const column = await this.prisma.databaseColumn.findUnique({
      where: { id: columnId },
      include: { database: true },
    });
    if (!column) throw new NotFoundException('欄位不存在');
    await this.assertWorkspaceMember(userId, column.database.workspaceId);

    if (dto.options !== undefined) {
      this.validateColumnOptions(column.type as ColumnType, dto.options);
    }

    return this.prisma.databaseColumn.update({
      where: { id: columnId },
      data: {
        name: dto.name,
        options: (dto.options ?? undefined) as any,
        position: dto.position,
        required: dto.required,
      },
    });
  }

  async removeColumn(userId: string, columnId: string) {
    const column = await this.prisma.databaseColumn.findUnique({
      where: { id: columnId },
      include: { database: true },
    });
    if (!column) throw new NotFoundException('欄位不存在');
    await this.assertWorkspaceMember(userId, column.database.workspaceId);

    return this.prisma.databaseColumn.delete({ where: { id: columnId } });
  }

  // ---------- Row CRUD ----------

  async addRow(userId: string, databaseId: string, dto: UpsertRowDto) {
    const db = await this.loadDatabaseOrThrow(databaseId);
    await this.assertWorkspaceMember(userId, db.workspaceId);

    const columns = await this.prisma.databaseColumn.findMany({
      where: { databaseId },
    });
    await this.validateRowValues(columns, dto.values, db.workspaceId);

    return this.prisma.databaseRow.create({
      data: {
        databaseId,
        position: dto.position ?? 0,
        cells: {
          create: Object.entries(dto.values).map(([columnId, value]) => ({
            columnId,
            value: value as any,
          })),
        },
      },
      include: { cells: true },
    });
  }

  async updateRow(userId: string, rowId: string, dto: UpsertRowDto) {
    const row = await this.prisma.databaseRow.findUnique({
      where: { id: rowId },
      include: { database: true },
    });
    if (!row || row.deletedAt)
      throw new NotFoundException('資料列不存在');
    await this.assertWorkspaceMember(userId, row.database.workspaceId);

    const columns = await this.prisma.databaseColumn.findMany({
      where: { databaseId: row.databaseId },
    });
    await this.validateRowValues(
      columns,
      dto.values,
      row.database.workspaceId,
    );

    await this.prisma.$transaction([
      ...Object.entries(dto.values).map(([columnId, value]) =>
        this.prisma.databaseCell.upsert({
          where: { rowId_columnId: { rowId, columnId } },
          create: { rowId, columnId, value: value as any },
          update: { value: value as any },
        }),
      ),
      this.prisma.databaseRow.update({
        where: { id: rowId },
        data: { position: dto.position ?? row.position },
      }),
    ]);

    return this.prisma.databaseRow.findUnique({
      where: { id: rowId },
      include: { cells: true },
    });
  }

  async removeRow(userId: string, rowId: string) {
    const row = await this.prisma.databaseRow.findUnique({
      where: { id: rowId },
      include: { database: true },
    });
    if (!row) throw new NotFoundException('資料列不存在');
    await this.assertWorkspaceMember(userId, row.database.workspaceId);

    return this.prisma.databaseRow.update({
      where: { id: rowId },
      data: { deletedAt: new Date() },
    });
  }

  // ---------- 內部工具 ----------

  private async assertWorkspaceMember(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new ForbiddenException('非此工作空間成員');
  }

  private async loadDatabaseOrThrow(databaseId: string) {
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
    });
    if (!db || db.deletedAt) throw new NotFoundException('資料庫不存在');
    return db;
  }

  private validateColumnOptions(type: ColumnType, options: unknown) {
    if (!COLUMN_TYPES.includes(type)) {
      throw new BadRequestException(`不支援的欄位型別：${type}`);
    }
    if (type === 'select') {
      const choices = (options as { choices?: unknown })?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new BadRequestException('select 欄位需提供 options.choices');
      }
    }
    if (type === 'file') {
      if (options !== undefined && options !== null) {
        const opts = options as { multiple?: unknown; accept?: unknown };
        if (opts.multiple !== undefined && typeof opts.multiple !== 'boolean') {
          throw new BadRequestException('file.options.multiple 需為 boolean');
        }
        if (opts.accept !== undefined && !Array.isArray(opts.accept)) {
          throw new BadRequestException('file.options.accept 需為字串陣列');
        }
      }
    }
  }

  private async validateRowValues(
    columns: { id: string; type: string; required: boolean; options: unknown }[],
    values: Record<string, unknown>,
    workspaceId: string,
  ) {
    const columnById = new Map(columns.map((c) => [c.id, c]));
    for (const [columnId, value] of Object.entries(values)) {
      const col = columnById.get(columnId);
      if (!col) {
        throw new BadRequestException(`欄位不存在：${columnId}`);
      }
      if (value === null || value === undefined) continue;
      if (col.type === 'file') {
        await this.assertFileCellValid(value, col.options, workspaceId);
      } else {
        this.assertValueMatchesType(col.type as ColumnType, value, col.options);
      }
    }
    for (const col of columns) {
      if (col.required && !(col.id in values)) {
        throw new BadRequestException(`必填欄位缺值：${col.id}`);
      }
    }
  }

  private assertValueMatchesType(
    type: ColumnType,
    value: unknown,
    options: unknown,
  ) {
    switch (type) {
      case 'text':
        if (typeof value !== 'string')
          throw new BadRequestException('text 欄位需為字串');
        return;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value))
          throw new BadRequestException('number 欄位需為數字');
        return;
      case 'date':
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
          throw new BadRequestException('date 欄位需為 ISO 日期字串');
        return;
      case 'select': {
        const choices = (options as { choices?: { id: string }[] })?.choices ?? [];
        if (!choices.some((c) => c.id === value))
          throw new BadRequestException('select 欄位值不在 choices 中');
        return;
      }
      case 'file':
        throw new BadRequestException(
          'file 欄位應透過 assertFileCellValid 驗證',
        );
    }
  }

  private async assertFileCellValid(
    value: unknown,
    options: unknown,
    workspaceId: string,
  ) {
    const fileIds = (value as { fileIds?: unknown })?.fileIds;
    if (!Array.isArray(fileIds)) {
      throw new BadRequestException(
        'file 欄位值需為 { fileIds: string[] }',
      );
    }
    if (!fileIds.every((id) => typeof id === 'string')) {
      throw new BadRequestException('fileIds 元素需為字串');
    }
    const multiple = (options as { multiple?: boolean })?.multiple ?? false;
    if (!multiple && fileIds.length > 1) {
      throw new BadRequestException('此欄位僅允許單一檔案');
    }
    if (fileIds.length === 0) return;

    const files = await this.prisma.file.findMany({
      where: { id: { in: fileIds as string[] }, deletedAt: null },
      select: { id: true, workspaceId: true },
    });
    if (files.length !== fileIds.length) {
      throw new BadRequestException('部分檔案不存在或已刪除');
    }
    if (files.some((f) => f.workspaceId !== workspaceId)) {
      throw new BadRequestException('檔案須與資料庫屬於同一工作空間');
    }
  }
}
