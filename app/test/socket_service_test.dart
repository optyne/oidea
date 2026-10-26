import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/socket_service.dart';

void main() {
  group('SocketService handshake auth', () {
    test('options use an auth callback, not a static map with userId', () {
      final opts = SocketService.buildOptions((cb) {});
      expect(opts['auth'], isA<Function>());
      expect(opts.containsKey('userId'), isFalse);
      expect(opts['autoConnect'], isFalse);
      expect(opts['forceNew'], isTrue);
    });

    test('auth callback sends the latest token and no userId', () async {
      var token = 'token-1';
      final service = SocketService(tokenProvider: () async => token);
      final sent = <Map>[];

      await service.authCallback(sent.add);
      token = 'token-2'; // e.g. refreshed before a reconnect
      await service.authCallback(sent.add);

      expect(sent, [
        {'token': 'token-1'},
        {'token': 'token-2'},
      ]);
      expect(sent.every((m) => !m.containsKey('userId')), isTrue);
    });

    test('no session: auth callback does not handshake', () async {
      final service = SocketService(tokenProvider: () async => null);
      final sent = <Map>[];

      await service.authCallback(sent.add);

      expect(sent, isEmpty);
    });

    test('token provider error: auth callback does not handshake', () async {
      final service = SocketService(tokenProvider: () async => throw StateError('x'));
      final sent = <Map>[];

      await service.authCallback(sent.add);

      expect(sent, isEmpty);
    });
  });

  group('SocketService reconnect', () {
    test('only a server-side disconnect needs a manual reconnect', () {
      expect(SocketService.needsManualReconnect('io server disconnect'), isTrue);
      expect(SocketService.needsManualReconnect('io client disconnect'), isFalse);
      expect(SocketService.needsManualReconnect('transport close'), isFalse);
    });

    test('reconnect delay backs off and is capped at 30s', () {
      final service = SocketService(tokenProvider: () async => 't');
      expect(service.reconnectDelay(1), const Duration(seconds: 1));
      expect(service.reconnectDelay(2), const Duration(seconds: 2));
      expect(service.reconnectDelay(3), const Duration(seconds: 4));
      expect(service.reconnectDelay(10), const Duration(seconds: 30));
    });

    test('joined channels and boards are remembered for re-join', () {
      final service = SocketService(tokenProvider: () async => 't');
      service.joinChannel('c1');
      service.joinChannel('c2');
      service.leaveChannel('c1');
      service.joinBoard('b1');

      expect(service.joinedChannels, {'c2'});
      expect(service.joinedBoards, {'b1'});
    });
  });
}
