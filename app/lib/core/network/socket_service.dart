import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;

import 'api_client.dart';
import 'dev_backend_urls.dart';

final socketProvider = Provider<SocketService>((ref) {
  final session = ref.watch(authSessionProvider);
  final service = SocketService(tokenProvider: () => session.validAccessToken());
  ref.onDispose(service.disconnect);
  return service;
});

/// Returns the access token for a (re)connect handshake, refreshing it first
/// if needed. Null means there is no session; the socket then stays down.
typedef AccessTokenProvider = Future<String?> Function();

/// One Socket.IO connection shared by the messages and whiteboard gateways.
///
/// Auth contract: the handshake sends `auth: {token: <accessToken>}` through
/// an auth callback, so every (re)connect reads the latest token. The server
/// disconnects the socket when the access token expires (and rejects a stale
/// token with a connect error); neither case is retried by socket_io_client,
/// so this class reconnects itself and re-joins the channels and boards that
/// were joined.
class SocketService {
  SocketService({
    required AccessTokenProvider tokenProvider,
    this.baseReconnectDelay = const Duration(seconds: 1),
    this.maxReconnectAttempts = 10,
  }) : _tokenProvider = tokenProvider;

  final AccessTokenProvider _tokenProvider;
  final Duration baseReconnectDelay;
  final int maxReconnectAttempts;

  IO.Socket? _socket;
  Timer? _reconnectTimer;
  int _reconnectAttempts = 0;
  bool _stopped = true;

  final Set<String> _channels = {};
  final Set<String> _boards = {};

  /// 允許多處訂閱同一事件；請用 [removeListener] 傳入相同函式參考以移除。
  final Map<String, List<void Function(dynamic)>> _listeners = {};

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

  /// Whether a `disconnect` with [reason] needs a manual reconnect.
  /// `io server disconnect` (e.g. token expired) is not retried by the client
  /// library; `io client disconnect` is our own [disconnect]; transport
  /// failures are retried by the library's manager.
  static bool needsManualReconnect(String reason) => reason == 'io server disconnect';

  /// Auth callback passed to socket_io_client; runs on every (re)connect.
  @visibleForTesting
  Future<void> authCallback(void Function(Map auth) callback) async {
    String? token;
    try {
      token = await _tokenProvider();
    } catch (_) {
      token = null;
    }
    if (token == null) {
      // No session: do not handshake anonymously.
      _stopped = true;
      _reconnectTimer?.cancel();
      scheduleMicrotask(() => _socket?.disconnect());
      return;
    }
    callback(handshakeAuth(token));
  }

  void connect() {
    disconnect();
    _stopped = false;
    _reconnectAttempts = 0;
    const wsEnv = String.fromEnvironment('WS_URL', defaultValue: '');
    final socketUrl = wsEnv.isNotEmpty
        ? wsEnv
        : (devBackendSocketFromHostDefine() ?? defaultDevSocketUrl());
    final socket = IO.io(socketUrl, buildOptions((cb) => authCallback(cb)));
    _socket = socket;

    socket.on('connect', (_) {
      _reconnectAttempts = 0;
      _rejoinRooms();
    });

    socket.on('disconnect', (reason) {
      if (needsManualReconnect('$reason')) _scheduleReconnect();
    });

    socket.on('connect_error', (_) {
      // A rejected handshake (CONNECT_ERROR packet) destroys the socket and is
      // not retried by the library; transport errors keep it active.
      if (!socket.active) _scheduleReconnect();
    });

    socket.on('newMessage', _dispatch('newMessage'));
    socket.on('userTyping', _dispatch('userTyping'));
    socket.on('userStopTyping', _dispatch('userStopTyping'));
    socket.on('remoteUpdate', _dispatch('remoteUpdate'));

    socket.connect();
  }

  /// Delay before reconnect attempt [attempt] (1-based): 1s, 2s, 4s … max 30s.
  @visibleForTesting
  Duration reconnectDelay(int attempt) {
    final ms = baseReconnectDelay.inMilliseconds * math.pow(2, math.max(0, attempt - 1));
    return Duration(milliseconds: math.min(ms.toInt(), 30000));
  }

  void _scheduleReconnect() {
    if (_stopped || _socket == null) return;
    if (_reconnectAttempts >= maxReconnectAttempts) return;
    _reconnectTimer?.cancel();
    _reconnectAttempts++;
    _reconnectTimer = Timer(reconnectDelay(_reconnectAttempts), () {
      if (_stopped) return;
      _socket?.connect();
    });
  }

  void _rejoinRooms() {
    final socket = _socket;
    if (socket == null) return;
    for (final id in _channels) {
      socket.emit('joinChannel', id);
    }
    for (final id in _boards) {
      socket.emit('joinBoard', id);
    }
  }

  void disconnect() {
    _stopped = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }

  void Function(dynamic) _dispatch(String event) {
    return (dynamic data) {
      final list = _listeners[event];
      if (list == null) return;
      for (final fn in List<void Function(dynamic)>.from(list)) {
        fn(data);
      }
    };
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
    if (isConnected) _socket?.emit('joinChannel', channelId);
  }

  void leaveChannel(String channelId) {
    _channels.remove(channelId);
    if (isConnected) _socket?.emit('leaveChannel', channelId);
  }

  void sendMessage(String channelId, String content, {String? parentId}) {
    _socket?.emit('sendMessage', {
      'channelId': channelId,
      'content': content,
      'parentId': parentId,
    });
  }

  void startTyping(String channelId) {
    _socket?.emit('typing', {'channelId': channelId});
  }

  void stopTyping(String channelId) {
    _socket?.emit('stopTyping', {'channelId': channelId});
  }

  void joinBoard(String boardId) {
    _boards.add(boardId);
    if (isConnected) _socket?.emit('joinBoard', boardId);
  }

  void leaveBoard(String boardId) {
    _boards.remove(boardId);
    if (isConnected) _socket?.emit('leaveBoard', boardId);
  }

  void sendBoardUpdate(String boardId, List<int> update) {
    _socket?.emit('boardUpdate', {'boardId': boardId, 'update': update});
  }

  bool get isConnected => _socket?.connected ?? false;
}
