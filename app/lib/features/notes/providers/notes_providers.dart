import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';

/// 工作空間的所有 page（扁平清單，含 parentId；UI 自行組樹）。
final workspacePagesProvider =
    FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getKnowledgePages(workspaceId);
});

/// 單一 page（含 blocks 與 database 定義）。
final pageDetailProvider =
    FutureProvider.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(apiClientProvider);
  return api.getKnowledgePage(id);
});

/// 資料庫的 rows。
final databaseRowsProvider =
    FutureProvider.family<List<dynamic>, String>((ref, databaseId) async {
  final api = ref.watch(apiClientProvider);
  return api.getDatabaseRows(databaseId);
});

/// 目前選中的 page id。
final selectedPageIdProvider = StateProvider<String?>((ref) => null);

class FinanceSummaryKey {
  final String databaseId;
  final String yearMonth;
  const FinanceSummaryKey(this.databaseId, this.yearMonth);

  @override
  bool operator ==(Object o) =>
      o is FinanceSummaryKey &&
      o.databaseId == databaseId &&
      o.yearMonth == yearMonth;
  @override
  int get hashCode => Object.hash(databaseId, yearMonth);
}

final financeSummaryProvider =
    FutureProvider.family<Map<String, dynamic>, FinanceSummaryKey>((ref, key) async {
  final api = ref.watch(apiClientProvider);
  return api.getFinanceSummary(key.databaseId, key.yearMonth);
});
