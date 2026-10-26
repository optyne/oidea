import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/socket_service.dart';

const _unauthorized = {
  'message': '身分驗證失敗',
  'data': {'code': 'unauthorized'},
};

Future<void> _settle() => Future<void>.delayed(const Duration(milliseconds: 50));

/// An [AuthedSocket] whose "reconnect" runs the handshake auth callback
/// directly (no server), recording what would be sent.
class _Rig {
  _Rig({
    required this.refreshResult,
    this.current = 'old',
    this.serverRejects = false,
    int maxAttempts = 10,
  }) {
    socket = AuthedSocket(
      url: 'http://test',
      tokenProvider: () async => current,
      refreshToken: () async {
        refreshCalls++;
        final r = refreshResult;
        if (r != null) current = r;
        return r;
      },
      events: const [],
      onDispatch: (_, __) {},
      baseReconnectDelay: Duration.zero,
      maxReconnectAttempts: maxAttempts,
      reconnectOverride: () async {
        reconnects++;
        await socket.authCallback(sent.add);
        if (serverRejects && sent.isNotEmpty) {
          socket.handleConnectError(_unauthorized, socketActive: false);
        }
      },
    )..startForTest();
  }

  String? refreshResult;
  String? current;
  final bool serverRejects;
  late final AuthedSocket socket;
  final List<Map> sent = [];
  int refreshCalls = 0;
  int reconnects = 0;
}

void main() {
  group('handshake auth', () {
    test('options use an auth callback, not a static map with userId', () {
      final opts = AuthedSocket.buildOptions((cb) {});
      expect(opts['auth'], isA<Function>());
      expect(opts.containsKey('userId'), isFalse);
      expect(opts['autoConnect'], isFalse);
      expect(opts['forceNew'], isTrue);
    });

    test('auth callback sends the latest token and no userId', () async {
      var token = 'token-1';
      final s = AuthedSocket(
        url: 'http://test',
        tokenProvider: () async => token,
        refreshToken: () async => null,
        events: const [],
        onDispatch: (_, __) {},
      );
      final sent = <Map>[];

      await s.authCallback(sent.add);
      token = 'token-2';
      await s.authCallback(sent.add);

      expect(sent, [
        {'token': 'token-1'},
        {'token': 'token-2'},
      ]);
      expect(sent.every((m) => !m.containsKey('userId')), isTrue);
    });

    test('no session: auth callback does not handshake', () async {
      final s = AuthedSocket(
        url: 'http://test',
        tokenProvider: () async => null,
        refreshToken: () async => null,
        events: const [],
        onDispatch: (_, __) {},
      )..startForTest();
      final sent = <Map>[];

      await s.authCallback(sent.add);

      expect(sent, isEmpty);
      expect(s.stopped, isTrue);
    });

    test('recognises the server auth rejection payload', () {
      expect(AuthedSocket.isUnauthorized(_unauthorized), isTrue);
      expect(AuthedSocket.isUnauthorized({'message': 'xhr poll error'}), isFalse);
      expect(AuthedSocket.isUnauthorized('timeout'), isFalse);
    });
  });

  group('reconnect after token expiry', () {
    test('auth_expired + server disconnect: one refresh, one reconnect with the new token', () async {
      final rig = _Rig(refreshResult: 'new');

      rig.socket.handleAuthExpired();
      rig.socket.handleDisconnect('io server disconnect');
      await _settle();

      expect(rig.refreshCalls, 1);
      expect(rig.reconnects, 1);
      expect(rig.sent, [
        {'token': 'new'},
      ]);
    });

    test('connect_error unauthorized: refreshes then reconnects', () async {
      final rig = _Rig(refreshResult: 'new');

      rig.socket.handleConnectError(_unauthorized, socketActive: false);
      await _settle();

      expect(rig.refreshCalls, 1);
      expect(rig.sent, [
        {'token': 'new'},
      ]);
    });

    test('refresh fails and session is gone: stops without looping', () async {
      final rig = _Rig(refreshResult: null);
      rig.current = null; // refresh 401 cleared the tokens

      rig.socket.handleAuthExpired();
      await _settle();
      rig.socket.handleConnectError(_unauthorized, socketActive: false);
      await _settle();

      expect(rig.reconnects, 1);
      expect(rig.sent, isEmpty);
      expect(rig.socket.stopped, isTrue);
      expect(rig.socket.reconnectPending, isFalse);
    });

    test('server keeps rejecting: reconnect attempts are bounded', () async {
      final rig = _Rig(refreshResult: null, current: 'stale', serverRejects: true, maxAttempts: 3);

      rig.socket.handleConnectError(_unauthorized, socketActive: false);
      await _settle();

      expect(rig.reconnects, 3);
      expect(rig.socket.reconnectPending, isFalse);
    });

    test('client-side disconnect and transport errors do not trigger a manual reconnect', () async {
      final rig = _Rig(refreshResult: 'new');

      rig.socket.handleDisconnect('io client disconnect');
      rig.socket.handleDisconnect('transport close');
      rig.socket.handleConnectError({'message': 'websocket error'}, socketActive: true);
      await _settle();

      expect(rig.reconnects, 0);
    });

    test('reconnect delay backs off and is capped at 30s', () {
      final s = AuthedSocket(
        url: 'http://test',
        tokenProvider: () async => 't',
        refreshToken: () async => 't',
        events: const [],
        onDispatch: (_, __) {},
      );
      expect(s.reconnectDelay(1), const Duration(seconds: 1));
      expect(s.reconnectDelay(2), const Duration(seconds: 2));
      expect(s.reconnectDelay(3), const Duration(seconds: 4));
      expect(s.reconnectDelay(10), const Duration(seconds: 30));
    });
  });

  test('SocketService remembers joined channels and boards for re-join', () {
    final service = SocketService(tokenProvider: () async => 't', refreshToken: () async => 't');
    service.joinChannel('c1');
    service.joinChannel('c2');
    service.leaveChannel('c1');
    service.joinBoard('b1');

    expect(service.joinedChannels, {'c2'});
    expect(service.joinedBoards, {'b1'});
  });
}
