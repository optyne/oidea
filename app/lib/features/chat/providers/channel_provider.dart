import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final channelsProvider = FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getChannels(workspaceId);
});

final channelProvider = FutureProvider.family<Map<String, dynamic>, String>((ref, channelId) async {
  final api = ref.watch(apiClientProvider);
  return api.getChannel(channelId);
});

final currentChannelIdProvider = StateProvider<String?>((ref) => null);
