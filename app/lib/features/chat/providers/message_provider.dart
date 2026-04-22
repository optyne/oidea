import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final messagesProvider = FutureProvider.family<List<dynamic>, String>((ref, channelId) async {
 final api = ref.watch(apiClientProvider);
  return api.getMessages(channelId);
});

final threadProvider = FutureProvider.family<List<dynamic>, String>((ref, parentId) async {
 final api = ref.watch(apiClientProvider);
  return api.getThread(parentId);
});

/// C-13 置頂訊息清單(後端原始 pinnedMessage 陣列)。
final pinnedMessagesProvider =
    FutureProvider.family<List<dynamic>, String>((ref, channelId) async {
  final api = ref.watch(apiClientProvider);
  return api.getPinnedMessages(channelId);
});

/// 對齊 prototype:每則訊息能快速查自己是否置頂。由 pinnedMessagesProvider 衍生。
final pinnedIdsProvider = Provider.family<Set<String>, String>((ref, channelId) {
  final async = ref.watch(pinnedMessagesProvider(channelId));
  final list = async.value ?? const [];
  final ids = <String>{};
  for (final item in list) {
    if (item is! Map) continue;
    final direct = item['messageId'] as String?;
    if (direct != null) {
      ids.add(direct);
      continue;
    }
    final nested = item['message'];
    if (nested is Map) {
      final id = nested['id'] as String?;
      if (id != null) ids.add(id);
    }
  }
  return ids;
});

final typingUsersProvider = StateProvider<Map<String, List<String>>>((ref) => {});
