import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/features/whiteboard/presentation/pages/whiteboard_pages_page.dart';

class _FakeApi extends Fake implements ApiClient {
  @override
  Future<List<dynamic>> getWhiteboardPages(String boardId) async => [
        {'id': 'p-1', 'position': 0, 'format': 'excalidraw', 'thumbnailUrl': null, 'updatedAt': '2026-08-09'},
        {'id': 'p-2', 'position': 1, 'format': 'pencilkit', 'thumbnailUrl': null, 'updatedAt': '2026-08-09'},
      ];

  @override
  Future<Map<String, dynamic>> createWhiteboardPage(String boardId, {String? format}) async =>
      {'id': 'p-new', 'format': format ?? 'pencilkit'};

  @override
  Future<Map<String, dynamic>> getWhiteboard(String id) async =>
      {'id': id, 'title': '測試筆記本', 'data': null};
}

void main() {
  testWidgets('頁面格：渲染標題與兩張頁卡', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(_FakeApi())],
        child: const MaterialApp(home: WhiteboardPagesPage(boardId: 'wb-1')),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('測試筆記本'), findsOneWidget);
    expect(find.text('第 1 頁'), findsOneWidget);
    expect(find.text('第 2 頁'), findsOneWidget);
    expect(find.text('新增頁'), findsOneWidget);
    expect(find.byIcon(Icons.devices), findsOneWidget); // 只有 excalidraw 頁有徽章
  });

  testWidgets('空筆記本：顯示引導文案', (tester) async {
    final api = _EmptyApi();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(api)],
        child: const MaterialApp(home: WhiteboardPagesPage(boardId: 'wb-1')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('還沒有頁面'), findsOneWidget);
  });
}

class _EmptyApi extends Fake implements ApiClient {
  @override
  Future<List<dynamic>> getWhiteboardPages(String boardId) async => [];

  @override
  Future<Map<String, dynamic>> getWhiteboard(String id) async =>
      {'id': id, 'title': '空筆記本', 'data': null};
}
