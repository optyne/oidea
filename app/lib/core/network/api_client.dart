import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_session.dart';
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

String resolvedRestBaseUrl() {
  const apiUrlEnv = String.fromEnvironment('API_URL', defaultValue: '');
  final rawBase = apiUrlEnv.isNotEmpty ? apiUrlEnv : (devBackendRestBaseFromHostDefine() ?? '');
  return nestApiBaseUrl(rawBase);
}

/// Token pair + refresh/logout calls. The refresh Dio has no interceptors.
final authSessionProvider = Provider<AuthSession>((ref) {
  final session = AuthSession(
    store: const SecureTokenStore(),
    refreshDio: Dio(
      BaseOptions(
        baseUrl: resolvedRestBaseUrl(),
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 15),
      ),
    ),
  );
  ref.onDispose(session.dispose);
  return session;
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final dio = Dio(
    BaseOptions(
      baseUrl: resolvedRestBaseUrl(),
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ),
  );
  dio.interceptors.add(AuthInterceptor(ref.watch(authSessionProvider), dio));
  return ApiClient(dio);
});

/// Attaches the access token and, on 401, refreshes once and retries once.
///
/// Concurrent 401s share one refresh ([AuthSession.refresh] is single-flight).
/// A request that failed with a token that has since been replaced is retried
/// with the new token without another refresh. Auth endpoints are never
/// refreshed-and-retried, so a 401 from `auth/refresh` cannot loop.
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._session, this._retryDio);

  final AuthSession _session;

  /// Dio used for the single retry (normally the same Dio this interceptor is
  /// attached to, so [onRequest] attaches the latest token).
  final Dio _retryDio;

  static const retriedKey = 'auth_retried';
  static const _noRefreshPaths = {
    'auth/login',
    'auth/register',
    'auth/refresh',
    'auth/logout',
    'auth/config',
    'auth/oidc/exchange',
  };

  static bool _isAuthEndpoint(RequestOptions o) {
    var path = o.path;
    while (path.startsWith('/')) {
      path = path.substring(1);
    }
    return _noRefreshPaths.any((p) => path == p || path.endsWith('/$p'));
  }

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _session.store.readAccessToken();
    if (token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    final req = err.requestOptions;
    if (err.response?.statusCode != 401 || req.extra[retriedKey] == true || _isAuthEndpoint(req)) {
      return handler.next(err);
    }

    final sent = req.headers['Authorization'];
    final current = await _session.store.readAccessToken();
    String? token;
    if (current != null && sent != 'Bearer $current') {
      // Someone else already refreshed while this request was in flight.
      token = current;
    } else {
      token = await _session.refresh();
    }
    if (token == null) {
      // A transient refresh failure (e.g. 429 from auth/refresh) is reported as
      // itself, not as the original 401: the session is still alive.
      final refreshError = _session.lastRefreshError;
      if (refreshError != null) {
        return handler.next(DioException(
          requestOptions: req,
          response: refreshError.response,
          type: refreshError.type,
          error: refreshError.error,
          message: refreshError.message,
        ));
      }
      return handler.next(err);
    }

    try {
      req.extra[retriedKey] = true;
      req.headers['Authorization'] = 'Bearer $token';
      final response = await _retryDio.fetch<dynamic>(req);
      return handler.resolve(response);
    } on DioException catch (e) {
      return handler.next(e);
    }
  }
}

class ApiClient {
  ApiClient(this._dio);

  final Dio _dio;

  @visibleForTesting
  Dio get dio => _dio;

  /// Public login options: `{sso, passwordLogin, breakGlass, endSessionUrl?}`.
  Future<Map<String, dynamic>> getAuthConfig() async {
    final res = await _dio.get<Map<String, dynamic>>('auth/config');
    return res.data ?? const {};
  }

  /// Exchanges a one-time SSO ticket (bound to the PKCE challenge sent to
  /// `auth/oidc/start`) for the usual `{accessToken, refreshToken, user}`.
  /// The body holds secrets: never log it.
  Future<Map<String, dynamic>> exchangeOidcTicket({
    required String ticket,
    required String appVerifier,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'auth/oidc/exchange',
      data: {'ticket': ticket, 'app_verifier': appVerifier},
    );
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

  /// 全域搜尋：跨 messages / tasks / pages / files 做模糊比對。
  Future<Map<String, dynamic>> search({
    required String workspaceId,
    required String query,
    int limit = 5,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      'search',
      queryParameters: {
        'workspaceId': workspaceId,
        'q': query,
        'limit': limit,
      },
    );
    return res.data ?? {};
  }

  // ─────────────────────── 提醒 ───────────────────────

  Future<List<dynamic>> getReminders(String workspaceId, {bool includeCompleted = false}) async {
    final res = await _dio.get<List<dynamic>>(
      'reminders',
      queryParameters: {
        'workspaceId': workspaceId,
        if (includeCompleted) 'includeCompleted': 'true',
      },
    );
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> createReminder({
    required String workspaceId,
    required String title,
    required DateTime triggerAt,
    String? notes,
    String recurrence = 'none',
    int recurrenceInterval = 1,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'reminders',
      data: {
        'workspaceId': workspaceId,
        'title': title,
        'triggerAt': triggerAt.toUtc().toIso8601String(),
        if (notes != null && notes.isNotEmpty) 'notes': notes,
        'recurrence': recurrence,
        'recurrenceInterval': recurrenceInterval,
      },
    );
    return res.data!;
  }

  Future<void> pauseReminder(String id) async {
    await _dio.post('reminders/$id/pause');
  }

  Future<void> resumeReminder(String id) async {
    await _dio.post('reminders/$id/resume');
  }

  Future<void> completeReminder(String id) async {
    await _dio.post('reminders/$id/complete');
  }

  Future<void> deleteReminder(String id) async {
    await _dio.delete('reminders/$id');
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

  // ─────────────────────── 試算表 ───────────────────────

  Future<List<dynamic>> getSpreadsheets(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>('spreadsheets/workspace/$workspaceId');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getSpreadsheet(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('spreadsheets/$id');
    return res.data!;
  }

  Future<Map<String, dynamic>> createSpreadsheet({
    required String workspaceId,
    required String title,
    String? description,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'spreadsheets',
      data: {'workspaceId': workspaceId, 'title': title, if (description != null) 'description': description},
    );
    return res.data!;
  }

  Future<void> updateSpreadsheetMeta(String id, {String? title, String? description}) async {
    await _dio.put('spreadsheets/$id', data: {
      if (title != null) 'title': title,
      if (description != null) 'description': description,
    });
  }

  Future<void> saveSpreadsheetData(String id, Map<String, dynamic> data) async {
    await _dio.put('spreadsheets/$id/data', data: {'data': data});
  }

  Future<void> deleteSpreadsheet(String id) async {
    await _dio.delete('spreadsheets/$id');
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

  /// 把 canvas items（不透明 JSON 陣列）整份覆寫到 server。
  /// 前端約每 1.5 秒 debounce 呼叫；dispose 時也要 flush。
  Future<void> saveWhiteboardCanvas(String boardId, List<Map<String, dynamic>> items) async {
    await _dio.put('whiteboard/$boardId/canvas', data: {'items': items});
  }

  // ── 白板筆記本頁面（PencilKit）────────────────────────────────

  Future<List<dynamic>> getWhiteboardPages(String boardId) async {
    final res = await _dio.get<List<dynamic>>('whiteboard/$boardId/pages');
    return res.data ?? [];
  }

  Future<Map<String, dynamic>> getWhiteboardPage(String boardId, String pageId) async {
    final res = await _dio.get<Map<String, dynamic>>('whiteboard/$boardId/pages/$pageId');
    return res.data ?? {};
  }

  Future<Map<String, dynamic>> createWhiteboardPage(String boardId) async {
    final res = await _dio.post<Map<String, dynamic>>('whiteboard/$boardId/pages');
    return res.data ?? {};
  }

  Future<void> saveWhiteboardPage(
    String boardId,
    String pageId, {
    required String drawingBase64,
    String? thumbnailBase64,
  }) async {
    await _dio.put('whiteboard/$boardId/pages/$pageId', data: {
      'drawing': drawingBase64,
      if (thumbnailBase64 != null) 'thumbnail': thumbnailBase64,
    });
  }

  Future<void> reorderWhiteboardPages(String boardId, List<String> orderedIds) async {
    await _dio.patch('whiteboard/$boardId/pages/reorder', data: {'orderedIds': orderedIds});
  }

  Future<void> deleteWhiteboardPage(String boardId, String pageId) async {
    await _dio.delete('whiteboard/$boardId/pages/$pageId');
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

  /// The backend requires [workspaceId] (400 without it) and excludes bots.
  Future<List<dynamic>> searchUsers(String query, {required String workspaceId}) async {
    final res = await _dio.get<List<dynamic>>(
      'users/search',
      queryParameters: {'q': query, 'workspaceId': workspaceId},
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

  /// C-16 跨頻道廣播 — 同一內容送到多個頻道。
  Future<List<dynamic>> broadcastMessages({
    required List<String> channelIds,
    required String content,
    String type = 'text',
    Map<String, dynamic>? metadata,
  }) async {
    final res = await _dio.post<List<dynamic>>(
      'messages/broadcast',
      data: {
        'channelIds': channelIds,
        'content': content,
        'type': type,
        if (metadata != null) 'metadata': metadata,
      },
    );
    return res.data ?? [];
  }

  /// C-18 將訊息轉為任務。
  Future<Map<String, dynamic>> convertMessageToTask(
    String messageId, {
    required String projectId,
    required String columnId,
    String? title,
    String? description,
    String? priority,
    String? dueDate,
    String? assigneeId,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'messages/$messageId/convert-to-task',
      data: {
        'projectId': projectId,
        'columnId': columnId,
        if (title != null) 'title': title,
        if (description != null) 'description': description,
        if (priority != null) 'priority': priority,
        if (dueDate != null) 'dueDate': dueDate,
        if (assigneeId != null) 'assigneeId': assigneeId,
      },
    );
    return res.data!;
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

  /// 移交 owner（僅 owner）。body `{userId}`。
  Future<Map<String, dynamic>> transferWorkspaceOwner(
    String workspaceId,
    String newOwnerUserId,
  ) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'workspaces/$workspaceId/owner/transfer',
      data: {'userId': newOwnerUserId},
    );
    return res.data ?? const {};
  }

  // ─────────────────────── H2：員工後台（/company、/admin、/audit） ───────────────────────
  // 契約：notes/h2-api-contract.md。權限一律由後端檢查，前端只負責隱藏。

  /// 目前登入者在公司工作空間的角色、權限與員工資料。
  Future<Map<String, dynamic>> getCompanyMe() async {
    final res = await _dio.get<Map<String, dynamic>>('company/me');
    return res.data ?? const {};
  }

  Future<Map<String, dynamic>> getAdminEmployees({
    String? departmentId,
    String? status,
    String? q,
    int page = 1,
    int pageSize = 50,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      'admin/employees',
      queryParameters: {
        if (departmentId != null && departmentId.isNotEmpty) 'departmentId': departmentId,
        if (status != null && status.isNotEmpty) 'status': status,
        if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
        'page': page,
        'pageSize': pageSize,
      },
    );
    return res.data ?? const {};
  }

  Future<Map<String, dynamic>> createAdminEmployee(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('admin/employees', data: body);
    return res.data ?? const {};
  }

  Future<Map<String, dynamic>> updateAdminEmployee(String id, Map<String, dynamic> body) async {
    final res = await _dio.patch<Map<String, dynamic>>('admin/employees/$id', data: body);
    return res.data ?? const {};
  }

  /// [terminationDate] 為 `YYYY-MM-DD`。
  Future<Map<String, dynamic>> terminateEmployee(String id, String terminationDate) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'admin/employees/$id/terminate',
      data: {'terminationDate': terminationDate},
    );
    return res.data ?? const {};
  }

  Future<Map<String, dynamic>> reinstateEmployee(String id) async {
    final res = await _dio.post<Map<String, dynamic>>('admin/employees/$id/reinstate');
    return res.data ?? const {};
  }

  Future<Map<String, dynamic>> unbindEmployee(String id) async {
    final res = await _dio.post<Map<String, dynamic>>('admin/employees/$id/unbind');
    return res.data ?? const {};
  }

  /// CSV 匯入；[dryRun] 為 true 時後端不寫入，只回預覽。
  Future<Map<String, dynamic>> importEmployees(String csv, {required bool dryRun}) async {
    final res = await _dio.post<Map<String, dynamic>>(
      'admin/employees/import',
      data: {'csv': csv, 'dryRun': dryRun},
    );
    return res.data ?? const {};
  }

  Future<List<dynamic>> getAdminDepartments({bool includeArchived = false}) async {
    final res = await _dio.get<List<dynamic>>(
      'admin/departments',
      queryParameters: {'includeArchived': includeArchived},
    );
    return res.data ?? const [];
  }

  Future<Map<String, dynamic>> createDepartment(Map<String, dynamic> body) async {
    final res = await _dio.post<Map<String, dynamic>>('admin/departments', data: body);
    return res.data ?? const {};
  }

  /// 只送要改的欄位；`parentId: null` 表示移到根層。
  Future<Map<String, dynamic>> updateDepartment(String id, Map<String, dynamic> body) async {
    final res = await _dio.patch<Map<String, dynamic>>('admin/departments/$id', data: body);
    return res.data ?? const {};
  }

  Future<void> archiveDepartment(String id) async {
    await _dio.post('admin/departments/$id/archive');
  }

  Future<void> unarchiveDepartment(String id) async {
    await _dio.post('admin/departments/$id/unarchive');
  }

  Future<void> deleteDepartment(String id) async {
    await _dio.delete('admin/departments/$id');
  }

  /// 審計日誌；[action] 可為完整值或 `employee.*` 這種前綴；[cursor] 用上一頁的 `nextCursor`。
  Future<Map<String, dynamic>> getAuditLogs(
    String workspaceId, {
    String? from,
    String? to,
    String? action,
    String? actorId,
    String? cursor,
    int limit = 50,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      'audit/workspaces/$workspaceId',
      queryParameters: {
        if (from != null && from.isNotEmpty) 'from': from,
        if (to != null && to.isNotEmpty) 'to': to,
        if (action != null && action.trim().isNotEmpty) 'action': action.trim(),
        if (actorId != null && actorId.trim().isNotEmpty) 'actorId': actorId.trim(),
        if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
        'limit': limit,
      },
    );
    return res.data ?? const {};
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
    /// null = 忽略資料夾過濾（= 所有檔案）；"" = 根目錄；其它 = 該資料夾與子資料夾。
    String? folderPath,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      'files/workspace/$workspaceId/browse',
      queryParameters: {
        'type': type,
        if (search.isNotEmpty) 'search': search,
        'limit': limit,
        'offset': offset,
        if (folderPath != null) 'folderPath': folderPath,
      },
    );
    return res.data!;
  }

  Future<List<dynamic>> listFileFolders(String workspaceId) async {
    final res = await _dio.get<List<dynamic>>(
      'files/workspace/$workspaceId/folders',
    );
    return res.data ?? [];
  }

  Future<void> moveFileToFolder(String id, String? folderPath) async {
    await _dio.patch('files/$id/folder', data: {'folderPath': folderPath});
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
    String? folderPath,
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
        if (folderPath != null && folderPath.isNotEmpty) 'folderPath': folderPath,
      },
    );
    return res.data!;
  }
}
