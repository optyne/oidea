import 'dart:convert';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web/web.dart' as web;

import '../../../../core/network/api_client.dart';
import 'whiteboard_excalidraw_page.dart' show kCanvasUrl;

/// iframe 宿主：註冊 platform view、監聽 ready、回 init（token 不進 URL）。
class ExcalidrawWebHost extends ConsumerStatefulWidget {
  const ExcalidrawWebHost({super.key, required this.boardId, required this.pageId});
  final String boardId;
  final String pageId;

  @override
  ConsumerState<ExcalidrawWebHost> createState() => _ExcalidrawWebHostState();
}

class _ExcalidrawWebHostState extends ConsumerState<ExcalidrawWebHost> {
  static bool _registered = false;
  web.HTMLIFrameElement? _iframe;
  JSFunction? _listener;

  @override
  void initState() {
    super.initState();
    if (!_registered) {
      _registered = true;
      ui_web.platformViewRegistry.registerViewFactory('oidea-canvas-iframe', (int viewId) {
        final el = web.HTMLIFrameElement()
          ..src = kCanvasUrl
          ..style.border = 'none'
          ..style.width = '100%'
          ..style.height = '100%';
        _iframe = el;
        return el;
      });
    }
    _listener = ((web.MessageEvent e) {
      final raw = (e.data as JSString?)?.toDart;
      if (raw == null) return;
      Map<String, dynamic> msg;
      try {
        msg = jsonDecode(raw) as Map<String, dynamic>;
      } catch (_) {
        return;
      }
      if (msg['type'] == 'ready') _sendInit();
    }).toJS;
    web.window.addEventListener('message', _listener);
  }

  Future<void> _sendInit() async {
    final api = ref.read(apiClientProvider);
    final token = await api.currentAccessToken();
    if (token == null || _iframe == null) return;
    final apiBase = api.baseUrlForBridge;
    _iframe!.contentWindow?.postMessage(
      jsonEncode({
        'type': 'init',
        'token': token,
        'boardId': widget.boardId,
        'pageId': widget.pageId,
        'apiBase': apiBase,
      }).toJS,
      '*'.toJS,
    );
  }

  @override
  void dispose() {
    if (_listener != null) web.window.removeEventListener('message', _listener);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('畫布頁')),
      body: const HtmlElementView(viewType: 'oidea-canvas-iframe'),
    );
  }
}
