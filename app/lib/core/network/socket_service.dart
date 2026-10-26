import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;

import 'api_client.dart';
import 'auth_session.dart' show jwtExpiry;
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
///
/// To keep the gap small it also reconnects on its own [proactiveRefreshLead]
/// before the handshake token expires: refresh first, then a quick
/// disconnect + connect with the new token. Events broadcast during any gap
/// are not replayed by the server, so listeners of [onConnected] (see
/// [SocketService.chatConnectedEvent]) refetch what they show.
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
    this.proactiveRefreshLead = const Duration(seconds: 60),
    DateTime Function()? clock,
    @visibleForTesting void Function()? reconnectOverride,
  })  : _tokenProvider = tokenProvider,
        _refreshToken = refreshToken,
        _clock = clock ?? DateTime.now,
        _reconnectOverride = reconnectOverride;

  final String url;
  final List<String> events;
  final void Function(String event, dynamic data) onDispatch;
  final void Function(IO.Socket socket)? onConnected;
  final Duration baseReconnectDelay;
  final int maxReconnectAttempts;

  /// How long before the handshake token's `exp` to refresh and reconnect.
  final Duration proactiveRefreshLead;
  final DateTime Function() _clock;
  final AccessTokenProvider _tokenProvider;
  final AccessTokenProvider _refreshToken;
  final void Function()? _reconnectOverride;

  IO.Socket? _socket;
  Timer? _reconnectTimer;
  Timer? _proactiveTimer;
  String? _handshakeToken;
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

  @visibleForTesting
  bool get proactiveReconnectPending => _proactiveTimer?.isActive ?? false;

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

    socket.on('connect', (_) => handleConnected(socket));
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
    _cancelProactive();
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
    _handshakeToken = token;
    callback(handshakeAuth(token));
  }

  /// The connection is up: reset the backoff, schedule the proactive
  /// reconnect for the token just used, then notify [onConnected].
  @visibleForTesting
  void handleConnected([IO.Socket? socket]) {
    _reconnectAttempts = 0;
    _scheduleProactive();
    final s = socket ?? _socket;
    if (s != null) onConnected?.call(s);
  }

  void _scheduleProactive() {
    _cancelProactive();
    final token = _handshakeToken;
    if (_stopped || token == null) return;
    final exp = jwtExpiry(token);
    if (exp == null) return;
    final delay = exp.difference(_clock().toUtc()) - proactiveRefreshLead;
    // Already inside the lead window: the server's `auth_expired` path handles it.
    if (delay <= Duration.zero) return;
    _proactiveTimer = Timer(delay, () => unawaited(_proactiveReconnect()));
  }

  void _cancelProactive() {
    _proactiveTimer?.cancel();
    _proactiveTimer = null;
  }

  Future<void> _proactiveReconnect() async {
    if (_stopped) return;
    String? fresh;
    try {
      fresh = await _refreshToken();
    } catch (_) {
      fresh = null;
    }
    // On failure keep the current connection; the server expiry path follows.
    if (fresh == null || _stopped) return;
    final override = _reconnectOverride;
    if (override != null) {
      override();
      return;
    }
    final socket = _socket;
    if (socket == null) return;
    // The auth callback reads the (now fresh) token on this connect.
    socket.disconnect();
    socket.connect();
  }

  @visibleForTesting
  void handleAuthExpired() {
    _needsFreshToken = true;
    _scheduleReconnect();
  }

  @visibleForTesting
  void handleDisconnect(String reason) {
    _cancelProactive();
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
    _cancelProactive();
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

  /// Dispatched (no payload) after the chat socket (re)connects and its rooms
  /// were re-joined. Messages broadcast while it was down are not replayed, so
  /// pages that show messages refetch on this event.
  static const chatConnectedEvent = 'chat:connected';

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
      onConnected: (s) => handleChatConnected(s.emit),
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

  /// Chat (re)connected: re-join every channel, then tell listeners of
  /// [chatConnectedEvent] to refetch.
  @visibleForTesting
  void handleChatConnected(void Function(String event, dynamic data) emit) {
    for (final id in _channels) {
      emit('joinChannel', id);
    }
    _dispatch(chatConnectedEvent, null);
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
