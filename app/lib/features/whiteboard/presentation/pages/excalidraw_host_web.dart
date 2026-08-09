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
  static int _instanceCounter = 0;
  late final String _viewType;
  web.HTMLIFrameElement? _iframe;
  JSFunction? _listener;

  @override
  void initState() {
    super.initState();
    // 每個 instance 用獨一無二的 viewType 註冊自己的 factory：若沿用固定
    // viewType，第二次進頁時舊 closure 仍綁著第一個（已 dispose）instance，
    // 新 instance 的 _iframe 永遠是 null，_sendInit 會永久 no-op。
    // registry 條目隨導覽緩慢累積屬可接受的取捨。
    _viewType = 'oidea-canvas-iframe-${_instanceCounter++}';
    ui_web.platformViewRegistry.registerViewFactory(_viewType, (int viewId) {
      final el = web.HTMLIFrameElement()
        ..src = kCanvasUrl
        ..style.border = 'none'
        ..style.width = '100%'
        ..style.height = '100%';
      _iframe = el;
      return el;
    });
    _listener = ((web.MessageEvent e) {
      // wrapper 是同源部署（同一個 nginx）；非同源訊息一律丟棄，不回 token。
      if (e.origin != web.window.location.origin) return;
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
      body: HtmlElementView(viewType: _viewType),
    );
  }
}
