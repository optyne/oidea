import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';

// ─────────── 成員與角色 ───────────

final workspaceMembersProvider =
    FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getWorkspaceMembers(workspaceId);
});

// ─────────── 費用報銷 ───────────

class ExpenseListKey {
  final String workspaceId;
  final String? status;
  const ExpenseListKey(this.workspaceId, this.status);

  @override
  bool operator ==(Object other) =>
      other is ExpenseListKey &&
      other.workspaceId == workspaceId &&
      other.status == status;

  @override
  int get hashCode => Object.hash(workspaceId, status);
}

final expensesProvider =
    FutureProvider.family<List<dynamic>, ExpenseListKey>((ref, key) async {
  final api = ref.watch(apiClientProvider);
  return api.getExpenses(key.workspaceId, status: key.status);
});

final expenseStatsProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getExpenseStats(workspaceId);
});

// ─────────── 考勤 ───────────

final todayAttendanceProvider =
    FutureProvider.family<Map<String, dynamic>?, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getTodayAttendance(workspaceId);
});

class AttendanceRangeKey {
  final String workspaceId;
  final String from;
  final String to;
  const AttendanceRangeKey(this.workspaceId, this.from, this.to);

  @override
  bool operator ==(Object other) =>
      other is AttendanceRangeKey &&
      other.workspaceId == workspaceId &&
      other.from == from &&
      other.to == to;

  @override
  int get hashCode => Object.hash(workspaceId, from, to);
}

final myAttendanceProvider =
    FutureProvider.family<List<dynamic>, AttendanceRangeKey>((ref, key) async {
  final api = ref.watch(apiClientProvider);
  return api.getMyAttendance(key.workspaceId, from: key.from, to: key.to);
});

final leavesProvider =
    FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getLeaves(workspaceId);
});
