import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final whiteboardsProvider = FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getWhiteboards(workspaceId);
});

final whiteboardProvider = FutureProvider.family<Map<String, dynamic>, String>((ref, boardId) async {
  final api = ref.watch(apiClientProvider);
  return api.getWhiteboard(boardId);
});
