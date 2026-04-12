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

final typingUsersProvider = StateProvider<Map<String, List<String>>>((ref) => {});
