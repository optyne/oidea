import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FilesService } from './files.service';
import { PrismaService } from '../common/prisma.service';

const minioMock = {
  bucketExists: jest.fn().mockResolvedValue(true),
  makeBucket: jest.fn(),
  putObject: jest.fn().mockResolvedValue(undefined),
  removeObject: jest.fn().mockResolvedValue(undefined),
};
jest.mock('minio', () => ({ Client: jest.fn(() => minioMock) }));

/**
 * Characterization tests for the current happy paths of FilesService
 * (written before the H0 membership checks; kept green afterwards).
 */
describe('FilesService — characterization', () => {
  let service: FilesService;
  let prisma: any;
  const FILE = {
    id: 'f-1',
    workspaceId: 'ws-1',
    url: 'minio:9000/oidea-uploads/ws-1/1-a.png',
    folderPath: null,
  };

  beforeEach(async () => {
    prisma = {
      workspaceMember: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.workspaceId_userId.workspaceId === 'ws-1' && where.workspaceId_userId.userId === 'u-1'
            ? { role: 'member' }
            : null,
        ),
      },
      // t-1 / msg-1 are in ws-1; t-b / msg-b are in ws-b.
      task: {
        findUnique: jest.fn(async ({ where }: any) =>
          ({ 't-1': 'ws-1', 't-b': 'ws-b' } as Record<string, string>)[where.id]
            ? { project: { workspaceId: ({ 't-1': 'ws-1', 't-b': 'ws-b' } as Record<string, string>)[where.id] } }
            : null,
        ),
      },
      message: {
        findUnique: jest.fn(async ({ where }: any) =>
          ({ 'msg-1': 'ws-1', 'msg-b': 'ws-b' } as Record<string, string>)[where.id]
            ? { channel: { workspaceId: ({ 'msg-1': 'ws-1', 'msg-b': 'ws-b' } as Record<string, string>)[where.id] } }
            : null,
        ),
      },
      file: {
        create: jest.fn(async ({ data }: any) => ({ id: 'f-new', ...data })),
        findUnique: jest.fn(async ({ where }: any) => (where.id === 'f-1' ? { ...FILE } : null)),
        update: jest.fn(async ({ where, data }: any) => ({ ...FILE, id: where.id, ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const config = { get: jest.fn((k: string, d?: any) => d ?? k) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(FilesService);
    await new Promise((r) => setImmediate(r)); // let ensureBucket() resolve → minioReady
  });

  it('upload stores the object and creates a File row with normalized folder', async () => {
    const file = { originalname: 'a.png', buffer: Buffer.from('x'), size: 1, mimetype: 'image/png' } as any;
    const res: any = await service.upload('u-1', 'ws-1', file, undefined, undefined, '/a//b/');
    expect(minioMock.putObject).toHaveBeenCalled();
    expect(res).toEqual(
      expect.objectContaining({ workspaceId: 'ws-1', uploaderId: 'u-1', fileName: 'a.png', folderPath: 'a/b' }),
    );
  });

  it('findById returns the row; missing is 404', async () => {
    await expect(service.findById('u-1', 'f-1')).resolves.toEqual(expect.objectContaining({ id: 'f-1' }));
    await expect(service.findById('u-1', 'f-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findByWorkspace lists non-deleted files', async () => {
    await service.findByWorkspace('u-1', 'ws-1');
    expect(prisma.file.findMany.mock.calls[0][0].where).toEqual({ workspaceId: 'ws-1', deletedAt: null });
  });

  it('listFolders expands prefixes', async () => {
    prisma.file.findMany.mockResolvedValue([{ folderPath: 'work/2026/Q2' }, { folderPath: 'misc' }]);
    await expect(service.listFolders('u-1', 'ws-1')).resolves.toEqual([
      'misc',
      'work',
      'work/2026',
      'work/2026/Q2',
    ]);
  });

  it('browse clamps limit and filters by type', async () => {
    const res = await service.browse('u-1', 'ws-1', { type: 'image', limit: 999 });
    expect(res).toEqual({ items: [], total: 0, limit: 200, offset: 0 });
    expect(prisma.file.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ workspaceId: 'ws-1', fileType: { startsWith: 'image/' } }),
    );
  });

  it('moveToFolder normalizes path; empty → root', async () => {
    const res: any = await service.moveToFolder('u-1', 'f-1', ' x/y/ ');
    expect(res.folderPath).toBe('x/y');
    const res2: any = await service.moveToFolder('u-1', 'f-1', '');
    expect(res2.folderPath).toBeNull();
  });

  it('delete removes the object and soft-deletes the row', async () => {
    const res: any = await service.delete('u-1', 'f-1');
    expect(minioMock.removeObject).toHaveBeenCalledWith('oidea-uploads', 'ws-1/1-a.png');
    expect(res.deletedAt).toBeInstanceOf(Date);
  });

  describe('H0: every endpoint requires workspace membership', () => {
    // u-2 is not a member of ws-1 (the workspace of f-1).
    beforeEach(() => {
      minioMock.putObject.mockClear();
      minioMock.removeObject.mockClear();
    });

    it('upload into a foreign workspace → 403, nothing stored', async () => {
      const file = { originalname: 'a.png', buffer: Buffer.from('x'), size: 1, mimetype: 'image/png' } as any;
      await expect(service.upload('u-2', 'ws-1', file)).rejects.toBeInstanceOf(ForbiddenException);
      expect(minioMock.putObject).not.toHaveBeenCalled();
      expect(prisma.file.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a task of another workspace', undefined, 't-b'],
      ['a task that does not exist', undefined, 't-ghost'],
      ['a message of another workspace', 'msg-b', undefined],
      ['a message that does not exist', 'msg-ghost', undefined],
      ['a valid task but a foreign message', 'msg-b', 't-1'],
    ])('S6: upload attached to %s → 403, nothing stored', async (_label, messageId, taskId) => {
      const file = { originalname: 'a.png', buffer: Buffer.from('x'), size: 1, mimetype: 'image/png' } as any;
      await expect(service.upload('u-1', 'ws-1', file, messageId, taskId)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(minioMock.putObject).not.toHaveBeenCalled();
      expect(prisma.file.create).not.toHaveBeenCalled();
    });

    it('S6: upload attached to a task and a message of the same workspace → stored', async () => {
      const file = { originalname: 'a.png', buffer: Buffer.from('x'), size: 1, mimetype: 'image/png' } as any;
      await service.upload('u-1', 'ws-1', file, 'msg-1', 't-1');
      expect(prisma.file.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ workspaceId: 'ws-1', messageId: 'msg-1', taskId: 't-1' }),
      });
    });

    it('upload without workspaceId → 400', async () => {
      const file = { originalname: 'a.png', buffer: Buffer.from('x'), size: 1, mimetype: 'image/png' } as any;
      await expect(service.upload('u-1', undefined as any, file)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('findById of a foreign file → 403', async () => {
      await expect(service.findById('u-2', 'f-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('findByWorkspace of a foreign workspace → 403', async () => {
      await expect(service.findByWorkspace('u-2', 'ws-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.file.findMany).not.toHaveBeenCalled();
    });

    it('browse of a foreign workspace → 403', async () => {
      await expect(service.browse('u-2', 'ws-1', {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.file.findMany).not.toHaveBeenCalled();
    });

    it('listFolders of a foreign workspace → 403', async () => {
      await expect(service.listFolders('u-2', 'ws-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.file.findMany).not.toHaveBeenCalled();
    });

    it('moveToFolder of a foreign file → 403, row untouched', async () => {
      await expect(service.moveToFolder('u-2', 'f-1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.file.update).not.toHaveBeenCalled();
    });

    it('delete of a foreign file → 403, object and row untouched', async () => {
      await expect(service.delete('u-2', 'f-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(minioMock.removeObject).not.toHaveBeenCalled();
      expect(prisma.file.update).not.toHaveBeenCalled();
    });

    it('membership is checked against the file’s own workspace, not a caller-supplied one', async () => {
      await service.findById('u-1', 'f-1');
      expect(prisma.workspaceMember.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'u-1' } } }),
      );
    });
  });
});
