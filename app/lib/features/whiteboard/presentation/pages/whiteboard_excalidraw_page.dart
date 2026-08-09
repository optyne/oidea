import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'excalidraw_host_stub.dart'
    if (dart.library.js_interop) 'excalidraw_host_web.dart';
import 'excalidraw_host_desktop.dart';
import 'excalidraw_host_mobile.dart';

/// dart-define CANVAS_URL 覆寫；預設打正式站（iPad/Android 實機直接可用）。
const kCanvasUrl = String.fromEnvironment(
  'CANVAS_URL',
  defaultValue: 'https://oidea.oadpiz.com/canvas/',
);

/// excalidraw 格式頁的宿主：web=iframe、行動=WebView、桌面=外部瀏覽器。
class WhiteboardExcalidrawPage extends StatelessWidget {
  const WhiteboardExcalidrawPage({
    super.key,
    required this.boardId,
    required this.pageId,
  });

  final String boardId;
  final String pageId;

  @override
  Widget build(BuildContext context) {
    if (kIsWeb) {
      return ExcalidrawWebHost(boardId: boardId, pageId: pageId);
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
      case TargetPlatform.iOS:
        return ExcalidrawMobileHost(boardId: boardId, pageId: pageId);
      default:
        return ExcalidrawDesktopHost(boardId: boardId, pageId: pageId);
    }
  }
}
