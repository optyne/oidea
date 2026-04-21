/**
 * 工作空間角色 → 權限對映表。
 *
 * 使用字串 key 而非 enum 以便日後擴充。每個 endpoint 以 @RequirePermission(key) 宣告所需權限；
 * `PermissionsGuard` 會從 request 的 `workspaceId` / `:workspaceId` / 相關資源反查成員角色。
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  admin: [
    'workspace.manage',
    'member.manage',
    'expense.read_all',
    'expense.approve',
    'expense.mark_paid',
    'attendance.read_all',
    'attendance.report',
    'leave.approve',
  ],
  hr: [
    'member.manage',
    'attendance.read_all',
    'attendance.report',
    'leave.approve',
  ],
  finance: [
    'expense.read_all',
    'expense.approve',
    'expense.mark_paid',
  ],
  member: [],
};

export function hasPermission(role: string | undefined, key: string): boolean {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(key);
}
