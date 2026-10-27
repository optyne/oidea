import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/core/network/auth_session.dart';
import 'package:oidea/core/network/socket_service.dart';
import 'package:oidea/features/admin/models/admin_models.dart';
import 'package:oidea/features/admin/providers/admin_providers.dart';

import 'sso_fakes.dart';

/// 各角色在公司工作空間的權限（對應 backend ROLE_PERMISSIONS 展開後的結果）。
const memberPerms = <String>[];
const hrPerms = <String>['employee.read_all', 'employee.manage', 'department.manage'];
const readOnlyPerms = <String>['employee.read_all'];
const adminPerms = <String>[
  'employee.read_all',
  'employee.manage',
  'department.manage',
  'member.role.manage',
  'audit.read',
];
const ownerPerms = <String>[...adminPerms, 'owner.transfer'];

CompanyMe companyMe(List<String> perms, {String role = 'member', Map<String, dynamic>? profile}) {
  return CompanyMe.fromJson({
    'workspaceId': 'ws-co',
    'role': role,
    'permissions': perms,
    'profile': profile,
  });
}

Map<String, dynamic> employeeJson(
  String id, {
  String name = '王小明',
  String status = 'active',
  String? userId = 'u-1',
  String? terminationDate,
}) =>
    {
      'id': id,
      'employeeNo': 'E-$id',
      'email': '$id@corp.example',
      'fullName': name,
      'departmentId': 'd-1',
      'departmentName': '研發部',
      'jobTitle': '工程師',
      'managerProfileId': null,
      'managerName': null,
      'employmentType': 'full_time',
      'employmentStatus': status,
      'hireDate': '2024-03-01',
      'terminationDate': terminationDate,
      'phone': '',
      'userId': userId,
      'disabled': false,
      'createdAt': '2026-10-01T00:00:00.000Z',
      'updatedAt': '2026-10-01T00:00:00.000Z',
    };

Map<String, dynamic> deptJson(
  String id,
  String name, {
  String? parentId,
  String? managerName,
  int members = 0,
  int children = 0,
  String? archivedAt,
}) =>
    {
      'id': id,
      'name': name,
      'parentId': parentId,
      'managerProfileId': managerName == null ? null : 'p-$id',
      'managerName': managerName,
      'sortOrder': 0,
      'archivedAt': archivedAt,
      'memberCount': members,
      'childCount': children,
    };

/// `GET /workspaces/:id/members` 的一列（WorkspaceMember + include user，見 backend workspaces.service listMembers）。
Map<String, dynamic> memberJson(
  String userId,
  String displayName, {
  String role = 'member',
  String workspaceId = 'ws-co',
  String? email,
}) =>
    {
      'id': 'm-$userId',
      'workspaceId': workspaceId,
      'userId': userId,
      'role': role,
      'joinedAt': '2026-10-01T00:00:00.000Z',
      'user': {
        'id': userId,
        'username': userId,
        'displayName': displayName,
        'avatarUrl': null,
        'email': email ?? '$userId@corp.example',
      },
    };

DioException apiError(int status, Map<String, dynamic> body) {
  final req = RequestOptions(path: 'x');
  return DioException(
    requestOptions: req,
    response: Response(requestOptions: req, statusCode: status, data: body),
    type: DioExceptionType.badResponse,
  );
}

/// 記錄呼叫、回罐頭資料的假 API。沒覆寫的方法會丟 UnimplementedError（Fake 預設）。
class FakeAdminApi extends Fake implements ApiClient {
  List<Map<String, dynamic>> employees = [employeeJson('1'), employeeJson('2', name: '李小華', userId: null)];
  int employeesTotal = 2;
  List<Map<String, dynamic>> departments = [];
  List<dynamic> members = [];
  // 形狀同 POST /admin/employees/import 的回應（backend employee-admin.service importCsv）
  Map<String, dynamic> importPreview = {'created': 1, 'updated': 0, 'unchanged': 0, 'errors': <dynamic>[], 'dryRun': true};
  Map<String, dynamic> importFinal = {'created': 1, 'updated': 0, 'unchanged': 0, 'errors': <dynamic>[], 'dryRun': false};
  Object? terminateError;
  Object? deleteDepartmentError;

  /// 審計：key = cursor（第一頁是 null），value = 該頁回應。
  Map<String?, Map<String, dynamic>> auditPages = {};

  final List<String> calls = [];
  final List<Map<String, dynamic>> employeeQueries = [];
  final List<String?> auditCursors = [];
  final List<Map<String, dynamic>> auditQueries = [];
  final List<bool> importDryRuns = [];
  final List<Map<String, dynamic>> createdEmployees = [];
  final List<({String id, String date})> terminated = [];

  @override
  Future<List<dynamic>> getWorkspaces() async => [];

  @override
  Future<Map<String, dynamic>> getAdminEmployees({
    String? departmentId,
    String? status,
    String? q,
    int page = 1,
    int pageSize = 50,
  }) async {
    employeeQueries.add({'departmentId': departmentId, 'status': status, 'q': q, 'page': page});
    return {'items': employees, 'total': employeesTotal, 'page': page, 'pageSize': pageSize};
  }

  @override
  Future<Map<String, dynamic>> createAdminEmployee(Map<String, dynamic> body) async {
    createdEmployees.add(body);
    return employeeJson('new');
  }

  @override
  Future<Map<String, dynamic>> terminateEmployee(String id, String terminationDate) async {
    if (terminateError != null) throw terminateError!;
    terminated.add((id: id, date: terminationDate));
    return employeeJson(id, status: 'terminated', terminationDate: terminationDate);
  }

  @override
  Future<Map<String, dynamic>> importEmployees(String csv, {required bool dryRun}) async {
    importDryRuns.add(dryRun);
    return dryRun ? importPreview : importFinal;
  }

  @override
  Future<List<dynamic>> getAdminDepartments({bool includeArchived = false}) async => departments;

  @override
  Future<void> deleteDepartment(String id) async {
    calls.add('deleteDepartment:$id');
    if (deleteDepartmentError != null) throw deleteDepartmentError!;
  }

  @override
  Future<List<dynamic>> getWorkspaceMembers(String workspaceId) async => members;

  @override
  Future<Map<String, dynamic>> updateMemberRole(String workspaceId, String userId, String role) async {
    calls.add('role:$userId:$role');
    return {};
  }

  @override
  Future<Map<String, dynamic>> transferWorkspaceOwner(String workspaceId, String newOwnerUserId) async {
    calls.add('transfer:$newOwnerUserId');
    return {};
  }

  @override
  Future<void> removeMember(String workspaceId, String userId) async {
    calls.add('remove:$workspaceId:$userId');
  }

  @override
  Future<Map<String, dynamic>> inviteMemberByIdentifier(
    String workspaceId, {
    required String identifier,
    String role = 'member',
  }) async {
    calls.add('invite:$workspaceId:$identifier:$role');
    return memberJson('u-new', identifier, role: role, workspaceId: workspaceId);
  }

  @override
  Future<Map<String, dynamic>> createWorkspaceInvite(
    String workspaceId, {
    String? email,
    String role = 'member',
    int expiresInDays = 7,
  }) async {
    calls.add('inviteLink:$workspaceId:$role:$expiresInDays');
    return {'id': 'inv-1', 'workspaceId': workspaceId, 'token': 'tok-123', 'role': role};
  }

  @override
  Future<Map<String, dynamic>> getAuditLogs(
    String workspaceId, {
    String? from,
    String? to,
    String? action,
    String? actorId,
    String? cursor,
    int limit = 50,
  }) async {
    auditCursors.add(cursor);
    auditQueries.add({'from': from, 'to': to, 'action': action, 'actorId': actorId, 'cursor': cursor});
    return auditPages[cursor] ?? {'items': <dynamic>[], 'nextCursor': null};
  }
}

Override adminApiOverride(FakeAdminApi api) => apiClientProvider.overrideWithValue(api);

/// `/company/me` 失敗（例如 404 company_not_configured）。
Override companyMeFailsOverride() => companyMeProvider.overrideWith(
      (ref) async => throw apiError(404, {'code': 'company_not_configured', 'message': '尚未設定公司工作空間'}),
    );

/// 把頁面包進測試用的 ProviderScope + MaterialApp。
Widget adminApp(
  Widget home, {
  required FakeAdminApi api,
  required CompanyMe me,
  List<Override> extra = const [],
}) {
  return ProviderScope(
    overrides: [
      apiClientProvider.overrideWithValue(api),
      companyMeProvider.overrideWith((ref) async => me),
      ...extra,
    ],
    child: MaterialApp(home: home),
  );
}

/// 讓 `AuthNotifier` 這類會碰平台外掛的東西不要真的動（側欄、底部導覽用）。
List<Override> shellOverrides() => [
      authSessionProvider.overrideWith((ref) => AuthSession(store: MemoryTokenStore(), refreshDio: Dio())),
      socketProvider.overrideWithValue(FakeSocketService()),
    ];

/// 桌面寬度，表格不會被橫向捲動裁掉。
void useWideScreen(WidgetTester tester, {double width = 1800, double height = 1000}) {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}
