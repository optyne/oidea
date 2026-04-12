import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/socket_service.dart';
import '../../workspace/workspace_storage.dart';
import '../../workspace/providers/workspace_provider.dart';

class AuthState {
  final bool isLoading;
  final bool isAuthenticated;
  final String? userId;
  final String? email;
  final String? displayName;
  final String? avatarUrl;
  final String? error;

  const AuthState({
    this.isLoading = false,
    this.isAuthenticated = false,
    this.userId,
    this.email,
    this.displayName,
    this.avatarUrl,
    this.error,
  });

  AuthState copyWith({
    bool? isLoading,
    bool? isAuthenticated,
    String? userId,
    String? email,
    String? displayName,
    String? avatarUrl,
    String? error,
  }) {
    return AuthState(
      isLoading: isLoading ?? this.isLoading,
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      userId: userId ?? this.userId,
      email: email ?? this.email,
      displayName: displayName ?? this.displayName,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      error: error,
    );
  }
}

final authStateProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(
    ref,
    ref.watch(apiClientProvider),
    ref.watch(socketProvider),
  );
});

String _formatAuthError(Object e) {
  if (e is! DioException) return e.toString();
  final uri = e.requestOptions.uri;
  final code = e.response?.statusCode;
  if (code == 404) {
    return '找不到此 API（404）\n$uri\n'
        '請確認：① 後端已執行 npm run start:dev ② 網址須含 /api\n'
        '③ Android 模擬器預設連宿主機請用 10.0.2.2（本專案未設 API_URL 時已自動）\n'
        '④ 實體手機請用 --dart-define 設電腦區網 IP，勿用 localhost。';
  }
  if (code == 401) {
    return '帳號或密碼錯誤';
  }
  switch (e.type) {
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.sendTimeout:
    case DioExceptionType.receiveTimeout:
      return '連線逾時\n$uri';
    case DioExceptionType.connectionError:
      return '無法連上後端\n$uri\n'
          '實體手機上 localhost 指向手機本身。請用電腦區網 IP，例如：\n'
          'flutter run --dart-define=BACKEND_HOST=192.168.x.x\n'
          '（後端埠非 3001 時再加 --dart-define=BACKEND_PORT=…）\n'
          '或完整指定 API_URL／WS_URL。';
    default:
      break;
  }
  if (code != null) {
    return '請求失敗（HTTP $code）\n$uri';
  }
  return '網路錯誤\n$uri';
}

class AuthNotifier extends StateNotifier<AuthState> {
  final Ref _ref;
  final ApiClient _api;
  final SocketService _socket;
  static const _storage = FlutterSecureStorage();

  AuthNotifier(this._ref, this._api, this._socket) : super(const AuthState()) {
    _checkAuth();
  }

  Future<void> _bootstrapWorkspace() async {
    _ref.invalidate(workspacesProvider);
    try {
      final list = await _ref.read(workspacesProvider.future);
      final ids = <String>[];
      for (final e in list) {
        if (e is Map && e['id'] is String) {
          ids.add(e['id'] as String);
        }
      }
      if (ids.isEmpty) {
        _ref.read(currentWorkspaceIdProvider.notifier).state = null;
        await WorkspaceStorage.write(null);
        return;
      }
      final saved = await WorkspaceStorage.read();
      final pick = (saved != null && ids.contains(saved)) ? saved : ids.first;
      _ref.read(currentWorkspaceIdProvider.notifier).state = pick;
      await WorkspaceStorage.write(pick);
    } catch (_) {
      _ref.read(currentWorkspaceIdProvider.notifier).state = null;
      await WorkspaceStorage.write(null);
    }
  }

  Future<void> _checkAuth() async {
    final token = await _storage.read(key: 'access_token');
    if (token != null) {
      try {
        final user = await _api.getMe();
        state = state.copyWith(
          isAuthenticated: true,
          userId: user['id'],
          email: user['email'],
          displayName: user['displayName'],
          avatarUrl: user['avatarUrl'],
        );
        _socket.connect(user['id']);
        await _bootstrapWorkspace();
      } catch (_) {
        await _storage.deleteAll();
      }
    }
  }

  Future<void> login(String email, String password) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final response = await _api.login(email, password);
      await _storage.write(key: 'access_token', value: response['accessToken']);
      await _storage.write(key: 'refresh_token', value: response['refreshToken']);

      final userData = response['user'];
      state = state.copyWith(
        isLoading: false,
        isAuthenticated: true,
        userId: userData['id'],
        email: userData['email'],
      );

      _socket.connect(userData['id']);
      await _loadProfile();
      await _bootstrapWorkspace();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: _formatAuthError(e));
    }
  }

  Future<void> register(String email, String username, String displayName, String password) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final response = await _api.register({
        'email': email,
        'username': username,
        'displayName': displayName,
        'password': password,
      });
      await _storage.write(key: 'access_token', value: response['accessToken']);
      await _storage.write(key: 'refresh_token', value: response['refreshToken']);

      final userData = response['user'];
      state = state.copyWith(
        isLoading: false,
        isAuthenticated: true,
        userId: userData['id'],
        email: userData['email'],
        displayName: displayName,
      );

      _socket.connect(userData['id']);
      await _bootstrapWorkspace();
    } catch (e) {
      state = state.copyWith(isLoading: false, error: _formatAuthError(e));
    }
  }

  Future<void> _loadProfile() async {
    try {
      final user = await _api.getMe();
      state = state.copyWith(
        displayName: user['displayName'],
        avatarUrl: user['avatarUrl'],
      );
    } catch (_) {}
  }

  /// Called after external profile update to refresh state.
  Future<void> reloadProfile() => _loadProfile();

  Future<void> logout() async {
    _socket.disconnect();
    await _storage.deleteAll();
    _ref.read(currentWorkspaceIdProvider.notifier).state = null;
    await WorkspaceStorage.write(null);
    _ref.invalidate(workspacesProvider);
    state = const AuthState();
  }
}
