import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pencil_canvas/pencil_canvas.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../providers/whiteboard_provider.dart';

/// PencilKit 畫布頁（iOS/iPadOS 編輯；其他平台唯讀縮圖）。
///
/// 存檔策略（spec §3/§4）：
/// - 筆畫停 2 秒 → 自動存
/// - 離開頁面 → 強制存（擋可取消 spinner）
/// - 失敗 → 指數退避重試（5s/10s/20s/40s，上限 60s），「未同步」橫幅
/// - 縮圖節流：距上次成功上傳 ≥30 秒才夾帶
class WhiteboardPencilPage extends ConsumerStatefulWidget {
  const WhiteboardPencilPage({super.key, required this.boardId, required this.pageId});

  final String boardId;
  final String pageId;

  @override
  ConsumerState<WhiteboardPencilPage> createState() => _WhiteboardPencilPageState();
}

class _WhiteboardPencilPageState extends ConsumerState<WhiteboardPencilPage> {
  PencilCanvasController? _controller;
  Uint8List? _initialDrawing;
  bool _loading = true;
  bool _dirty = false;
  bool _saving = false;
  bool _outOfSync = false;
  bool _fingerDrawing = false;
  Timer? _debounce;
  Timer? _retry;
  int _retrySeconds = 5;
  DateTime _lastThumbnailAt = DateTime.fromMillisecondsSinceEpoch(0);

  static bool get _canEdit => !kIsWeb && Platform.isIOS;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _retry?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final page =
          await ref.read(apiClientProvider).getWhiteboardPage(widget.boardId, widget.pageId);
      final b64 = page['drawing'] as String?;
      setState(() {
        _initialDrawing = b64 == null ? null : base64Decode(b64);
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _onDrawingChanged() {
    _dirty = true;
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 2), _save);
  }

  Future<bool> _save() async {
    final controller = _controller;
    if (controller == null || !_dirty || _saving) return !_dirty;
    setState(() => _saving = true);
    try {
      final ink = await controller.getDrawing();
      final includeThumbnail =
          DateTime.now().difference(_lastThumbnailAt) > const Duration(seconds: 30);
      final thumbnail = includeThumbnail ? await controller.renderThumbnail() : null;

      await ref.read(apiClientProvider).saveWhiteboardPage(
            widget.boardId,
            widget.pageId,
            drawingBase64: base64Encode(ink),
            thumbnailBase64:
                (thumbnail != null && thumbnail.isNotEmpty) ? base64Encode(thumbnail) : null,
          );
      if (includeThumbnail) _lastThumbnailAt = DateTime.now();
      _dirty = false;
      _retrySeconds = 5;
      _retry?.cancel();
      if (mounted) setState(() { _saving = false; _outOfSync = false; });
      return true;
    } catch (e) {
      if (mounted) setState(() { _saving = false; _outOfSync = true; });
      _retry?.cancel();
      _retry = Timer(Duration(seconds: _retrySeconds), _save);
      _retrySeconds = (_retrySeconds * 2).clamp(5, 60);
      return false;
    }
  }

  /// 返回前強制存檔；失敗時讓使用者選擇等待重試或放棄離開。
  Future<void> _handleExit() async {
    if (!_dirty) {
      if (mounted) Navigator.of(context).pop();
      return;
    }
    final saved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => _SavingDialog(save: _save),
    );
    if (!mounted) return;
    if (saved == true) {
      ref.invalidate(whiteboardPagesProvider(widget.boardId));
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (!_canEdit) {
      return Scaffold(
        appBar: AppBar(title: const Text('頁面（唯讀）')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(OideaSpace.space6),
            child: Text('這一頁是在 iPad 上手寫的。\n請在 iPad 開啟編輯；此處僅提供頁面格縮圖檢視。',
                textAlign: TextAlign.center),
          ),
        ),
      );
    }
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _handleExit();
      },
      child: Scaffold(
        appBar: AppBar(
          leading: BackButton(onPressed: _handleExit),
          title: const Text('手寫頁'),
          actions: [
            if (_outOfSync)
              Padding(
                padding: const EdgeInsets.only(right: OideaSpace.space2),
                child: Chip(
                  label: Text('未同步', style: OideaType.caption),
                  avatar: const Icon(Icons.sync_problem, size: OideaSize.iconSm),
                ),
              ),
            IconButton(
              icon: const Icon(Icons.undo),
              tooltip: '復原',
              onPressed: () => _controller?.undo(),
            ),
            IconButton(
              icon: const Icon(Icons.redo),
              tooltip: '重做',
              onPressed: () => _controller?.redo(),
            ),
            IconButton(
              icon: Icon(_fingerDrawing ? Icons.touch_app : Icons.draw),
              tooltip: _fingerDrawing ? '目前：手指可畫' : '目前：僅 Pencil（防手掌）',
              onPressed: () async {
                setState(() => _fingerDrawing = !_fingerDrawing);
                await _controller?.setFingerDrawing(_fingerDrawing);
              },
            ),
          ],
        ),
        body: PencilCanvasView(
          initialDrawing: _initialDrawing,
          fingerDrawing: _fingerDrawing,
          onCreated: (c) => _controller = c,
          onDrawingChanged: _onDrawingChanged,
        ),
      ),
    );
  }
}

/// 強制存檔對話框：進來就開始存，成功自動關閉（回 true），
/// 失敗顯示重試/放棄。
class _SavingDialog extends StatefulWidget {
  const _SavingDialog({required this.save});

  final Future<bool> Function() save;

  @override
  State<_SavingDialog> createState() => _SavingDialogState();
}

class _SavingDialogState extends State<_SavingDialog> {
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _attempt();
  }

  Future<void> _attempt() async {
    setState(() => _failed = false);
    final ok = await widget.save();
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop(true);
    } else {
      setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_failed ? '存檔失敗' : '存檔中…'),
      content: _failed
          ? const Text('筆跡尚未同步到伺服器。')
          : const SizedBox(
              height: OideaSpace.space10,
              child: Center(child: CircularProgressIndicator())),
      actions: _failed
          ? [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('留在頁面'),
              ),
              FilledButton(onPressed: _attempt, child: const Text('重試')),
            ]
          : [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text('取消'),
              ),
            ],
    );
  }
}
