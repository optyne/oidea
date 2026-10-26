import { ForbiddenException } from '@nestjs/common';
import { FilesController } from './files.controller';

/**
 * Every FilesController endpoint must hand the authenticated caller to the service
 * (which enforces membership). A foreign caller gets the service's 403 back.
 */
describe('FilesController — caller is passed to every endpoint', () => {
  const forbidden = () => Promise.reject(new ForbiddenException('非此工作空間成員'));
  const svc: any = {
    upload: jest.fn(forbidden),
    listFolders: jest.fn(forbidden),
    moveToFolder: jest.fn(forbidden),
    findById: jest.fn(forbidden),
    findByWorkspace: jest.fn(forbidden),
    browse: jest.fn(forbidden),
    delete: jest.fn(forbidden),
  };
  const controller = new FilesController(svc);
  const req = { user: { userId: 'u-2' } };

  const cases: Array<[string, () => Promise<any>, string]> = [
    ['upload', () => controller.upload(req, {} as any, 'ws-1'), 'upload'],
    ['listFolders', () => controller.listFolders(req, 'ws-1'), 'listFolders'],
    ['moveToFolder', () => controller.moveToFolder(req, 'f-1', { folderPath: 'x' }), 'moveToFolder'],
    ['findById', () => controller.findById(req, 'f-1'), 'findById'],
    ['findByWorkspace', () => controller.findByWorkspace(req, 'ws-1'), 'findByWorkspace'],
    ['browse', () => controller.browse(req, 'ws-1'), 'browse'],
    ['delete', () => controller.delete(req, 'f-1'), 'delete'],
  ];

  it.each(cases)('%s → 403 for a foreign caller, with userId forwarded', async (_name, call, method) => {
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc[method].mock.calls[0][0]).toBe('u-2');
  });

  it('covers every route handler on the controller', () => {
    const handlers = Object.getOwnPropertyNames(FilesController.prototype).filter((n) => n !== 'constructor');
    expect(handlers.sort()).toEqual(cases.map((c) => c[0]).sort());
  });
});
