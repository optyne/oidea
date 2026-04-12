import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

/// 未登入或請求失敗時回傳空列表（避免與 [authStateProvider] 循環依賴）。
final workspacesProvider = FutureProvider<List<dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    return await api.getWorkspaces();
  } catch (_) {
    return [];
  }
});

final currentWorkspaceIdProvider = StateProvider<String?>((ref) => null);
