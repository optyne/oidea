import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/theme/app_theme.dart';
import 'whiteboard_excalidraw_page.dart' show kCanvasUrl;

/// 桌面 v1：外開瀏覽器（web 版走完整 iframe 宿主），App 內留說明。
class ExcalidrawDesktopHost extends StatelessWidget {
  const ExcalidrawDesktopHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('畫布頁')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('此頁為通用畫布格式，桌面版請在瀏覽器中編輯。'),
            const SizedBox(height: OideaSpace.space3),
            FilledButton.icon(
              icon: const Icon(Icons.open_in_browser),
              label: const Text('在瀏覽器開啟'),
              onPressed: () => launchUrl(Uri.parse(
                  '${kCanvasUrl.replaceAll('/canvas/', '')}/#/whiteboard/excalidraw/$boardId/$pageId')),
            ),
          ],
        ),
      ),
    );
  }
}
