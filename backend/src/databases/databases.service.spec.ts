import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DatabasesService } from './databases.service';
import { PrismaService } from '../common/prisma.service';

type PrismaMock = {
  workspaceMember: { findUnique: jest.Mock };
  database: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  databaseColumn: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  databaseRow: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  databaseCell: { upsert: jest.Mock };
  file: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

const buildPrismaMock = (): PrismaMock => ({
  workspaceMember: { findUnique: jest.fn() },
  database: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  databaseColumn: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  databaseRow: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  databaseCell: { upsert: jest.fn() },
  file: { findMany: jest.fn() },
  $transaction: jest.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
});

describe('DatabasesService', () => {
  let service: DatabasesService;
  let prisma: PrismaMock;

  const USER_ID = 'user-1';
  const WS_ID = 'ws-1';
  const DB_ID = 'db-1';

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabasesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(DatabasesService);
  });

  const asMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue({
      id: 'm-1',
      workspaceId: WS_ID,
      userId: USER_ID,
      role: 'member',
    });

  const asNonMember = () =>
    prisma.workspaceMember.findUnique.mockResolvedValue(null);

  // ==========================================================
  //  Database CRUD
  // ==========================================================
  describe('create', () => {
    it('TC-D02-001: workspace 成員可建立資料庫', async () => {
      asMember();
      prisma.database.create.mockResolvedValue({ id: DB_ID });
      const out = await service.create(USER_ID, {
        workspaceId: WS_ID,
        name: '合約追蹤',
      });
      expect(out).toEqual({ id: DB_ID });
      expect(prisma.database.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: WS_ID,
          name: '合約追蹤',
          createdBy: USER_ID,
        }),
      });
    });

    it('TC-D02-002: 非成員建立會被拒絕', async () => {
      asNonMember();
      await expect(
        service.create(USER_ID, { workspaceId: WS_ID, name: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.database.create).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('TC-D02-003: 帶出欄位與有效資料列 (排除軟刪)', async () => {
      prisma.database.findUnique
        .mockResolvedValueOnce({ id: DB_ID, workspaceId: WS_ID, deletedAt: null })
        .mockResolvedValueOnce({
          id: DB_ID,
          columns: [{ id: 'c-1' }],
          rows: [{ id: 'r-1', cells: [] }],
        });
      asMember();
      const out = await service.findById(USER_ID, DB_ID);
      expect(out?.columns).toHaveLength(1);
      expect(prisma.database.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            rows: expect.objectContaining({
              where: { deletedAt: null },
            }),
          }),
        }),
      );
    });

    it('TC-D02-004: 資料庫不存在或已軟刪 → NotFound', async () => {
      prisma.database.findUnique.mockResolvedValue(null);
      await expect(service.findById(USER_ID, DB_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('TC-D02-005: 軟刪 (寫入 deletedAt)', async () => {
      prisma.database.findUnique.mockResolvedValue({
        id: DB_ID,
        workspaceId: WS_ID,
        deletedAt: null,
      });
      asMember();
      prisma.database.update.mockResolvedValue({ id: DB_ID });
      await service.remove(USER_ID, DB_ID);
      expect(prisma.database.update).toHaveBeenCalledWith({
        where: { id: DB_ID },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  // ==========================================================
  //  Column
  // ==========================================================
  describe('addColumn', () => {
    beforeEach(() => {
      prisma.database.findUnique.mockResolvedValue({
        id: DB_ID,
        workspaceId: WS_ID,
        deletedAt: null,
      });
      asMember();
    });

    it('TC-D02-010: 新增 text 欄位', async () => {
      prisma.databaseColumn.create.mockResolvedValue({ id: 'c-1' });
      await service.addColumn(USER_ID, DB_ID, { name: '廠商', type: 'text' });
      expect(prisma.databaseColumn.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'text', name: '廠商' }),
      });
    });

    it('TC-D02-011: select 欄位沒給 choices → BadRequest', async () => {
      await expect(
        service.addColumn(USER_ID, DB_ID, { name: '狀態', type: 'select' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D02-012: select 欄位帶 choices 可建立', async () => {
      prisma.databaseColumn.create.mockResolvedValue({ id: 'c-2' });
      await service.addColumn(USER_ID, DB_ID, {
        name: '狀態',
        type: 'select',
        options: {
          choices: [
            { id: 'r', label: '未請款', color: 'red' },
            { id: 'g', label: '已結清', color: 'green' },
          ],
        },
      });
      expect(prisma.databaseColumn.create).toHaveBeenCalled();
    });

    it('TC-D02-013: 不支援的 type → BadRequest', async () => {
      await expect(
        service.addColumn(USER_ID, DB_ID, {
          name: 'X',
          type: 'blob' as any,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================
  //  Row
  // ==========================================================
  describe('addRow', () => {
    beforeEach(() => {
      prisma.database.findUnique.mockResolvedValue({
        id: DB_ID,
        workspaceId: WS_ID,
        deletedAt: null,
      });
      asMember();
    });

    it('TC-D02-020: 值型別符合 → 建立成功', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([
        { id: 'c-text', type: 'text', required: false, options: null },
        { id: 'c-num', type: 'number', required: false, options: null },
      ]);
      prisma.databaseRow.create.mockResolvedValue({ id: 'r-1', cells: [] });
      await service.addRow(USER_ID, DB_ID, {
        values: { 'c-text': '合約 A', 'c-num': 60000 },
      });
      expect(prisma.databaseRow.create).toHaveBeenCalled();
    });

    it('TC-D02-021: text 欄塞數字 → BadRequest', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([
        { id: 'c-text', type: 'text', required: false, options: null },
      ]);
      await expect(
        service.addRow(USER_ID, DB_ID, { values: { 'c-text': 123 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D02-022: number 欄塞非數字 → BadRequest', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([
        { id: 'c-num', type: 'number', required: false, options: null },
      ]);
      await expect(
        service.addRow(USER_ID, DB_ID, { values: { 'c-num': 'abc' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D02-023: date 欄需為 ISO 字串', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([
        { id: 'c-date', type: 'date', required: false, options: null },
      ]);
      await expect(
        service.addRow(USER_ID, DB_ID, { values: { 'c-date': '不是日期' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      prisma.databaseRow.create.mockResolvedValue({ id: 'r-1', cells: [] });
      await service.addRow(USER_ID, DB_ID, {
        values: { 'c-date': '2026-04-20' },
      });
      expect(prisma.databaseRow.create).toHaveBeenCalled();
    });

    it('TC-D02-024: select 值不在 choices → BadRequest', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([
        {
          id: 'c-sel',
          type: 'select',
          required: false,
          options: { choices: [{ id: 'r', label: '紅' }] },
        },
      ]);
      await expect(
        service.addRow(USER_ID, DB_ID, { values: { 'c-sel': 'x' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D02-025: 必填欄位缺值 → BadRequest', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([
        { id: 'c-name', type: 'text', required: true, options: null },
      ]);
      await expect(
        service.addRow(USER_ID, DB_ID, { values: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('TC-D02-026: 引用不存在的欄位 → BadRequest', async () => {
      prisma.databaseColumn.findMany.mockResolvedValue([]);
      await expect(
        service.addRow(USER_ID, DB_ID, { values: { 'ghost-col': 'x' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateRow', () => {
    it('TC-D02-030: upsert cell 並保留其他欄位', async () => {
      prisma.databaseRow.findUnique
        .mockResolvedValueOnce({
          id: 'r-1',
          databaseId: DB_ID,
          position: 0,
          deletedAt: null,
          database: { workspaceId: WS_ID },
        })
        .mockResolvedValueOnce({ id: 'r-1', cells: [] });
      asMember();
      prisma.databaseColumn.findMany.mockResolvedValue([
        { id: 'c-text', type: 'text', required: false, options: null },
      ]);
      prisma.databaseCell.upsert.mockResolvedValue({});
      prisma.databaseRow.update.mockResolvedValue({});
      await service.updateRow(USER_ID, 'r-1', {
        values: { 'c-text': '修改後' },
      });
      expect(prisma.databaseCell.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rowId_columnId: { rowId: 'r-1', columnId: 'c-text' } },
        }),
      );
    });

    it('TC-D02-031: 已軟刪的資料列 → NotFound', async () => {
      prisma.databaseRow.findUnique.mockResolvedValue({
        id: 'r-1',
        deletedAt: new Date(),
        database: { workspaceId: WS_ID },
      });
      await expect(
        service.updateRow(USER_ID, 'r-1', { values: {} }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('removeRow', () => {
    it('TC-D02-032: 軟刪 (寫入 deletedAt)', async () => {
      prisma.databaseRow.findUnique.mockResolvedValue({
        id: 'r-1',
        database: { workspaceId: WS_ID },
      });
      asMember();
      prisma.databaseRow.update.mockResolvedValue({});
      await service.removeRow(USER_ID, 'r-1');
      expect(prisma.databaseRow.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  // ==========================================================
  //  D-04 檔案附件欄位
  // ==========================================================
  describe('D-04 file column', () => {
    beforeEach(() => {
      prisma.database.findUnique.mockResolvedValue({
        id: DB_ID,
        workspaceId: WS_ID,
        deletedAt: null,
      });
      asMember();
    });

    describe('addColumn(file)', () => {
      it('TC-D04-001: file 欄位無 options 可建立 (預設單檔)', async () => {
        prisma.databaseColumn.create.mockResolvedValue({ id: 'c-f' });
        await service.addColumn(USER_ID, DB_ID, {
          name: '合約',
          type: 'file',
        });
        expect(prisma.databaseColumn.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ type: 'file', name: '合約' }),
        });
      });

      it('TC-D04-002: file 欄位允許 multiple=true', async () => {
        prisma.databaseColumn.create.mockResolvedValue({ id: 'c-f' });
        await service.addColumn(USER_ID, DB_ID, {
          name: '附件',
          type: 'file',
          options: { multiple: true } as any,
        });
        expect(prisma.databaseColumn.create).toHaveBeenCalled();
      });

      it('TC-D04-003: multiple 非 boolean → BadRequest', async () => {
        await expect(
          service.addColumn(USER_ID, DB_ID, {
            name: '附件',
            type: 'file',
            options: { multiple: 'yes' as any } as any,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('TC-D04-004: accept 非陣列 → BadRequest', async () => {
        await expect(
          service.addColumn(USER_ID, DB_ID, {
            name: '附件',
            type: 'file',
            options: { accept: 'pdf' as any } as any,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    describe('addRow with file cell', () => {
      const fileColumn = (overrides: Record<string, unknown> = {}) => ({
        id: 'c-f',
        type: 'file',
        required: false,
        options: null,
        ...overrides,
      });

      it('TC-D04-010: 檔案同 workspace → 接受', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        prisma.file.findMany.mockResolvedValue([
          { id: 'f-1', workspaceId: WS_ID },
        ]);
        prisma.databaseRow.create.mockResolvedValue({ id: 'r-1', cells: [] });
        await service.addRow(USER_ID, DB_ID, {
          values: { 'c-f': { fileIds: ['f-1'] } },
        });
        expect(prisma.databaseRow.create).toHaveBeenCalled();
      });

      it('TC-D04-011: value 非 { fileIds: [] } 結構 → BadRequest', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        await expect(
          service.addRow(USER_ID, DB_ID, {
            values: { 'c-f': 'f-1' as any },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('TC-D04-012: fileIds 元素非字串 → BadRequest', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        await expect(
          service.addRow(USER_ID, DB_ID, {
            values: { 'c-f': { fileIds: [123] } as any },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('TC-D04-013: 單檔欄位塞 2 個 file → BadRequest', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        await expect(
          service.addRow(USER_ID, DB_ID, {
            values: { 'c-f': { fileIds: ['f-1', 'f-2'] } },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('TC-D04-014: multiple=true 可塞多個 file', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([
          fileColumn({ options: { multiple: true } }),
        ]);
        prisma.file.findMany.mockResolvedValue([
          { id: 'f-1', workspaceId: WS_ID },
          { id: 'f-2', workspaceId: WS_ID },
        ]);
        prisma.databaseRow.create.mockResolvedValue({ id: 'r-1', cells: [] });
        await service.addRow(USER_ID, DB_ID, {
          values: { 'c-f': { fileIds: ['f-1', 'f-2'] } },
        });
        expect(prisma.databaseRow.create).toHaveBeenCalled();
      });

      it('TC-D04-015: 檔案不存在 / 軟刪 → BadRequest', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        prisma.file.findMany.mockResolvedValue([]); // 什麼都撈不到
        await expect(
          service.addRow(USER_ID, DB_ID, {
            values: { 'c-f': { fileIds: ['ghost'] } },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('TC-D04-016: 檔案屬他 workspace → BadRequest', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        prisma.file.findMany.mockResolvedValue([
          { id: 'f-1', workspaceId: 'other-ws' },
        ]);
        await expect(
          service.addRow(USER_ID, DB_ID, {
            values: { 'c-f': { fileIds: ['f-1'] } },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('TC-D04-017: 空陣列 (清空附件) 可接受', async () => {
        prisma.databaseColumn.findMany.mockResolvedValue([fileColumn()]);
        prisma.databaseRow.create.mockResolvedValue({ id: 'r-1', cells: [] });
        await service.addRow(USER_ID, DB_ID, {
          values: { 'c-f': { fileIds: [] } },
        });
        expect(prisma.databaseRow.create).toHaveBeenCalled();
        expect(prisma.file.findMany).not.toHaveBeenCalled();
      });
    });
  });
});
