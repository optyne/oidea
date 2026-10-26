import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;

import 'api_client.dart';
import 'dev_backend_urls.dart';

final socketProvider = Provider<SocketService>((ref) {
  final session = ref.watch(authSessionProvider);
  final service = SocketService(
    tokenProvider: () => session.validAccessToken(),
    refreshToken: () => session.refresh(),
  );
  ref.onDispose(service.disconnect);
  return service;
});

/// Returns an access token for a handshake. Null means "no token".
typedef AccessTokenProvider = Future<String?> Function();

/// One authenticated Socket.IO namespace connection.
///
/// Auth contract: the handshake sends `auth: {token: <accessToken>}` through
/// an auth callback, so every (re)connect reads the latest token. When the
/// access token expires the server emits `auth_expired` and disconnects; a
/// stale token is rejected with a connect error `{code: "unauthorized"}`.
/// socket_io_client retries neither, so this class refreshes the token (via
/// the shared single-flight refresh) and reconnects itself, with backoff and
/// a bounded number of attempts. If there is no session left it stops.
class AuthedSocket {
  AuthedSocket({
    required this.url,
    required AccessTokenProvider tokenProvider,
    required AccessTokenProvider refreshToken,
    required this.events,
    required this.onDispatch,
    this.onConnected,
    this.baseReconnectDelay = const Duration(seconds: 1),
    this.maxReconnectAttempts = 10,
    @visibleForTesting void Function()? reconnectOverride,
  })  : _tokenProvider = tokenProvider,
        _refreshToken = refreshToken,
        _reconnectOverride = reconnectOverride;

  final String url;
  final List<String> events;
  final void Function(String event, dynamic data) onDispatch;
  final void Function(IO.Socket socket)? onConnected;
  final Duration baseReconnectDelay;
  final int maxReconnectAttempts;
  final AccessTokenProvider _tokenProvider;
  final AccessTokenProvider _refreshToken;
  final void Function()? _reconnectOverride;

  IO.Socket? _socket;
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  bool _stopped = true;
  bool _needsFreshToken = false;

  bool get isConnected => _socket?.connected ?? false;

  @visibleForTesting
  bool get stopped => _stopped;

  @visibleForTesting
  bool get reconnectPending => _reconnectTimer?.isActive ?? false;

  @visibleForTesting
  int get reconnectAttempts => _reconnectAttempts;

  /// Puts the state machine in the "open" state without a real socket.
  @visibleForTesting
  void startForTest() {
    _stopped = false;
    _reconnectAttempts = 0;
  }

  /// Socket.IO options; `auth` is the callback form, never a static map, and
  /// never contains a userId.
  static Map<String, dynamic> buildOptions(void Function(void Function(Map auth) callback) authFn) {
    return IO.OptionBuilder()
        .setTransports(['websocket'])
        .setAuthFn(authFn)
        .disableAutoConnect()
        .enableForceNew()
        .enableReconnection()
        .setReconnectionAttempts(10)
        .setReconnectionDelay(2000)
        .build();
  }

  /// Handshake auth payload for [token].
  static Map<String, dynamic> handshakeAuth(String token) => {'token': token};

  /// `io server disconnect` is not retried by the client library;
  /// `io client disconnect` is our own close; transport failures are retried
  /// by the library's manager.
  static bool needsManualReconnect(String reason) => reason == 'io server disconnect';

  /// Whether a `connect_error` payload is the server's auth rejection
  /// (`{message: '身分驗證失敗', data: {code: 'unauthorized'}}`).
  static bool isUnauthorized(dynamic err) {
    if (err is! Map) return false;
    final data = err['data'];
    if (data is Map && data['code'] == 'unauthorized') return true;
    return err['code'] == 'unauthorized' || err['message'] == '身分驗證失敗';
  }

  void open() {
    close();
    _stopped = false;
    _reconnectAttempts = 0;
    _needsFreshToken = false;
    final socket = IO.io(url, buildOptions((cb) => authCallback(cb)));
    _socket = socket;

    socket.on('connect', (_) {
      _reconnectAttempts = 0;
      onConnected?.call(socket);
    });
    socket.on('auth_expired', (_) => handleAuthExpired());
    socket.on('disconnect', (reason) => handleDisconnect('$reason'));
    socket.on('connect_error', (err) => handleConnectError(err, socketActive: socket.active));
    for (final e in events) {
      socket.on(e, (data) => onDispatch(e, data));
    }
    socket.connect();
  }

  void close() {
    _stopped = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }

  void emit(String event, dynamic data) => _socket?.emit(event, data);

  /// Auth callback passed to socket_io_client; runs on every (re)connect.
  @visibleForTesting
  Future<void> authCallback(void Function(Map auth) callback) async {
    String? token;
    try {
      if (_needsFreshToken) {
        _needsFreshToken = false;
        token = await _refreshToken();
      }
      // Refresh failed: a dead session has no token left (stop below); on a
      // transient failure the current token is tried and the server decides.
      token ??= await _tokenProvider();
    } catch (_) {
      token = null;
    }
    if (token == null) {
      _stop();
      return;
    }
    callback(handshakeAuth(token));
  }

  @visibleForTesting
  void handleAuthExpired() {
    _needsFreshToken = true;
    _scheduleReconnect();
  }

  @visibleForTesting
  void handleDisconnect(String reason) {
    if (needsManualReconnect(reason)) _scheduleReconnect();
  }

  @visibleForTesting
  void handleConnectError(dynamic err, {required bool socketActive}) {
    if (isUnauthorized(err)) {
      _needsFreshToken = true;
      _scheduleReconnect();
    } else if (!socketActive) {
      _scheduleReconnect();
    }
  }

  /// Delay before reconnect attempt [attempt] (1-based): 1s, 2s, 4s … max 30s.
  @visibleForTesting
  Duration reconnectDelay(int attempt) {
    final ms = baseReconnectDelay.inMilliseconds * math.pow(2, math.max(0, attempt - 1));
    return Duration(milliseconds: math.min(ms.toInt(), 30000));
  }

  void _scheduleReconnect() {
    if (_stopped) return;
    // `auth_expired` is followed by a server disconnect: one reconnect only.
    if (_reconnectTimer?.isActive ?? false) return;
    if (_reconnectAttempts >= maxReconnectAttempts) return;
    _reconnectAttempts++;
    _reconnectTimer = Timer(reconnectDelay(_reconnectAttempts), () {
      if (_stopped) return;
      final override = _reconnectOverride;
      if (override != null) {
        override();
      } else {
        _socket?.connect();
      }
    });
  }

  void _stop() {
    _stopped = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final socket = _socket;
    if (socket != null) scheduleMicrotask(socket.disconnect);
  }
}

/// Messages (default namespace) and whiteboard (`/whiteboard` namespace)
/// connections, each authenticated with the access token.
class SocketService {
  SocketService({
    required AccessTokenProvider tokenProvider,
    required AccessTokenProvider refreshToken,
  })  : _tokenProvider = tokenProvider,
        _refreshToken = refreshToken;

  final AccessTokenProvider _tokenProvider;
  final AccessTokenProvider _refreshToken;

  AuthedSocket? _chat;
  AuthedSocket? _board;

  final Set<String> _channels = {};
  final Set<String> _boards = {};

  /// 允許多處訂閱同一事件；請用 [removeListener] 傳入相同函式參考以移除。
  final Map<String, List<void Function(dynamic)>> _listeners = {};

  static String _baseUrl() {
    const wsEnv = String.fromEnvironment('WS_URL', defaultValue: '');
    final raw = wsEnv.isNotEmpty ? wsEnv : (devBackendSocketFromHostDefine() ?? defaultDevSocketUrl());
    var url = raw.trim();
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    return url;
  }

  void connect() {
    disconnect();
    final base = _baseUrl();
    _chat = AuthedSocket(
      url: base,
      tokenProvider: _tokenProvider,
      refreshToken: _refreshToken,
      events: const ['newMessage', 'userTyping', 'userStopTyping'],
      onDispatch: _dispatch,
      // Rooms are per connection: re-join after every (re)connect.
      onConnected: (s) {
        for (final id in _channels) {
          s.emit('joinChannel', id);
        }
      },
    )..open();
    _board = AuthedSocket(
      url: '$base/whiteboard',
      tokenProvider: _tokenProvider,
      refreshToken: _refreshToken,
      events: const ['remoteUpdate', 'boardState'],
      onDispatch: _dispatch,
      onConnected: (s) {
        for (final id in _boards) {
          s.emit('joinBoard', id);
        }
      },
    )..open();
  }

  void disconnect() {
    _chat?.close();
    _board?.close();
    _chat = null;
    _board = null;
  }

  void _dispatch(String event, dynamic data) {
    final list = _listeners[event];
    if (list == null) return;
    for (final fn in List<void Function(dynamic)>.from(list)) {
      fn(data);
    }
  }

  void addListener(String event, void Function(dynamic) handler) {
    _listeners.putIfAbsent(event, () => []).add(handler);
  }

  void removeListener(String event, void Function(dynamic) handler) {
    _listeners[event]?.remove(handler);
  }

  @Deprecated('Use addListener')
  void on(String event, Function handler) {
    addListener(event, (d) => handler(d));
  }

  @Deprecated('Use removeListener with the same callback reference')
  void off(String event) {
    _listeners.remove(event);
  }

  /// Rooms joined so far; re-joined on every (re)connect.
  @visibleForTesting
  Set<String> get joinedChannels => Set.unmodifiable(_channels);

  @visibleForTesting
  Set<String> get joinedBoards => Set.unmodifiable(_boards);

  // Joins are only emitted while connected; otherwise the next `connect`
  // re-joins everything, so a join is never sent twice.
  void joinChannel(String channelId) {
    _channels.add(channelId);
    if (_chat?.isConnected ?? false) _chat!.emit('joinChannel', channelId);
  }

  void leaveChannel(String channelId) {
    _channels.remove(channelId);
    if (_chat?.isConnected ?? false) _chat!.emit('leaveChannel', channelId);
  }

  void sendMessage(String channelId, String content, {String? parentId}) {
    _chat?.emit('sendMessage', {
      'channelId': channelId,
      'content': content,
      'parentId': parentId,
    });
  }

  void startTyping(String channelId) {
    _chat?.emit('typing', {'channelId': channelId});
  }

  void stopTyping(String channelId) {
    _chat?.emit('stopTyping', {'channelId': channelId});
  }

  void joinBoard(String boardId) {
    _boards.add(boardId);
    if (_board?.isConnected ?? false) _board!.emit('joinBoard', boardId);
  }

  void leaveBoard(String boardId) {
    _boards.remove(boardId);
    if (_board?.isConnected ?? false) _board!.emit('leaveBoard', boardId);
  }

  void sendBoardUpdate(String boardId, List<int> update) {
    _board?.emit('boardUpdate', {'boardId': boardId, 'update': update});
  }

  bool get isConnected => _chat?.isConnected ?? false;
}
