import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/auth_session.dart';
import '../../../core/network/socket_service.dart';
import '../../workspace/workspace_storage.dart';
import '../../workspace/providers/workspace_provider.dart';
import '../sso/sso_callback.dart';
import '../sso/sso_service.dart';

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
    ref.watch(authSessionProvider),
  );
});

const badCredentialsMessage = '帳號或密碼錯誤';

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
    return badCredentialsMessage;
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
  final AuthSession _session;
  StreamSubscription<void>? _expiredSub;
  static const _storage = FlutterSecureStorage();

  AuthNotifier(this._ref, this._api, this._socket, this._session) : super(const AuthState()) {
    _expiredSub = _session.onSessionExpired.listen((_) => _onSessionExpired());
    _checkAuth();
  }

  @override
  void dispose() {
    _expiredSub?.cancel();
    super.dispose();
  }

  /// Refresh token was rejected: tokens are already cleared by [AuthSession];
  /// drop local state so the router redirects to /login (once).
  Future<void> _onSessionExpired() async {
    if (!state.isAuthenticated) return;
    _socket.disconnect();
    state = const AuthState(error: '登入已過期，請重新登入');
    _ref.read(currentWorkspaceIdProvider.notifier).state = null;
    await WorkspaceStorage.write(null);
    _ref.invalidate(workspacesProvider);
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
    final token = await _session.store.readAccessToken();
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
        _socket.connect();
        await _bootstrapWorkspace();
      } catch (_) {
        await _session.store.clear();
      }
    }
  }

  /// [breakGlass]: emergency owner login. The backend answers 404 for anyone
  /// not allowed (not listed, not an owner, wrong password), so 404 means
  /// 「帳號或密碼錯誤」 here instead of the developer "API not found" hint.
  Future<void> login(String email, String password, {bool breakGlass = false}) async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final response = await _api.login(email, password);
      await _completeLogin(response);
    } catch (e) {
      final notFound = e is DioException && e.response?.statusCode == 404;
      state = state.copyWith(
        isLoading: false,
        error: breakGlass && notFound ? badCredentialsMessage : _formatAuthError(e),
      );
    }
  }

  /// Starts company SSO. Web: the tab navigates to the backend and this never
  /// completes in practice (state stays loading). Mobile: runs the system auth
  /// session, then exchanges the ticket.
  Future<void> loginWithSso() async {
    state = state.copyWith(isLoading: true, error: null);
    try {
      final result = await _ref.read(ssoServiceProvider).start();
      if (result == null) return;
      await completeSso(result.callback, verifier: result.verifier);
    } on PlatformException catch (e) {
      // User closed the auth sheet: not an error worth a banner.
      final canceled = e.code == 'CANCELED' || e.code == 'CANCELLED';
      state = AuthState(error: canceled ? null : ssoGenericFailure);
    } catch (_) {
      state = const AuthState(error: ssoGenericFailure);
    }
  }

  /// Web `/auth/callback`: takes (and removes) the verifier saved before the
  /// redirect, then exchanges. Returns true when the user is logged in.
  Future<bool> completeWebSso(SsoCallback callback) {
    final verifier = _ref.read(ssoServiceProvider).takeWebVerifier();
    return completeSso(callback, verifier: verifier);
  }

  /// Exchanges an SSO ticket for tokens. Returns true when logged in;
  /// otherwise [AuthState.error] holds the message for the login page.
  Future<bool> completeSso(SsoCallback callback, {required String? verifier}) async {
    switch (callback) {
      case SsoError(:final code):
        state = AuthState(error: ssoErrorMessage(code));
        return false;
      case SsoMissing():
        state = const AuthState(error: ssoGenericFailure);
        return false;
      case SsoTicket(:final ticket):
        if (verifier == null || verifier.isEmpty) {
          // Verifier lost (other tab, storage cleared, app restarted).
          state = const AuthState(error: ssoTimeoutMessage);
          return false;
        }
        state = state.copyWith(isLoading: true, error: null);
        try {
          final response = await _api.exchangeOidcTicket(ticket: ticket, appVerifier: verifier);
          await _completeLogin(response);
          return true;
        } catch (e) {
          await _session.store.clear();
          state = AuthState(error: _formatSsoExchangeError(e));
          return false;
        }
    }
  }

  Future<void> _completeLogin(Map<String, dynamic> response) async {
    await _saveTokens(response);
    final userData = response['user'];
    state = state.copyWith(
      isLoading: false,
      isAuthenticated: true,
      userId: userData is Map ? userData['id'] as String? : null,
      email: userData is Map ? userData['email'] as String? : null,
    );
    _socket.connect();
    await _loadProfile();
    await _bootstrapWorkspace();
  }

  Future<void> _saveTokens(Map<String, dynamic> response) {
    return _session.store.save(
      accessToken: response['accessToken'] as String,
      refreshToken: response['refreshToken'] as String?,
    );
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
    // Revokes the refresh token server-side (best effort) and clears it locally.
    await _session.logout();
    await _storage.deleteAll();
    _ref.read(currentWorkspaceIdProvider.notifier).state = null;
    await WorkspaceStorage.write(null);
    _ref.invalidate(workspacesProvider);
    state = const AuthState();
    await _endIdpSession();
  }

  /// Web: also end the IdP session, otherwise the next "使用公司帳號登入"
  /// signs the same person in again without asking.
  Future<void> _endIdpSession() async {
    try {
      final config = await _ref.read(authConfigProvider.future).timeout(const Duration(seconds: 3));
      _ref.read(ssoServiceProvider).endBrowserSession(config.endSessionUrl);
    } catch (_) {
      // Config unavailable: local logout already done.
    }
  }
}

/// Message for a failed `auth/oidc/exchange`. Uses a known error code from
/// the response body when there is one; never includes the request body.
String _formatSsoExchangeError(Object e) {
  if (e is DioException) {
    final data = e.response?.data;
    if (data is Map) {
      for (final key in const ['code', 'error', 'message']) {
        final v = data[key];
        if (v is String && isKnownSsoErrorCode(v)) return ssoErrorMessage(v);
      }
    }
    final status = e.response?.statusCode;
    if (status == 400 || status == 401) return ssoTimeoutMessage;
  }
  return ssoGenericFailure;
}
