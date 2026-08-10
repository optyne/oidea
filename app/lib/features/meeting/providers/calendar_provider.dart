import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final calendarTasksProvider =
    FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getCalendarTasks(workspaceId);
});
