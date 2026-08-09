import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// 對單一 PencilCanvasView 實例的操作把手。由 [PencilCanvasView.onCreated] 交付。
class PencilCanvasController {
  PencilCanvasController._(this._channel);
  final MethodChannel _channel;

  Future<Uint8List> getDrawing() async =>
      await _channel.invokeMethod<Uint8List>('getDrawing') ?? Uint8List(0);

  Future<void> setDrawing(Uint8List data) => _channel.invokeMethod('setDrawing', data);

  Future<void> undo() => _channel.invokeMethod('undo');

  Future<void> redo() => _channel.invokeMethod('redo');

  Future<void> setFingerDrawing(bool enabled) => _channel.invokeMethod('setFingerDrawing', enabled);

  Future<Uint8List> renderThumbnail({int maxWidth = 512}) async =>
      await _channel.invokeMethod<Uint8List>('renderThumbnail', {'maxWidth': maxWidth}) ??
      Uint8List(0);
}

/// PencilKit 畫布（僅 iOS/iPadOS）。非 iOS 平台請勿建構此 widget —— 由呼叫端負責分流。
class PencilCanvasView extends StatefulWidget {
  const PencilCanvasView({
    super.key,
    this.initialDrawing,
    this.fingerDrawing = false,
    this.onCreated,
    this.onDrawingChanged,
  });

  final Uint8List? initialDrawing;
  final bool fingerDrawing;
  final void Function(PencilCanvasController controller)? onCreated;
  final VoidCallback? onDrawingChanged;

  @override
  State<PencilCanvasView> createState() => _PencilCanvasViewState();
}

class _PencilCanvasViewState extends State<PencilCanvasView> {
  @override
  Widget build(BuildContext context) {
    return UiKitView(
      viewType: 'oidea/pencil_canvas',
      creationParams: <String, dynamic>{
        'drawing': widget.initialDrawing,
        'fingerDrawing': widget.fingerDrawing,
      },
      creationParamsCodec: const StandardMessageCodec(),
      onPlatformViewCreated: _onPlatformViewCreated,
    );
  }

  void _onPlatformViewCreated(int viewId) {
    final channel = MethodChannel('oidea/pencil_canvas_$viewId');
    channel.setMethodCallHandler((call) async {
      if (call.method == 'onDrawingChanged') widget.onDrawingChanged?.call();
      return null;
    });
    widget.onCreated?.call(PencilCanvasController._(channel));
  }
}
