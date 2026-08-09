import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WhiteboardPagesService } from './whiteboard-pages.service';
import { PrismaService } from '../common/prisma.service';
import { FilesService } from '../files/files.service';

const BOARD = { id: 'wb-1', workspaceId: 'ws-1', deletedAt: null };

describe('WhiteboardPagesService', () => {
  let service: WhiteboardPagesService;
  let prisma: any;
  let files: { upload: jest.Mock };

  beforeEach(async () => {
    prisma = {
      whiteboard: { findUnique: jest.fn().mockResolvedValue(BOARD) },
      workspaceMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm-1' }) },
      whiteboardPage: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        aggregate: jest.fn(),
      },
      file: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prisma))),
    };
    files = { upload: jest.fn().mockResolvedValue({ id: 'f-1', url: 'http://minio/f-1.png' }) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhiteboardPagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: FilesService, useValue: files },
      ],
    }).compile();
    service = module.get(WhiteboardPagesService);
  });

  it('listPages: 回 position 升序、含 thumbnailUrl、不含 drawing', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([
      { id: 'p-1', position: 0, thumbnailId: 'f-1', updatedAt: new Date() },
      { id: 'p-2', position: 1, thumbnailId: null, updatedAt: new Date() },
    ]);
    prisma.file.findMany.mockResolvedValue([{ id: 'f-1', url: 'http://minio/f-1.png' }]);

    const out = await service.listPages('u-1', 'wb-1');

    expect(prisma.whiteboardPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { whiteboardId: 'wb-1', deletedAt: null },
        orderBy: { position: 'asc' },
      }),
    );
    expect(out[0].thumbnailUrl).toBe('http://minio/f-1.png');
    expect(out[1].thumbnailUrl).toBeNull();
    expect((out[0] as any).drawing).toBeUndefined();
  });

  it('非 workspace 成員 → Forbidden', async () => {
    prisma.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(service.listPages('u-x', 'wb-1')).rejects.toThrow(ForbiddenException);
  });

  it('getPage: drawing bytes → base64 字串；null 保持 null', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({
      id: 'p-1', whiteboardId: 'wb-1', position: 0, drawing: Buffer.from('PKDATA'), deletedAt: null,
    });
    const out = await service.getPage('u-1', 'wb-1', 'p-1');
    expect(out.drawing).toBe(Buffer.from('PKDATA').toString('base64'));
  });

  it('getPage: 不存在或已刪 → NotFound', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue(null);
    await expect(service.getPage('u-1', 'wb-1', 'nope')).rejects.toThrow(NotFoundException);
  });

  it('createPage: position 接在最大值之後', async () => {
    prisma.whiteboardPage.aggregate.mockResolvedValue({ _max: { position: 2 } });
    prisma.whiteboardPage.create.mockResolvedValue({ id: 'p-4', position: 3 });
    const out = await service.createPage('u-1', 'wb-1');
    expect(prisma.whiteboardPage.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 3 }) }),
    );
    expect(out.position).toBe(3);
  });

  it('savePage: base64 → Buffer 存入；帶縮圖時經 FilesService 上傳並記 thumbnailId', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1', updatedAt: new Date() });
    const drawing = Buffer.from('INK').toString('base64');
    const thumb = Buffer.from('PNG').toString('base64');

    await service.savePage('u-1', 'wb-1', 'p-1', drawing, thumb);

    expect(files.upload).toHaveBeenCalledWith(
      'u-1', 'ws-1',
      expect.objectContaining({ mimetype: 'image/png' }),
    );
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ drawing: Buffer.from('INK'), thumbnailId: 'f-1' }),
      }),
    );
  });

  it('savePage: 不帶縮圖 → 不動 thumbnailId、不呼叫 upload', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1', updatedAt: new Date() });

    await service.savePage('u-1', 'wb-1', 'p-1', Buffer.from('INK').toString('base64'));

    expect(files.upload).not.toHaveBeenCalled();
    const updateArg = prisma.whiteboardPage.update.mock.calls[0][0];
    expect(updateArg.data.thumbnailId).toBeUndefined();
  });

  it('savePage: 縮圖上傳失敗 → 不連坐，筆跡仍存檔且不含 thumbnailId', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1', updatedAt: new Date() });
    files.upload.mockRejectedValue(new Error('MinIO 掛了'));

    const out = await service.savePage(
      'u-1', 'wb-1', 'p-1',
      Buffer.from('INK').toString('base64'),
      Buffer.from('PNG').toString('base64'),
    );

    expect(prisma.whiteboardPage.update).toHaveBeenCalled();
    const updateArg = prisma.whiteboardPage.update.mock.calls[0][0];
    expect(updateArg.data).not.toHaveProperty('thumbnailId');
    expect(updateArg.data.drawing).toEqual(Buffer.from('INK'));
    expect(out).toEqual({ id: 'p-1', updatedAt: expect.any(Date) });
  });

  it('reorderPages: 依 orderedIds 重寫 position（transaction 全量）', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([
      { id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' },
    ]);
    prisma.whiteboardPage.update.mockResolvedValue({});
    const out = await service.reorderPages('u-1', 'wb-1', ['p-3', 'p-1', 'p-2']);
    expect(out.count).toBe(3);
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith({ where: { id: 'p-3' }, data: { position: 0 } });
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith({ where: { id: 'p-1' }, data: { position: 1 } });
  });

  it('reorderPages: orderedIds 與現存頁面集合不一致 → NotFound', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
    await expect(service.reorderPages('u-1', 'wb-1', ['p-1'])).rejects.toThrow(NotFoundException);
  });

  it('reorderPages: orderedIds 含重複 id → NotFound（拒絕非排列）', async () => {
    prisma.whiteboardPage.findMany.mockResolvedValue([{ id: 'p-1' }, { id: 'p-2' }]);
    await expect(service.reorderPages('u-1', 'wb-1', ['p-1', 'p-1'])).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletePage: 軟刪除', async () => {
    prisma.whiteboardPage.findUnique.mockResolvedValue({ id: 'p-1', whiteboardId: 'wb-1', deletedAt: null });
    prisma.whiteboardPage.update.mockResolvedValue({ id: 'p-1' });
    await service.deletePage('u-1', 'wb-1', 'p-1');
    expect(prisma.whiteboardPage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });
});
