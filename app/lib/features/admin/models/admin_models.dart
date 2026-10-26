/// 後台（H2）用到的資料模型。欄位對應 h2-api-contract.md。
///
/// 只做防禦性解析：缺欄位給預設值，不丟例外，避免後端多一個欄位或少一個欄位
/// 就讓整個畫面壞掉。
library;

/// 後端 permission key（`backend/src/common/permissions.ts`）。
class AdminPerm {
  AdminPerm._();

  static const employeeReadAll = 'employee.read_all';
  static const employeeManage = 'employee.manage';
  static const departmentManage = 'department.manage';
  static const memberRoleManage = 'member.role.manage';
  static const ownerTransfer = 'owner.transfer';
  static const auditRead = 'audit.read';

  /// 擁有其中任何一個，就會看到「後台」入口。
  static const anyAdmin = <String>[
    employeeReadAll,
    departmentManage,
    memberRoleManage,
    auditRead,
  ];
}

String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;
String? _strOrNull(Object? v) => v is String && v.isNotEmpty ? v : null;
int _int(Object? v, [int fallback = 0]) => v is num ? v.toInt() : fallback;

const Map<String, String> employmentTypeLabels = {
  'full_time': '正職',
  'part_time': '兼職',
  'contractor': '約聘',
  'intern': '實習',
};

const Map<String, String> employmentStatusLabels = {
  'active': '在職',
  'on_leave': '留職停薪',
  'terminated': '已離職',
};

const Map<String, String> workspaceRoleLabels = {
  'owner': '擁有者',
  'admin': '管理員',
  'hr': 'HR',
  'finance': '財務',
  'member': '一般成員',
};

/// `GET /company/me` 的 `profile`。
class MyProfile {
  const MyProfile({
    required this.id,
    required this.employeeNo,
    required this.email,
    required this.fullName,
    this.jobTitle = '',
    this.employmentType = '',
    this.employmentStatus = '',
    this.hireDate,
    this.phone = '',
    this.departmentName,
    this.managerName,
  });

  final String id;
  final String employeeNo;
  final String email;
  final String fullName;
  final String jobTitle;
  final String employmentType;
  final String employmentStatus;
  final String? hireDate;
  final String phone;
  final String? departmentName;
  final String? managerName;

  factory MyProfile.fromJson(Map<String, dynamic> j) {
    final dept = j['department'];
    final mgr = j['manager'];
    return MyProfile(
      id: _str(j['id']),
      employeeNo: _str(j['employeeNo']),
      email: _str(j['email']),
      fullName: _str(j['fullName']),
      jobTitle: _str(j['jobTitle']),
      employmentType: _str(j['employmentType']),
      employmentStatus: _str(j['employmentStatus']),
      hireDate: _strOrNull(j['hireDate']),
      phone: _str(j['phone']),
      departmentName: dept is Map ? _strOrNull(dept['name']) : null,
      managerName: mgr is Map ? _strOrNull(mgr['fullName']) : null,
    );
  }
}

/// `GET /company/me`。
class CompanyMe {
  const CompanyMe({
    required this.workspaceId,
    required this.role,
    required this.permissions,
    required this.profile,
  });

  final String workspaceId;
  final String? role;
  final List<String> permissions;
  final MyProfile? profile;

  bool can(String key) => permissions.contains(key);

  /// 是否看得到「後台」入口。
  bool get hasAdminAccess => AdminPerm.anyAdmin.any(permissions.contains);

  factory CompanyMe.fromJson(Map<String, dynamic> j) {
    final perms = j['permissions'];
    final profile = j['profile'];
    return CompanyMe(
      workspaceId: _str(j['workspaceId']),
      role: _strOrNull(j['role']),
      permissions: perms is List ? perms.whereType<String>().toList() : const [],
      profile: profile is Map<String, dynamic> ? MyProfile.fromJson(profile) : null,
    );
  }
}

class EmployeeDto {
  const EmployeeDto({
    required this.id,
    required this.employeeNo,
    required this.email,
    required this.fullName,
    this.departmentId,
    this.departmentName,
    this.jobTitle = '',
    this.managerProfileId,
    this.managerName,
    this.employmentType = 'full_time',
    this.employmentStatus = 'active',
    this.hireDate,
    this.terminationDate,
    this.phone = '',
    this.userId,
    this.disabled = false,
  });

  final String id;
  final String employeeNo;
  final String email;
  final String fullName;
  final String? departmentId;
  final String? departmentName;
  final String jobTitle;
  final String? managerProfileId;
  final String? managerName;
  final String employmentType;
  final String employmentStatus;
  final String? hireDate;
  final String? terminationDate;
  final String phone;

  /// null = 尚未用 SSO 登入過（未綁定）。
  final String? userId;
  final bool disabled;

  bool get isTerminated => employmentStatus == 'terminated';
  bool get isBound => userId != null;

  factory EmployeeDto.fromJson(Map<String, dynamic> j) => EmployeeDto(
        id: _str(j['id']),
        employeeNo: _str(j['employeeNo']),
        email: _str(j['email']),
        fullName: _str(j['fullName']),
        departmentId: _strOrNull(j['departmentId']),
        departmentName: _strOrNull(j['departmentName']),
        jobTitle: _str(j['jobTitle']),
        managerProfileId: _strOrNull(j['managerProfileId']),
        managerName: _strOrNull(j['managerName']),
        employmentType: _str(j['employmentType'], 'full_time'),
        employmentStatus: _str(j['employmentStatus'], 'active'),
        hireDate: _strOrNull(j['hireDate']),
        terminationDate: _strOrNull(j['terminationDate']),
        phone: _str(j['phone']),
        userId: _strOrNull(j['userId']),
        disabled: j['disabled'] == true,
      );
}

class EmployeePage {
  const EmployeePage({
    required this.items,
    required this.total,
    required this.page,
    required this.pageSize,
  });

  final List<EmployeeDto> items;
  final int total;
  final int page;
  final int pageSize;

  int get pageCount => pageSize <= 0 ? 1 : ((total + pageSize - 1) ~/ pageSize).clamp(1, 1 << 30);

  factory EmployeePage.fromJson(Map<String, dynamic> j) {
    final raw = j['items'];
    return EmployeePage(
      items: raw is List
          ? raw.whereType<Map<String, dynamic>>().map(EmployeeDto.fromJson).toList()
          : const [],
      total: _int(j['total']),
      page: _int(j['page'], 1),
      pageSize: _int(j['pageSize'], 50),
    );
  }
}

class DepartmentDto {
  const DepartmentDto({
    required this.id,
    required this.name,
    this.parentId,
    this.managerProfileId,
    this.managerName,
    this.sortOrder = 0,
    this.archivedAt,
    this.memberCount = 0,
    this.childCount = 0,
  });

  final String id;
  final String name;
  final String? parentId;
  final String? managerProfileId;
  final String? managerName;
  final int sortOrder;
  final String? archivedAt;
  final int memberCount;
  final int childCount;

  bool get isArchived => archivedAt != null;

  factory DepartmentDto.fromJson(Map<String, dynamic> j) => DepartmentDto(
        id: _str(j['id']),
        name: _str(j['name']),
        parentId: _strOrNull(j['parentId']),
        managerProfileId: _strOrNull(j['managerProfileId']),
        managerName: _strOrNull(j['managerName']),
        sortOrder: _int(j['sortOrder']),
        archivedAt: _strOrNull(j['archivedAt']),
        memberCount: _int(j['memberCount']),
        childCount: _int(j['childCount']),
      );
}

/// 部門樹節點（由扁平清單建出）。
class DepartmentNode {
  DepartmentNode(this.dept);
  final DepartmentDto dept;
  final List<DepartmentNode> children = [];
}

/// 由扁平清單建樹。父節點不在清單內（例如被封存而隱藏）的節點視為根。
/// 同層依 sortOrder 再依名稱排序。
List<DepartmentNode> buildDepartmentTree(List<DepartmentDto> flat) {
  final nodes = {for (final d in flat) d.id: DepartmentNode(d)};
  final roots = <DepartmentNode>[];
  for (final n in nodes.values) {
    final parent = n.dept.parentId == null ? null : nodes[n.dept.parentId];
    if (parent == null || identical(parent, n)) {
      roots.add(n);
    } else {
      parent.children.add(n);
    }
  }
  int cmp(DepartmentNode a, DepartmentNode b) {
    final c = a.dept.sortOrder.compareTo(b.dept.sortOrder);
    return c != 0 ? c : a.dept.name.compareTo(b.dept.name);
  }

  void sortRec(List<DepartmentNode> list) {
    list.sort(cmp);
    for (final n in list) {
      sortRec(n.children);
    }
  }

  sortRec(roots);
  return roots;
}

/// 某部門及其所有子孫的 id（移動部門時，這些都不能當新的上層）。
Set<String> departmentSubtreeIds(List<DepartmentDto> flat, String rootId) {
  final childrenOf = <String, List<String>>{};
  for (final d in flat) {
    final p = d.parentId;
    if (p != null) childrenOf.putIfAbsent(p, () => []).add(d.id);
  }
  final out = <String>{rootId};
  final stack = [rootId];
  while (stack.isNotEmpty) {
    final cur = stack.removeLast();
    for (final c in childrenOf[cur] ?? const <String>[]) {
      if (out.add(c)) stack.add(c);
    }
  }
  return out;
}

class AuditEntry {
  const AuditEntry({
    required this.id,
    required this.action,
    required this.createdAt,
    this.actorName,
    this.actorId,
    this.targetType,
    this.targetId,
    this.metadata,
  });

  final String id;
  final String action;
  final String createdAt;
  final String? actorName;
  final String? actorId;
  final String? targetType;
  final String? targetId;
  final Object? metadata;

  factory AuditEntry.fromJson(Map<String, dynamic> j) {
    final actor = j['actor'];
    return AuditEntry(
      id: _str(j['id']),
      action: _str(j['action']),
      createdAt: _str(j['createdAt']),
      actorId: _strOrNull(j['actorId']),
      actorName: actor is Map ? _strOrNull(actor['displayName']) : null,
      targetType: _strOrNull(j['targetType']),
      targetId: _strOrNull(j['targetId']),
      metadata: j['metadata'],
    );
  }
}

class AuditResponse {
  const AuditResponse({required this.items, this.nextCursor});
  final List<AuditEntry> items;
  final String? nextCursor;

  factory AuditResponse.fromJson(Map<String, dynamic> j) {
    final raw = j['items'];
    return AuditResponse(
      items: raw is List
          ? raw.whereType<Map<String, dynamic>>().map(AuditEntry.fromJson).toList()
          : const [],
      nextCursor: _strOrNull(j['nextCursor']),
    );
  }
}

class ImportError {
  const ImportError(this.line, this.message);
  final int line;
  final String message;
}

class ImportResult {
  const ImportResult({
    this.created = 0,
    this.updated = 0,
    this.unchanged = 0,
    this.errors = const [],
  });

  final int created;
  final int updated;
  final int unchanged;
  final List<ImportError> errors;

  factory ImportResult.fromJson(Map<String, dynamic> j) {
    final raw = j['errors'];
    return ImportResult(
      created: _int(j['created']),
      updated: _int(j['updated']),
      unchanged: _int(j['unchanged']),
      errors: raw is List
          ? raw
              .whereType<Map<String, dynamic>>()
              .map((e) => ImportError(_int(e['line']), _str(e['message'])))
              .toList()
          : const [],
    );
  }
}

/// 日期顯示與傳送一律 `YYYY-MM-DD`。
String formatDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

final RegExp _dateRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');

/// 是否為合法的 `YYYY-MM-DD`（含月份、日數檢查，如 2024-02-30 不合法）。
bool isValidDateString(String s) {
  if (!_dateRe.hasMatch(s)) return false;
  final y = int.parse(s.substring(0, 4));
  final m = int.parse(s.substring(5, 7));
  final d = int.parse(s.substring(8, 10));
  final parsed = DateTime.utc(y, m, d);
  return parsed.year == y && parsed.month == m && parsed.day == d;
}

final RegExp _emailRe = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
bool isValidEmail(String s) => _emailRe.hasMatch(s.trim());

/// 審計時間：ISO 8601 UTC → 本機時間 `YYYY-MM-DD HH:mm`。
String formatTimestamp(String iso) {
  final t = DateTime.tryParse(iso);
  if (t == null) return iso;
  final l = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${formatDate(l)} ${two(l.hour)}:${two(l.minute)}';
}
