import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;

import 'dev_backend_urls.dart';

final socketProvider = Provider<SocketService>((ref) => SocketService());

class SocketService {
  IO.Socket? _socket;

  /// 允許多處訂閱同一事件；請用 [removeListener] 傳入相同函式參考以移除。
  final Map<String, List<void Function(dynamic)>> _listeners = {};

  void connect(String userId) {
    const wsEnv = String.fromEnvironment('WS_URL', defaultValue: '');
    final socketUrl = wsEnv.isNotEmpty
        ? wsEnv
        : (devBackendSocketFromHostDefine() ?? defaultDevSocketUrl());
    _socket = IO.io(
      socketUrl,
      IO.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'userId': userId})
          .enableReconnection()
          .setReconnectionAttempts(10)
          .setReconnectionDelay(2000)
          .build(),
    );

    _socket!.on('connect', (_) {
      // Re-subscribe to channels
    });

    _socket!.on('disconnect', (_) {});

    _socket!.on('newMessage', _dispatch('newMessage'));
    _socket!.on('userTyping', _dispatch('userTyping'));
    _socket!.on('userStopTyping', _dispatch('userStopTyping'));
    _socket!.on('remoteUpdate', _dispatch('remoteUpdate'));

    _socket!.connect();
  }

  void disconnect() {
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

  void joinChannel(String channelId) {
    _socket?.emit('joinChannel', channelId);
  }

  void leaveChannel(String channelId) {
    _socket?.emit('leaveChannel', channelId);
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
    _socket?.emit('joinBoard', boardId);
  }

  void leaveBoard(String boardId) {
    _socket?.emit('leaveBoard', boardId);
  }

  void sendBoardUpdate(String boardId, List<int> update) {
    _socket?.emit('boardUpdate', {'boardId': boardId, 'update': update});
  }

  bool get isConnected => _socket?.connected ?? false;
}
