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
