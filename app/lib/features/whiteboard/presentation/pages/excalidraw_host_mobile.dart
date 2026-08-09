import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import 'whiteboard_excalidraw_page.dart' show kCanvasUrl;

/// Android / iPad 的 WebView 宿主。橋走 OideaBridge JS channel。
class ExcalidrawMobileHost extends ConsumerStatefulWidget {
  const ExcalidrawMobileHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  ConsumerState<ExcalidrawMobileHost> createState() => _ExcalidrawMobileHostState();
}

class _ExcalidrawMobileHostState extends ConsumerState<ExcalidrawMobileHost> {
  late final WebViewController _controller;
  bool _outOfSync = false;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('OideaBridge', onMessageReceived: (msg) {
        Map<String, dynamic> m;
        try {
          m = jsonDecode(msg.message) as Map<String, dynamic>;
        } catch (_) {
          return;
        }
        if (m['type'] == 'ready') _sendInit();
        if (m['type'] == 'error' && mounted) setState(() => _outOfSync = true);
        if (m['type'] == 'saved' && mounted) setState(() => _outOfSync = false);
      })
      ..loadRequest(Uri.parse(kCanvasUrl));
  }

  Future<void> _sendInit() async {
    final api = ref.read(apiClientProvider);
    final token = await api.currentAccessToken();
    if (token == null) return;
    final init = jsonEncode({
      'type': 'init',
      'token': token,
      'boardId': widget.boardId,
      'pageId': widget.pageId,
      'apiBase': api.baseUrlForBridge,
    });
    // wrapper 的 bridge 監聽 window 'message'：以 dispatchEvent 餵入同協定訊息
    await _controller.runJavaScript(
      "window.dispatchEvent(new MessageEvent('message', {data: ${jsonEncode(init)}}));",
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('畫布頁'),
        actions: [
          if (_outOfSync)
            const Padding(
              padding: EdgeInsets.only(right: OideaSpace.space3),
              child: Icon(Icons.sync_problem),
            ),
        ],
      ),
      body: WebViewWidget(controller: _controller),
    );
  }
}
