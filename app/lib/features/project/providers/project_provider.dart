import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final projectsProvider = FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getProjects(workspaceId);
});

final boardProvider = FutureProvider.family<Map<String, dynamic>, String>((ref, projectId) async {
  final api = ref.watch(apiClientProvider);
  return api.getProject(projectId);
});

final taskProvider = FutureProvider.family<Map<String, dynamic>, String>((ref, taskId) async {
  final api = ref.watch(apiClientProvider);
  return api.getTask(taskId);
});
