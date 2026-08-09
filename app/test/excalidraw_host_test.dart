import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/whiteboard/presentation/pages/whiteboard_excalidraw_page.dart';

void main() {
  testWidgets('桌面平台渲染外開瀏覽器說明頁', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    await tester.pumpWidget(const MaterialApp(
      home: WhiteboardExcalidrawPage(boardId: 'b-1', pageId: 'p-1'),
    ));
    expect(find.text('在瀏覽器開啟'), findsOneWidget);
    debugDefaultTargetPlatformOverride = null;
  });
}
