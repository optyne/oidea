/**
 * 工作空間角色 → 權限對映表。
 *
 * 使用字串 key 而非 enum 以便日後擴充。每個 endpoint 以 @RequirePermission(key) 宣告所需權限；
 * `PermissionsGuard` 會從 request 的 `workspaceId` / `:workspaceId` / 相關資源反查成員角色。
 *
 * 沒有「等級」概念：hr、finance 不等同 admin，只擁有下表列出的 key。
 * owner 擁有全部 key（`*`），其中 `owner.transfer`、`workspace.delete` 只有 owner 有。
 */
export const PERMISSIONS = {
  WORKSPACE_MANAGE: 'workspace.manage',
  WORKSPACE_DELETE: 'workspace.delete',
  MEMBER_MANAGE: 'member.manage',
  MEMBER_ROLE_MANAGE: 'member.role.manage',
  OWNER_TRANSFER: 'owner.transfer',
  AUDIT_READ: 'audit.read',
  EXPENSE_READ_ALL: 'expense.read_all',
  EXPENSE_APPROVE: 'expense.approve',
  EXPENSE_MARK_PAID: 'expense.mark_paid',
  ATTENDANCE_READ_ALL: 'attendance.read_all',
  ATTENDANCE_REPORT: 'attendance.report',
  LEAVE_APPROVE: 'leave.approve',
  LEAVE_POLICY_MANAGE: 'leave.policy.manage',
  EMPLOYEE_READ_ALL: 'employee.read_all',
  EMPLOYEE_MANAGE: 'employee.manage',
  DEPARTMENT_MANAGE: 'department.manage',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  admin: [
    PERMISSIONS.WORKSPACE_MANAGE,
    PERMISSIONS.MEMBER_MANAGE,
    PERMISSIONS.MEMBER_ROLE_MANAGE,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.EXPENSE_READ_ALL,
    PERMISSIONS.EXPENSE_APPROVE,
    PERMISSIONS.EXPENSE_MARK_PAID,
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_REPORT,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.EMPLOYEE_READ_ALL,
    PERMISSIONS.EMPLOYEE_MANAGE,
    PERMISSIONS.DEPARTMENT_MANAGE,
  ],
  hr: [
    PERMISSIONS.ATTENDANCE_READ_ALL,
    PERMISSIONS.ATTENDANCE_REPORT,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.LEAVE_POLICY_MANAGE,
    PERMISSIONS.EMPLOYEE_READ_ALL,
    PERMISSIONS.EMPLOYEE_MANAGE,
    PERMISSIONS.DEPARTMENT_MANAGE,
  ],
  finance: [
    PERMISSIONS.EXPENSE_READ_ALL,
    PERMISSIONS.EXPENSE_APPROVE,
    PERMISSIONS.EXPENSE_MARK_PAID,
  ],
  member: [],
};

export const WORKSPACE_ROLES = ['owner', 'admin', 'hr', 'finance', 'member'] as const;

export function hasPermission(role: string | undefined, key: string): boolean {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(key);
}
