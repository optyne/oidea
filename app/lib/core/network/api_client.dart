import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'dev_backend_urls.dart';

/// NestJS 使用 `setGlobalPrefix('api')`。若 `API_URL` 只寫到埠號（例如 `http://localhost:3001`），
/// Dio 會請求 `/auth/login` 而得到 404；應為 `/api/auth/login`。
///
/// **尾隨 `/` 必填**：Dio 用 `Uri.resolve` 合併路徑；若 base 為 `.../api` 而無 `/`，
/// 相對路徑 `auth/login` 會變成 `.../apiauth/login`（錯誤）。
String nestApiBaseUrl(String raw) {
  final trimmed = raw.trim();
  late final String resolved;
  if (trimmed.isEmpty) {
    resolved = defaultDevRestBaseUrl();
  } else {
    final uri = trimmed.contains('://') ? Uri.parse(trimmed) : Uri.parse('http://$trimmed');
    var path = uri.path;
    while (path.endsWith('/') && path.isNotEmpty) {
      path = path.substring(0, path.length - 1);
    }
    if (path.isEmpty || path == '/') {
      resolved = uri.replace(path: '/api').toString();
    } else if (path == '/api') {
      resolved = uri.replace(path: '/api').toString();
    } else {
      resolved = uri.toString();
    }
  }
  if (resolved.endsWith('/')) {
    return resolved;
  }
  return '$resolved/';
}

final apiClientProvider = Provider<ApiClient>((ref) {
  const apiUrlEnv = String.fromEnvironment('API_URL', defaultValue: '');
  final rawBase = apiUrlEnv.isNotEmpty ? apiUrlEnv : (devBackendRestBaseFromHostDefine() ?? '');
  final dio = Dio(
    BaseOptions(
      baseUrl: nestApiBaseUrl(rawBase),
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ),
  );
  dio.interceptors.add(AuthInterceptor());
  return ApiClient(dio);
});

class AuthInterceptor extends Interceptor {
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'access_token';
  static const _refreshKey = 'refresh_token';

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _storage.read(key: _tokenKey);
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode == 401) {
      final refreshToken = await _storage.read(key: _refreshKey);
      if (refreshToken != null) {
        try {
          final refreshDio = Dio(
            BaseOptions(
              baseUrl: err.requestOptions.baseUrl,
              connectTimeout: const Duration(seconds: 15),
            ),
          );
          final response = await refreshDio.post<Map<String, dynamic>>(
            'auth/refresh',
            options: Options(headers: {'Authorization': 'Bearer $refreshToken'}),
          );
          final newToken = response.data?['accessToken'] as String?;
          final newRefresh = response.data?['refreshToken'] as String?;
          if (newToken != null) {
            await _storage.write(key: _tokenKey, value: newToken);
            if (newRefresh != null) {
              await _storage.write(key: _refreshKey, value: newRefresh);
            }
            final retry = Dio(
              BaseOptions(
                baseUrl: err.requestOptions.baseUrl,
                connectTimeout: const Duration(seconds: 15),
                receiveTimeout: const Duration(seconds: 15),
              ),
            );
            err.requestOptions.headers['Authorization'] = 'Bearer $newToken';
            final retryResponse = await retry.fetch(err.requestOptions);
            return handler.resolve(retryResponse);
          }
        } catch (_) {
          await _storage.deleteAll();
        }
      }
    }
    handler.next(err);
  }
}

class ApiClient {
  ApiClient(this._dio);

  final Dio _dio;

  Future<Map<String, dynamic>> register(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('auth/register', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> login(String email, String password) async {
    final res = await _dio.post<Map<String, dynamic>>('auth/login', data: {'email': email, 'password': password});
    return res.data!;
  }

  Future<Map<String, dynamic>> getMe() async {
    final res = await _dio.get<Map<String, dynamic>>('users/me');
    return res.data!;
  }

  Future<List<dynamic>> getChannels(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('channels', queryParameters: {'workspaceId': workspaceId});
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getChannel(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('channels/$id');
    return res.data!;
  }

  Future<List<dynamic>> getMessages(String channelId) async {
    final res = await _dio.get<List<dynamic>>('messages/channel/$channelId');
    return res.data ?? [];
  }

  Future<List<dynamic>> getThread(String parentId) async {
    final res = await _dio.get<List<dynamic>>('messages/thread/$parentId');
    return res.data ?? [];
  }

  Future<List<dynamic>> getProjects(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('projects/workspace/$workspaceId');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getProject(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('projects/$id');
    return res.data!;
  }

  Future<Map<String, dynamic>> getTask(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('tasks/$id');
    return res.data!;
  }

  Future<Map<String, dynamic>> getUnreadCount() async {
    final res = await _dio.get<Map<String, dynamic>>('notifications/unread-count');
    return res.data ?? {};
  }

  Future<List<dynamic>> getWhiteboards(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('whiteboard/workspace/$workspaceId');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getWhiteboard(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('whiteboard/$id');
    return res.data!;
  }

  Future<void> addComment(String taskId, String content) async {
    await _dio.post('tasks/$taskId/comments', data: {'content': content});
  }

  Future<void> addSubtask(String taskId, String title) async {
    await _dio.post('tasks/$taskId/subtasks', data: {'title': title});
  }

  Future<List<dynamic>> getMeetings(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('meetings/workspace/$workspaceId');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getMeeting(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('meetings/$id');
    return res.data!;
  }

  Future<Map<String, dynamic>> createProject(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('projects', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> createMeeting(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('meetings', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> createWhiteboard(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('whiteboard', data: body);
    return res.data!;
  }

  Future<void> deleteWhiteboard(String id) async {
    await _dio.delete('whiteboard/$id');
  }

  Future<List<dynamic>> getWorkspaces() async {
    final res = await _dio.get<List<dynamic>>('workspaces');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> createWorkspace(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('workspaces', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> createChannel(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('channels', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> createMessage(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('messages', data: body);
    return res.data!;
  }

  Future<List<dynamic>> searchMessages(String channelId, String query) async {
    final res = await _dio.get<List<dynamic>>(
      'messages/search/$channelId',
      queryParameters: {'q': query},
    );
    return res.data ?? [];
  }

  Future<void> addMessageReaction(String messageId, String emoji) async {
    await _dio.post('messages/$messageId/reactions', data: {'emoji': emoji});
  }

  Future<void> removeMessageReaction(String messageId, String emoji) async {
    final enc = Uri.encodeComponent(emoji);
    await _dio.delete('messages/$messageId/reactions/$enc');
  }

  Future<Map<String, dynamic>> updateMessage(String id, String content) async {
    final res = await _dio.put<Map<String, dynamic>>('messages/$id', data: {'content': content});
    return res.data!;
  }

  Future<void> deleteMessage(String id) async {
    await _dio.delete('messages/$id');
  }

  Future<Map<String, dynamic>> createTask(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('tasks', data: body);
    return res.data!;
  }

  Future<void> moveTask(String taskId, {required String columnId, required int position}) async {
    await _dio.put('tasks/$taskId/move', data: {'columnId': columnId, 'position': position});
  }

  Future<Map<String, dynamic>> addProjectColumn(String projectId, Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('projects/$projectId/columns', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> updateTask(String taskId, Map<String, dynamic> body) async {
    final res = await _dio.put<Map<String, dynamic>>('tasks/$taskId', data: body);
    return res.data!;
  }

  Future<void> deleteTask(String taskId) async {
    await _dio.delete('tasks/$taskId');
  }

  Future<Map<String, dynamic>> toggleSubtask(String subtaskId) async {
    final res = await _dio.put<Map<String, dynamic>>('tasks/subtasks/$subtaskId/toggle');
    return res.data!;
  }

  Future<Map<String, dynamic>> addSubtaskItem(String taskId, String title) async {
    final res = await _dio.post<Map<String, dynamic>>('tasks/$taskId/subtasks', data: {'title': title});
    return res.data!;
  }

  Future<Map<String, dynamic>> updateUserProfile(Map<String, dynamic> body) async {
    final res = await _dio.put<Map<String, dynamic>>('users/me', data: body);
    return res.data!;
  }

  Future<List<dynamic>> searchUsers(String query, {String? workspaceId}) async {
    final res = await _dio.get<List<dynamic>>(
      'users/search',
      queryParameters: {'q': query, if (workspaceId != null) 'workspaceId': workspaceId},
    );
    return res.data ?? [];
  }

  Future<List<dynamic>> getNotifications({bool unreadOnly = false}) async {
    final res = await _dio.get<List<dynamic>>(
      'notifications',
      queryParameters: unreadOnly ? {'unread': 'true'} : null,
    );
    return res.data ?? [];
  }

  Future<void> markNotificationRead(String id) async {
    await _dio.put('notifications/$id/read');
  }

  Future<void> markAllNotificationsRead() async {
    await _dio.post('notifications/read-all');
  }

  Future<void> pinMessage(String id) async {
    await _dio.put('messages/$id/pin');
  }

  Future<void> unpinMessage(String id) async {
    await _dio.put('messages/$id/unpin');
  }

  Future<List<dynamic>> getPinnedMessages(String channelId) async {
    final res = await _dio.get<List<dynamic>>('messages/channel/$channelId/pinned');
    return res.data ?? [];
  }

  // ─────────────────────── 知識庫（Notion 風）───────────────────────

  Future<Map<String, dynamic>> createKnowledgePage(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('knowledge/pages', data: body);
    return res.data!;
  }

  Future<List<dynamic>> getKnowledgePages(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('knowledge/pages/workspace/$workspaceId');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getKnowledgePage(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('knowledge/pages/$id');
    return res.data!;
  }

  Future<Map<String, dynamic>> updateKnowledgePage(
    String id,
    Map<String, dynamic> body,
  ) async {
    final res = await _dio.put<Map<String, dynamic>>('knowledge/pages/$id', data: body);
    return res.data!;
  }

  Future<void> deleteKnowledgePage(String id) async {
    await _dio.delete('knowledge/pages/$id');
  }

  Future<List<dynamic>> replaceBlocks(String pageId, List<Map<String, dynamic>> blocks) async {
    final res = await _dio.put<List<dynamic>>(
      'knowledge/pages/$pageId/blocks',
      data: {'blocks': blocks},
    );
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> createDatabase(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('knowledge/databases', data: body);
    return res.data!;
  }

  Future<Map<String, dynamic>> createFinanceLog(String workspaceId, {String? parentId}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'knowledge/databases/finance-log',
      data: {'workspaceId': workspaceId, if (parentId != null) 'parentId': parentId},
    );
    return res.data!;
  }

  Future<List<dynamic>> getDatabaseRows(String databaseId) async {
    final res = await _dio.get<List<dynamic>>('knowledge/databases/$databaseId/rows');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> createDatabaseRow(
    String databaseId,
    Map<String, dynamic> values,
  ) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'knowledge/databases/$databaseId/rows',
      data: {'values': values},
    );
    return res.data!;
  }

  Future<Map<String, dynamic>> updateDatabaseRow(
    String rowId,
    Map<String, dynamic> values,
  ) async {
    final res = await _dio.put<Map<String, dynamic>>(
      'knowledge/rows/$rowId',
      data: {'values': values},
    );
    return res.data!;
  }

  Future<void> deleteDatabaseRow(String rowId) async {
    await _dio.delete('knowledge/rows/$rowId');
  }

  Future<Map<String, dynamic>> getFinanceSummary(
    String databaseId,
    String yearMonth,
  ) async {
    final res = await _dio.get<Map<String, dynamic>>(
      'knowledge/databases/$databaseId/finance-summary',
      queryParameters: {'yearMonth': yearMonth},
    );
    return res.data!;
  }

  // ─────────────────── 知識庫：ACL ───────────────────

  /// 當前使用者對此頁面的有效存取層級：view / edit / full / null。
  Future<Map<String, dynamic>> getPageAccess(String pageId) async {
    final res = await _dio.get<Map<String, dynamic>>('knowledge/pages/$pageId/access');
    return res.data!;
  }

  /// 明確分享清單。
  Future<List<dynamic>> listPagePermissions(String pageId) async {
    final res = await _dio.get<List<dynamic>>('knowledge/pages/$pageId/permissions');
    return res.data ?? [];
  }

  /// 新增或更新一條分享（userId 或 role 擇一）。
  Future<Map<String, dynamic>> sharePage(
    String pageId, {
    String? userId,
    String? role,
    required String access,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'knowledge/pages/$pageId/permissions',
      data: {
        if (userId != null) 'userId': userId,
        if (role != null) 'role': role,
        'access': access,
      },
    );
    return res.data!;
  }

  Future<void> removePagePermission(String pageId, String permissionId) async {
    await _dio.delete('knowledge/pages/$pageId/permissions/$permissionId');
  }

  /// 變更頁面可見性。
  Future<Map<String, dynamic>> updatePageVisibility(
    String pageId, {
    required String visibility,
    bool? inheritParentAcl,
  }) async {
    final res = await _dio.put<Map<String, dynamic>>(
      'knowledge/pages/$pageId/visibility',
      data: {
        'visibility': visibility,
        if (inheritParentAcl != null) 'inheritParentAcl': inheritParentAcl,
      },
    );
    return res.data!;
  }

  // ─────────────────────── ERP：權限／成員 ───────────────────────

  Future<List<dynamic>> getWorkspaceMembers(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('workspaces/$workspaceId/members');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> updateMemberRole(
    String workspaceId,
    String userId,
    String role,
  ) async {
    final res = await _dio.put<Map<String, dynamic>>(
      'workspaces/$workspaceId/members/$userId/role',
      data: {'role': role},
    );
    return res.data!;
  }

  /// 以 email 或 username 邀請既有使用者加入工作空間。對方未註冊會回 404。
  Future<Map<String, dynamic>> inviteMemberByIdentifier(
    String workspaceId, {
    required String identifier,
    String role = 'member',
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'workspaces/$workspaceId/members',
      data: {'identifier': identifier, 'role': role},
    );
    return res.data!;
  }

  Future<void> removeMember(String workspaceId, String userId) async {
    await _dio.delete('workspaces/$workspaceId/members/$userId');
  }

  // ─────────────────────── 工作空間邀請連結 ───────────────────────

  /// 管理端：建邀請連結，回傳含 token 的記錄。
  Future<Map<String, dynamic>> createWorkspaceInvite(
    String workspaceId, {
    String? email,
    String role = 'member',
    int expiresInDays = 7,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'workspaces/$workspaceId/invites',
      data: {
        if (email != null && email.isNotEmpty) 'email': email,
        'role': role,
        'expiresInDays': expiresInDays,
      },
    );
    return res.data!;
  }

  Future<List<dynamic>> listWorkspaceInvites(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('workspaces/$workspaceId/invites');
    return res.data ?? [];
  }

  Future<void> revokeWorkspaceInvite(String workspaceId, String inviteId) async {
    await _dio.delete('workspaces/$workspaceId/invites/$inviteId');
  }

  /// 使用者端：無需登入就能 peek 邀請內容（landing page 用）。
  Future<Map<String, dynamic>> peekInvite(String token) async {
    final res = await _dio.get<Map<String, dynamic>>('invites/$token');
    return res.data!;
  }

  /// 使用者端：接受邀請（需登入）。
  Future<Map<String, dynamic>> acceptInvite(String token) async {
    final res = await _dio.post<Map<String, dynamic>>('invites/$token/accept');
    return res.data!;
  }

  // ─────────────────────── ERP：費用報銷 ───────────────────────

  Future<Map<String, dynamic>> createExpense(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('expenses', data: body);
    return res.data!;
  }

  Future<List<dynamic>> getExpenses(String workspaceId, {String? status}) async {
    final res = await _dio.get<List<dynamic>>(
      'expenses/workspace/$workspaceId',
      queryParameters: status == null ? null : {'status': status},
    );
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getExpenseStats(String workspaceId) async {
    final res = await _dio.get<Map<String, dynamic>>('expenses/workspace/$workspaceId/stats');
    return res.data!;
  }

  Future<Map<String, dynamic>> getExpense(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('expenses/$id');
    return res.data!;
  }

  Future<Map<String, dynamic>> approveExpense(String id, {String? comment}) async {
    final res = await _dio.put<Map<String, dynamic>>(
      'expenses/$id/approve',
      data: {'comment': comment},
    );
    return res.data!;
  }

  Future<Map<String, dynamic>> rejectExpense(String id, String reason) async {
    final res = await _dio.put<Map<String, dynamic>>(
      'expenses/$id/reject',
      data: {'reason': reason},
    );
    return res.data!;
  }

  Future<Map<String, dynamic>> markExpensePaid(String id) async {
    final res = await _dio.put<Map<String, dynamic>>('expenses/$id/paid');
    return res.data!;
  }

  Future<void> cancelExpense(String id) async {
    await _dio.delete('expenses/$id');
  }

  Future<Map<String, dynamic>> addExpenseReceipt(
    String id,
    Map<String, dynamic> receiptData,
  ) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'expenses/$id/receipts',
      data: receiptData,
    );
    return res.data!;
  }

  // ─────────────────────── ERP：考勤打卡 ───────────────────────

  Future<Map<String, dynamic>> checkIn(
    String workspaceId, {
    String? location,
    String? note,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'attendance/check-in',
      data: {
        'workspaceId': workspaceId,
        if (location != null) 'location': location,
        if (note != null) 'note': note,
      },
    );
    return res.data!;
  }

  Future<Map<String, dynamic>> checkOut(
    String workspaceId, {
    String? location,
    String? note,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'attendance/check-out',
      data: {
        'workspaceId': workspaceId,
        if (location != null) 'location': location,
        if (note != null) 'note': note,
      },
    );
    return res.data!;
  }

  Future<Map<String, dynamic>?> getTodayAttendance(String workspaceId) async {
    final res = await _dio.get<dynamic>(
      'attendance/today',
      queryParameters: {'workspaceId': workspaceId},
    );
    final data = res.data;
    if (data == null || data == '') return null;
    if (data is Map<String, dynamic>) return data;
    return null;
  }

  Future<List<dynamic>> getMyAttendance(
    String workspaceId, {
    required String from,
    required String to,
  }) async {
    final res = await _dio.get<List<dynamic>>(
      'attendance/me',
      queryParameters: {'workspaceId': workspaceId, 'from': from, 'to': to},
    );
    return res.data ?? [];
  }

  Future<List<dynamic>> getAttendanceReport(
    String workspaceId, {
    required String from,
    required String to,
  }) async {
    final res = await _dio.get<List<dynamic>>(
      'attendance/workspace/$workspaceId/report',
      queryParameters: {'from': from, 'to': to},
    );
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> createLeave(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('attendance/leaves', data: body);
    return res.data!;
  }

  Future<List<dynamic>> getLeaves(String workspaceId, {String? status}) async {
    final res = await _dio.get<List<dynamic>>(
      'attendance/leaves/workspace/$workspaceId',
      queryParameters: status == null ? null : {'status': status},
    );
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> approveLeave(String id) async {
    final res = await _dio.put<Map<String, dynamic>>('attendance/leaves/$id/approve');
    return res.data!;
  }

  Future<Map<String, dynamic>> rejectLeave(String id, {String? reason}) async {
    final res = await _dio.put<Map<String, dynamic>>(
      'attendance/leaves/$id/reject',
      data: {'reason': reason},
    );
    return res.data!;
  }

  Future<void> cancelLeave(String id) async {
    await _dio.delete('attendance/leaves/$id');
  }

  /// 檔案庫頁面 —— 依類別 / 關鍵字 / 分頁取得檔案清單。
  /// 回傳 `{items: [...], total: N, limit, offset}`。
  Future<Map<String, dynamic>> browseWorkspaceFiles(
    String workspaceId, {
    String type = 'all',
    String search = '',
    int limit = 50,
    int offset = 0,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      'files/workspace/$workspaceId/browse',
      queryParameters: {
        'type': type,
        if (search.isNotEmpty) 'search': search,
        'limit': limit,
        'offset': offset,
      },
    );
    return res.data!;
  }

  Future<void> deleteFile(String id) async {
    await _dio.delete('files/$id');
  }

  /// 上傳檔案至 MinIO 並同時寫入 File 表；帶 [messageId] 或 [taskId] 以建立關聯。
  Future<Map<String, dynamic>> uploadFile({
    required String workspaceId,
    required List<int> bytes,
    required String fileName,
    String? messageId,
    String? taskId,
  }) async {
    final form = FormData.fromMap({
      'file': MultipartFile.fromBytes(bytes, filename: fileName),
    });
    final res = await _dio.post<Map<String, dynamic>>(
      'files/upload',
      data: form,
      queryParameters: {
        'workspaceId': workspaceId,
        if (messageId != null) 'messageId': messageId,
        if (taskId != null) 'taskId': taskId,
      },
    );
    return res.data!;
  }
}
