import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Where the access / refresh token pair lives.
///
/// Abstracted so tests can use an in-memory store instead of the platform
/// keychain.
abstract class TokenStore {
  Future<String?> readAccessToken();
  Future<String?> readRefreshToken();
  Future<void> save({required String accessToken, String? refreshToken});
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  const SecureTokenStore([this._storage = const FlutterSecureStorage()]);

  static const accessKey = 'access_token';
  static const refreshKey = 'refresh_token';

  final FlutterSecureStorage _storage;

  @override
  Future<String?> readAccessToken() => _storage.read(key: accessKey);

  @override
  Future<String?> readRefreshToken() => _storage.read(key: refreshKey);

  @override
  Future<void> save({required String accessToken, String? refreshToken}) async {
    await _storage.write(key: accessKey, value: accessToken);
    if (refreshToken != null) {
      await _storage.write(key: refreshKey, value: refreshToken);
    }
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: accessKey);
    await _storage.delete(key: refreshKey);
  }
}

class MemoryTokenStore implements TokenStore {
  MemoryTokenStore({this.accessToken, this.refreshToken});

  String? accessToken;
  String? refreshToken;

  @override
  Future<String?> readAccessToken() async => accessToken;

  @override
  Future<String?> readRefreshToken() async => refreshToken;

  @override
  Future<void> save({required String accessToken, String? refreshToken}) async {
    this.accessToken = accessToken;
    if (refreshToken != null) this.refreshToken = refreshToken;
  }

  @override
  Future<void> clear() async {
    accessToken = null;
    refreshToken = null;
  }
}

/// Reads the `exp` claim of a JWT without verifying it (the server verifies).
/// Returns null if the token is not a decodable JWT or has no numeric `exp`.
DateTime? jwtExpiry(String token) {
  final parts = token.split('.');
  if (parts.length != 3) return null;
  try {
    final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    final json = jsonDecode(payload);
    if (json is Map && json['exp'] is num) {
      final secs = (json['exp'] as num).toInt();
      return DateTime.fromMillisecondsSinceEpoch(secs * 1000, isUtc: true);
    }
  } catch (_) {}
  return null;
}

/// Owns the token pair and the refresh / logout calls of the auth contract:
///
/// - `POST auth/refresh` with body `{refreshToken}` and no Authorization header;
///   the response is a new pair (the old refresh token is rotated).
/// - `POST auth/logout` with body `{refreshToken}`.
///
/// [refresh] is single-flight: concurrent callers share one network call.
class AuthSession {
  AuthSession({
    required this.store,
    required Dio refreshDio,
    DateTime Function()? clock,
  })  : _refreshDio = refreshDio,
        _clock = clock ?? DateTime.now;

  final TokenStore store;

  /// Must not carry [AuthInterceptor], so a 401 from `auth/refresh` can never
  /// trigger another refresh.
  final Dio _refreshDio;
  final DateTime Function() _clock;

  Future<String?>? _inflight;
  final _sessionExpired = StreamController<void>.broadcast();
  DioException? _lastRefreshError;

  /// Statuses from `auth/refresh` that prove the refresh token is dead. Anything
  /// else (429 rate limit, 408, 5xx, network errors) is transient: tokens are
  /// kept and the error is exposed through [lastRefreshError].
  static const sessionEndingStatuses = {400, 401, 403};

  /// The error of the last refresh that failed for a transient reason (null
  /// after a successful refresh or when the session ended). Callers surface it
  /// instead of pretending the user was logged out.
  DioException? get lastRefreshError => _lastRefreshError;

  /// Fires once each time a refresh proves the session dead (tokens already
  /// cleared). The auth state listens and sends the user to login.
  Stream<void> get onSessionExpired => _sessionExpired.stream;

  /// Gets a new access token. Returns null when it could not get one.
  /// When the server rejects the refresh token (400 / 401 / 403), local tokens
  /// are cleared and [onSessionExpired] fires; on anything else (429, other
  /// 4xx, 5xx, network errors) tokens are kept and [lastRefreshError] is set.
  Future<String?> refresh() {
    return _inflight ??= _doRefresh().whenComplete(() => _inflight = null);
  }

  Future<String?> _doRefresh() async {
    _lastRefreshError = null;
    final refreshToken = await store.readRefreshToken();
    if (refreshToken == null) {
      await _expire();
      return null;
    }
    try {
      final res = await _refreshDio.post<Map<String, dynamic>>(
        'auth/refresh',
        data: {'refreshToken': refreshToken},
      );
      final access = res.data?['accessToken'];
      final nextRefresh = res.data?['refreshToken'];
      if (access is! String || access.isEmpty) {
        await _expire();
        return null;
      }
      await store.save(
        accessToken: access,
        refreshToken: nextRefresh is String ? nextRefresh : null,
      );
      return access;
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      if (code != null && sessionEndingStatuses.contains(code)) {
        await _expire();
      } else {
        _lastRefreshError = e;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  Future<void> _expire() async {
    await store.clear();
    _sessionExpired.add(null);
  }

  /// Access token for a new connection (e.g. a socket handshake). Refreshes
  /// first when it is expired or expires within [leeway].
  ///
  /// Returns null only when there is no session. If the refresh fails for a
  /// transient reason the current token is returned and the server decides.
  Future<String?> validAccessToken({Duration leeway = const Duration(seconds: 30)}) async {
    final current = await store.readAccessToken();
    if (current == null) return null;
    final exp = jwtExpiry(current);
    if (exp == null || exp.isAfter(_clock().toUtc().add(leeway))) {
      return current;
    }
    final fresh = await refresh();
    if (fresh != null) return fresh;
    return store.readAccessToken();
  }

  /// Best-effort server-side logout; local tokens are cleared regardless.
  Future<void> logout() async {
    final refreshToken = await store.readRefreshToken();
    final accessToken = await store.readAccessToken();
    try {
      if (refreshToken != null) {
        await _refreshDio.post<Map<String, dynamic>>(
          'auth/logout',
          data: {'refreshToken': refreshToken},
          options: Options(
            headers: {if (accessToken != null) 'Authorization': 'Bearer $accessToken'},
          ),
        );
      }
    } catch (_) {
      // Best effort: the session is dropped locally either way.
    } finally {
      await store.clear();
    }
  }

  void dispose() {
    _sessionExpired.close();
  }
}
