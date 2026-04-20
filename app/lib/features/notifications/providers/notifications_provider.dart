import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';

/// 每 15 秒輪詢一次未讀數；登出後自動停止（authStateProvider 觸發重建）。
final unreadNotificationCountProvider = StreamProvider<int>((ref) async* {
  final api = ref.watch(apiClientProvider);
  Future<int> fetch() async {
    try {
      final data = await api.getUnreadCount();
      final count = data['count'];
      if (count is int) return count;
      if (count is String) return int.tryParse(count) ?? 0;
      return 0;
    } catch (_) {
      return 0;
    }
  }

  yield await fetch();
  final timer = Stream.periodic(const Duration(seconds: 15));
  await for (final _ in timer) {
    yield await fetch();
  }
});

/// 通知列表；手動 refresh 或標記已讀後 invalidate。
final notificationsListProvider = FutureProvider<List<dynamic>>((ref) async {
  final api = ref.watch(apiClientProvider);
  return api.getNotifications();
});
