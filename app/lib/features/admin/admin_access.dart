import 'models/admin_models.dart';

/// `/admin/*` 各路徑需要的權限（擁有其中任何一個即可）。
///
/// 只是使用體驗上的路由守門；真正的權限檢查在後端。
List<String> adminRequiredPerms(String location) {
  final path = Uri.tryParse(location)?.path ?? location;
  if (path == '/admin/employees' || path.startsWith('/admin/employees/')) {
    return const [AdminPerm.employeeReadAll];
  }
  if (path == '/admin/departments' || path.startsWith('/admin/departments/')) {
    return const [AdminPerm.employeeReadAll];
  }
  if (path == '/admin/roles' || path.startsWith('/admin/roles/')) {
    return const [AdminPerm.memberRoleManage];
  }
  if (path == '/admin/audit' || path.startsWith('/admin/audit/')) {
    return const [AdminPerm.auditRead];
  }
  return AdminPerm.anyAdmin;
}

/// `/admin/*` 的路由守門。
///
/// [permissions] 為 null 代表還沒載入完：先放行，由頁面上的 `AdminGuard`
/// 等載入完再決定（避免深連結被誤踢回去）。
/// 已載入但沒有權限 → 回 `/chat`。
String? adminRedirect(String location, Set<String>? permissions) {
  final path = Uri.tryParse(location)?.path ?? location;
  if (path != '/admin' && !path.startsWith('/admin/')) return null;
  if (permissions == null) return null;
  final needed = adminRequiredPerms(location);
  return needed.any(permissions.contains) ? null : '/chat';
}

/// [workspaceId] 是不是公司工作空間。兩個來源任一說是就算：`/company/me` 的 workspaceId，
/// 或工作空間清單那一列的 `isCompany`（`/company/me` 失敗時也判斷得出來）。
bool isCompanyWorkspace(String? workspaceId, {CompanyMe? me, List<dynamic>? workspaces}) {
  if (workspaceId == null || workspaceId.isEmpty) return false;
  if (me != null && me.workspaceId == workspaceId) return true;
  for (final w in workspaces ?? const <dynamic>[]) {
    if (w is Map && w['id'] == workspaceId && w['isCompany'] == true) return true;
  }
  return false;
}

/// `/erp/members` 的路由守門：公司工作空間的成員只由員工生命週期決定（SSO 登入加入、離職移出），
/// 沒有邀請也不能移除，角色在後台「成員與角色」改 → 導到 `/admin/roles`。其他工作空間照舊。
String? membersRedirect(String? currentWorkspaceId, {CompanyMe? me, List<dynamic>? workspaces}) =>
    isCompanyWorkspace(currentWorkspaceId, me: me, workspaces: workspaces) ? '/admin/roles' : null;
