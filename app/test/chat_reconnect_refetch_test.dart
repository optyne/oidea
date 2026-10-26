import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/core/network/auth_session.dart';
import 'package:oidea/core/network/socket_service.dart';
import 'package:oidea/features/chat/presentation/pages/channel_page.dart';
import 'package:oidea/features/chat/providers/channel_provider.dart';
import 'package:oidea/features/chat/presentation/widgets/thread_panel.dart';
import 'package:oidea/features/chat/providers/message_provider.dart';

/// S3: messages broadcast while the socket was down are not replayed by the
/// server, so the channel page and the thread panel reload on every chat
/// (re)connect.
void main() {
  testWidgets('ChannelPage refetches messages when the chat socket reconnects', (tester) async {
    tester.view.physicalSize = const Size(1400, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final socket = SocketService(tokenProvider: () async => null, refreshToken: () async => null);
    final showPage = ValueNotifier(true);
    var fetches = 0;

    await tester.pumpWidget(ProviderScope(
      overrides: [
        socketProvider.overrideWithValue(socket),
        authSessionProvider.overrideWithValue(AuthSession(store: MemoryTokenStore(), refreshDio: Dio())),
        channelProvider.overrideWith((ref, id) async => <String, dynamic>{'id': id, 'name': 'general'}),
        pinnedMessagesProvider.overrideWith((ref, id) async => <dynamic>[]),
        messagesProvider.overrideWith((ref, id) async {
          fetches++;
          return <dynamic>[];
        }),
      ],
      child: MaterialApp(
        home: ValueListenableBuilder<bool>(
          valueListenable: showPage,
          builder: (_, show, __) => show ? const ChannelPage(channelId: 'c1') : const SizedBox(),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(fetches, 1);
    expect(socket.joinedChannels, {'c1'});

    socket.handleChatConnected((_, __) {});
    await tester.pumpAndSettle();
    expect(fetches, 2);

    showPage.value = false;
    await tester.pumpAndSettle();
    expect(socket.joinedChannels, isEmpty);
    socket.handleChatConnected((_, __) {});
    await tester.pump();
    expect(fetches, 2);
  });

  testWidgets('ThreadPanel refetches the thread when the chat socket reconnects', (tester) async {
    final socket = SocketService(tokenProvider: () async => null, refreshToken: () async => null);
    final showPanel = ValueNotifier(true);
    var fetches = 0;

    await tester.pumpWidget(ProviderScope(
      overrides: [
        socketProvider.overrideWithValue(socket),
        threadProvider.overrideWith((ref, parentId) async {
          fetches++;
          return <dynamic>[];
        }),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: ValueListenableBuilder<bool>(
            valueListenable: showPanel,
            builder: (_, show, __) =>
                show ? const ThreadPanel(channelId: 'c1', parentId: 'p1') : const SizedBox(),
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    expect(fetches, 1);

    socket.handleChatConnected((_, __) {});
    await tester.pumpAndSettle();
    expect(fetches, 2);

    // After the panel is gone the listener is removed.
    showPanel.value = false;
    await tester.pumpAndSettle();
    socket.handleChatConnected((_, __) {});
    await tester.pump();
    expect(fetches, 2);
  });
}
