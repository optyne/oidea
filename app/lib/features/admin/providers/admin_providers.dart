import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../auth/providers/auth_provider.dart';
import '../../erp/models/leave_models.dart';
import '../admin_errors.dart';
import '../models/admin_models.dart';

/// `GET /company/me`。換使用者（登入／登出）時重抓。
///
/// 抓不到（沒設定公司工作空間、網路錯誤）會是 error 狀態；
/// 權限判斷一律走 [adminPermissionsProvider]，error 視為沒有任何權限。
final companyMeProvider = FutureProvider<CompanyMe>((ref) async {
  ref.watch(authStateProvider.select((s) => s.userId));
  final api = ref.watch(apiClientProvider);
  return CompanyMe.fromJson(await api.getCompanyMe());
});

/// 目前使用者在公司工作空間的權限集合。尚未載入或失敗時為空集合。
final adminPermissionsProvider = Provider<Set<String>>((ref) {
  final me = ref.watch(companyMeProvider).valueOrNull;
  return me == null ? const <String>{} : me.permissions.toSet();
});

/// 是否顯示「後台」入口。
final hasAdminAccessProvider = Provider<bool>((ref) {
  final perms = ref.watch(adminPermissionsProvider);
  return AdminPerm.anyAdmin.any(perms.contains);
});

// ───────────────────────── 員工名冊 ─────────────────────────

/// 名冊查詢條件（也是 provider family 的 key，所以要有 ==）。
class EmployeeQuery {
  const EmployeeQuery({
    this.departmentId,
    this.status,
    this.keyword = '',
    this.page = 1,
    this.pageSize = 50,
  });

  final String? departmentId;
  final String? status;
  final String keyword;
  final int page;
  final int pageSize;

  EmployeeQuery copyWith({
    Object? departmentId = _unset,
    Object? status = _unset,
    String? keyword,
    int? page,
  }) =>
      EmployeeQuery(
        departmentId: identical(departmentId, _unset) ? this.departmentId : departmentId as String?,
        status: identical(status, _unset) ? this.status : status as String?,
        keyword: keyword ?? this.keyword,
        page: page ?? this.page,
        pageSize: pageSize,
      );

  @override
  bool operator ==(Object other) =>
      other is EmployeeQuery &&
      other.departmentId == departmentId &&
      other.status == status &&
      other.keyword == keyword &&
      other.page == page &&
      other.pageSize == pageSize;

  @override
  int get hashCode => Object.hash(departmentId, status, keyword, page, pageSize);
}

const Object _unset = Object();

final employeeQueryProvider = StateProvider.autoDispose<EmployeeQuery>((ref) => const EmployeeQuery());

final employeesProvider = FutureProvider.autoDispose<EmployeePage>((ref) async {
  final q = ref.watch(employeeQueryProvider);
  final api = ref.watch(apiClientProvider);
  final json = await api.getAdminEmployees(
    departmentId: q.departmentId,
    status: q.status,
    q: q.keyword,
    page: q.page,
    pageSize: q.pageSize,
  );
  return EmployeePage.fromJson(json);
});

// ───────────────────────── 部門 ─────────────────────────

/// 部門扁平清單；參數為是否包含已封存。
final departmentsProvider = FutureProvider.autoDispose.family<List<DepartmentDto>, bool>((ref, includeArchived) async {
  final api = ref.watch(apiClientProvider);
  final raw = await api.getAdminDepartments(includeArchived: includeArchived);
  return raw.whereType<Map<String, dynamic>>().map(DepartmentDto.fromJson).toList();
});

// ───────────────────────── 請假規則（H3） ─────────────────────────

/// 某一年的國定假日。
final holidaysProvider = FutureProvider.autoDispose.family<HolidayYear, int>((ref, year) async {
  final api = ref.watch(apiClientProvider);
  return HolidayYear.fromJson(await api.getAdminHolidays(year));
});

/// 某位員工的特休餘額與調整紀錄（參數是員工 id）。
final employeeLeaveBalanceProvider =
    FutureProvider.autoDispose.family<EmployeeLeaveBalance, String>((ref, employeeId) async {
  final api = ref.watch(apiClientProvider);
  return EmployeeLeaveBalance.fromJson(await api.getEmployeeLeaveBalance(employeeId));
});

// ───────────────────────── 審計日誌 ─────────────────────────

/// 審計日誌篩選條件。[from] / [to] 為 `YYYY-MM-DD`（本機日期），送出時轉成 ISO 時間。
class AuditFilter {
  const AuditFilter({this.from, this.to, this.action = '', this.actorId});

  final String? from;
  final String? to;
  final String action;
  final String? actorId;
}

class AuditState {
  const AuditState({
    this.items = const [],
    this.nextCursor,
    this.loading = false,
    this.error,
    this.filter = const AuditFilter(),
  });

  final List<AuditEntry> items;
  final String? nextCursor;
  final bool loading;
  final String? error;
  final AuditFilter filter;

  bool get hasMore => nextCursor != null;
}

/// 累積式分頁：第一頁由 [load] 載入，「載入更多」用 `nextCursor` 接續。
class AuditController extends StateNotifier<AuditState> {
  AuditController(this._api, this._workspaceId) : super(const AuditState());

  final ApiClient _api;
  final String _workspaceId;

  // 篩選條件變更後，舊請求的回應要丟掉。
  int _generation = 0;

  Future<void> load([AuditFilter? filter]) async {
    final f = filter ?? state.filter;
    final gen = ++_generation;
    state = AuditState(loading: true, filter: f);
    await _fetch(f, null, gen, const []);
  }

  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loading) return;
    final gen = ++_generation;
    final f = state.filter;
    final prev = state.items;
    state = AuditState(items: prev, nextCursor: cursor, loading: true, filter: f);
    await _fetch(f, cursor, gen, prev);
  }

  Future<void> _fetch(AuditFilter f, String? cursor, int gen, List<AuditEntry> prev) async {
    try {
      final json = await _api.getAuditLogs(
        _workspaceId,
        from: _dayStartIso(f.from),
        to: _nextDayStartIso(f.to),
        action: f.action,
        actorId: f.actorId,
        cursor: cursor,
      );
      if (gen != _generation || !mounted) return;
      final page = AuditResponse.fromJson(json);
      state = AuditState(
        items: [...prev, ...page.items],
        nextCursor: page.nextCursor,
        filter: f,
      );
    } catch (e) {
      if (gen != _generation || !mounted) return;
      state = AuditState(
        items: prev,
        nextCursor: cursor,
        filter: f,
        error: adminErrorMessage(e),
      );
    }
  }
}

/// `YYYY-MM-DD`（本機）→ 當天 00:00 的 UTC ISO。
String? _dayStartIso(String? day) {
  if (day == null || !isValidDateString(day)) return null;
  final p = day.split('-').map(int.parse).toList();
  return DateTime(p[0], p[1], p[2]).toUtc().toIso8601String();
}

/// `to` 在後端是「不含」，所以選到某天就送隔天 00:00，讓那一天整天都算進去。
String? _nextDayStartIso(String? day) {
  if (day == null || !isValidDateString(day)) return null;
  final p = day.split('-').map(int.parse).toList();
  return DateTime(p[0], p[1], p[2] + 1).toUtc().toIso8601String();
}

final auditControllerProvider = StateNotifierProvider.autoDispose.family<AuditController, AuditState, String>(
  (ref, workspaceId) => AuditController(ref.watch(apiClientProvider), workspaceId),
);
