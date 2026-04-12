import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

final meetingsProvider = FutureProvider.family<List<dynamic>, String>((ref, workspaceId) async {
  final api = ref.watch(apiClientProvider);
  return api.getMeetings(workspaceId);
});

final meetingProvider = FutureProvider.family<Map<String, dynamic>, String>((ref, meetingId) async {
  final api = ref.watch(apiClientProvider);
  return api.getMeeting(meetingId);
});
