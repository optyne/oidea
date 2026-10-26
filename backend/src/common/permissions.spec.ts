import { ExecutionContext, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission } from './permissions';
import { PermissionsGuard } from './permissions.guard';
import { PERMISSION_METADATA_KEY } from './require-permission.decorator';
import { WorkspacesController } from '../workspaces/workspaces.controller';
import { AuditController } from '../audit/audit.controller';
import { AttendanceController } from '../attendance/attendance.controller';

describe('ROLE_PERMISSIONS (no rank table)', () => {
  const managementKeys = [
    PERMISSIONS.MEMBER_MANAGE,
    PERMISSIONS.MEMBER_ROLE_MANAGE,
    PERMISSIONS.OWNER_TRANSFER,
    PERMISSIONS.WORKSPACE_MANAGE,
    PERMISSIONS.WORKSPACE_DELETE,
    PERMISSIONS.AUDIT_READ,
  ];

  it.each(['hr', 'finance', 'member'])('%s has no workspace management key', (role) => {
    for (const key of managementKeys) expect(hasPermission(role, key)).toBe(false);
  });

  it('admin manages members and roles and reads audit, but cannot transfer owner or delete', () => {
    expect(hasPermission('admin', PERMISSIONS.MEMBER_MANAGE)).toBe(true);
    expect(hasPermission('admin', PERMISSIONS.MEMBER_ROLE_MANAGE)).toBe(true);
    expect(hasPermission('admin', PERMISSIONS.AUDIT_READ)).toBe(true);
    expect(hasPermission('admin', PERMISSIONS.OWNER_TRANSFER)).toBe(false);
    expect(hasPermission('admin', PERMISSIONS.WORKSPACE_DELETE)).toBe(false);
  });

  it('owner has every key', () => {
    for (const key of Object.values(PERMISSIONS)) expect(hasPermission('owner', key)).toBe(true);
  });

  it('employee/department keys: hr + admin; leave.policy.manage: hr only (plus owner)', () => {
    for (const key of [PERMISSIONS.EMPLOYEE_READ_ALL, PERMISSIONS.EMPLOYEE_MANAGE, PERMISSIONS.DEPARTMENT_MANAGE]) {
      expect(hasPermission('hr', key)).toBe(true);
      expect(hasPermission('admin', key)).toBe(true);
      expect(hasPermission('finance', key)).toBe(false);
    }
    expect(hasPermission('hr', PERMISSIONS.LEAVE_POLICY_MANAGE)).toBe(true);
    expect(hasPermission('admin', PERMISSIONS.LEAVE_POLICY_MANAGE)).toBe(false);
  });

  it('every key used in the role map is a declared constant', () => {
    const declared = new Set<string>(Object.values(PERMISSIONS));
    for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const k of keys) if (k !== '*') expect([role, declared.has(k)]).toEqual([role, true]);
    }
  });

  it('unknown role or undefined has nothing', () => {
    expect(hasPermission(undefined, PERMISSIONS.MEMBER_MANAGE)).toBe(false);
    expect(hasPermission('superadmin', PERMISSIONS.MEMBER_MANAGE)).toBe(false);
  });
});

describe('PermissionsGuard', () => {
  const roles: Record<string, string> = {
    'u-owner': 'owner',
    'u-admin': 'admin',
    'u-hr': 'hr',
    'u-fin': 'finance',
  };
  const prisma: any = {
    workspaceMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { workspaceId, userId } = where.workspaceId_userId;
        return workspaceId === 'ws-1' && roles[userId] ? { role: roles[userId] } : null;
      }),
    },
  };
  const guard = new PermissionsGuard(new Reflector(), prisma);

  const ctx = (handler: Function, req: any): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => WorkspacesController,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as any;

  const roleHandler = WorkspacesController.prototype.updateMemberRole;
  const removeHandler = WorkspacesController.prototype.removeMember;
  const inviteHandler = WorkspacesController.prototype.inviteMember;
  const transferHandler = WorkspacesController.prototype.transferOwnership;

  it.each([
    ['u-hr', roleHandler],
    ['u-fin', roleHandler],
    ['u-hr', removeHandler],
    ['u-fin', removeHandler],
    ['u-hr', inviteHandler],
    ['u-fin', inviteHandler],
    ['u-admin', transferHandler],
    ['u-hr', transferHandler],
  ])('%s is rejected with 403', async (userId, handler) => {
    const req = { user: { userId }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(ctx(handler, req))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin passes member.role.manage; owner passes owner.transfer; role is stashed on req', async () => {
    const req: any = { user: { userId: 'u-admin' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(ctx(roleHandler, req))).resolves.toBe(true);
    expect(req.workspaceMemberRole).toBe('admin');
    const req2 = { user: { userId: 'u-owner' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(ctx(transferHandler, req2))).resolves.toBe(true);
  });

  it('non-member → 403; missing workspaceId → 400; no metadata → allowed', async () => {
    await expect(
      guard.canActivate(ctx(roleHandler, { user: { userId: 'u-x' }, params: { workspaceId: 'ws-1' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(ctx(roleHandler, { user: { userId: 'u-admin' }, params: {} })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      guard.canActivate(ctx(WorkspacesController.prototype.findAll, { user: { userId: 'u-x' } })),
    ).resolves.toBe(true);
  });
});

describe('@RequirePermission wiring', () => {
  const meta = (cls: any, method: string) => Reflect.getMetadata(PERMISSION_METADATA_KEY, cls.prototype[method]);
  const guards = (cls: any) => Reflect.getMetadata(GUARDS_METADATA, cls) as any[];

  it('workspace management endpoints declare permission keys', () => {
    expect(meta(WorkspacesController, 'update')).toBe(PERMISSIONS.WORKSPACE_MANAGE);
    expect(meta(WorkspacesController, 'delete')).toBe(PERMISSIONS.WORKSPACE_DELETE);
    expect(meta(WorkspacesController, 'inviteMember')).toBe(PERMISSIONS.MEMBER_MANAGE);
    expect(meta(WorkspacesController, 'removeMember')).toBe(PERMISSIONS.MEMBER_MANAGE);
    expect(meta(WorkspacesController, 'updateMemberRole')).toBe(PERMISSIONS.MEMBER_ROLE_MANAGE);
    expect(meta(WorkspacesController, 'transferOwnership')).toBe(PERMISSIONS.OWNER_TRANSFER);
    expect(meta(AuditController, 'listWorkspace')).toBe(PERMISSIONS.AUDIT_READ);
    expect(meta(AttendanceController, 'report')).toBe(PERMISSIONS.ATTENDANCE_REPORT);
  });

  it('those controllers register PermissionsGuard', () => {
    for (const cls of [WorkspacesController, AuditController, AttendanceController]) {
      expect(guards(cls)).toContain(PermissionsGuard);
    }
  });
});
