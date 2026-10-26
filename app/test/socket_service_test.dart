import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/socket_service.dart';

String _jwt(DateTime exp) {
  String seg(Map<String, dynamic> m) => base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '');
  return '${seg({'alg': 'HS256'})}.${seg({'sub': 'u1', 'exp': exp.millisecondsSinceEpoch ~/ 1000})}.sig';
}

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

  group('S3: no silent message loss across reconnects', () {
    test('chat (re)connect re-joins rooms first, then tells listeners to refetch', () {
      final service = SocketService(tokenProvider: () async => 't', refreshToken: () async => 't');
      service.joinChannel('c1');
      service.joinChannel('c2');
      final log = <String>[];
      void onReconnect(dynamic _) => log.add('refetch');
      service.addListener(SocketService.chatConnectedEvent, onReconnect);

      service.handleChatConnected((event, data) => log.add('$event:$data'));
      expect(log, ['joinChannel:c1', 'joinChannel:c2', 'refetch']);

      // every reconnect, not only the first
      service.handleChatConnected((event, data) => log.add('$event:$data'));
      expect(log.where((e) => e == 'refetch'), hasLength(2));

      service.removeListener(SocketService.chatConnectedEvent, onReconnect);
      service.handleChatConnected((_, __) {});
      expect(log.where((e) => e == 'refetch'), hasLength(2));
    });

    test('proactively refreshes and reconnects shortly before the token expires', () async {
      final now = DateTime.utc(2026, 10, 26, 12);
      // JWT exp has whole seconds: the clock runs 40 ms behind, so the lead window opens in 40 ms.
      var current = _jwt(now.add(const Duration(seconds: 60)));
      final fresh = _jwt(now.add(const Duration(minutes: 15)));
      var refreshCalls = 0;
      var reconnects = 0;
      final sent = <Map>[];
      late AuthedSocket socket;
      socket = AuthedSocket(
        url: 'http://test',
        tokenProvider: () async => current,
        refreshToken: () async {
          refreshCalls++;
          current = fresh;
          return fresh;
        },
        events: const [],
        onDispatch: (_, __) {},
        clock: () => now.subtract(const Duration(milliseconds: 40)),
        reconnectOverride: () async {
          reconnects++;
          await socket.authCallback(sent.add);
          socket.handleConnected();
        },
      )..startForTest();

      await socket.authCallback(sent.add);
      socket.handleConnected();
      expect(socket.proactiveReconnectPending, isTrue);
      expect(refreshCalls, 0);

      await _settle(); // 40 ms to the lead window
      await _settle();

      expect(refreshCalls, 1);
      expect(reconnects, 1);
      expect(sent.last, {'token': fresh});
      // The fresh token is 15 min away: the next proactive reconnect is armed, not due.
      expect(socket.proactiveReconnectPending, isTrue);
      socket.close();
      expect(socket.proactiveReconnectPending, isFalse);
    });

    test('proactive reconnect: refresh failure keeps the connection; disconnect cancels the timer', () async {
      final now = DateTime.utc(2026, 10, 26, 12);
      var reconnects = 0;
      final socket = AuthedSocket(
        url: 'http://test',
        tokenProvider: () async => _jwt(now.add(const Duration(seconds: 60))),
        refreshToken: () async => null,
        events: const [],
        onDispatch: (_, __) {},
        clock: () => now.subtract(const Duration(milliseconds: 20)),
        reconnectOverride: () => reconnects++,
      )..startForTest();

      await socket.authCallback((_) {});
      socket.handleConnected();
      await _settle();
      expect(reconnects, 0);

      await socket.authCallback((_) {});
      socket.handleConnected();
      expect(socket.proactiveReconnectPending, isTrue);
      socket.handleDisconnect('transport close');
      expect(socket.proactiveReconnectPending, isFalse);
    });

    test('no proactive timer for a non-JWT token or one already inside the lead window', () async {
      final now = DateTime.utc(2026, 10, 26, 12);
      var token = 'opaque';
      final socket = AuthedSocket(
        url: 'http://test',
        tokenProvider: () async => token,
        refreshToken: () async => null,
        events: const [],
        onDispatch: (_, __) {},
        clock: () => now,
      )..startForTest();

      await socket.authCallback((_) {});
      socket.handleConnected();
      expect(socket.proactiveReconnectPending, isFalse);

      token = _jwt(now.add(const Duration(seconds: 30)));
      await socket.authCallback((_) {});
      socket.handleConnected();
      expect(socket.proactiveReconnectPending, isFalse);
    });
  });
}
