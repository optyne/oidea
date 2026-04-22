import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/network/api_client.dart';
import '../../../../core/network/socket_service.dart';
import '../../../auth/providers/auth_provider.dart';
import '../../providers/whiteboard_provider.dart';

enum DrawingTool { select, pen, line, arrow, rect, circle, text, sticky, eraser }

enum GridStyle { line, dot, none }

// ─── JSON 序列化 helper ───────────────────────────────────────────────────────

int _colorToInt(Color c) => c.toARGB32();
Color _intToColor(int v) => Color(v);

Map<String, dynamic> _itemToJson(CanvasItem it) {
  final base = {
    'id': it.id,
    'color': _colorToInt(it.color),
    'strokeWidth': it.strokeWidth,
  };
  if (it is PathItem) {
    return {
      ...base,
      'type': 'path',
      'points': it.points.map((p) => [p.dx, p.dy]).toList(),
    };
  }
  if (it is RectItem) {
    return {
      ...base,
      'type': 'rect',
      'x': it.topLeft.dx,
      'y': it.topLeft.dy,
      'w': it.size.width,
      'h': it.size.height,
    };
  }
  if (it is CircleItem) {
    return {
      ...base,
      'type': 'circle',
      'cx': it.center.dx,
      'cy': it.center.dy,
      'r': it.radius,
    };
  }
  if (it is LineItem) {
    return {
      ...base,
      'type': 'line',
      'x1': it.start.dx,
      'y1': it.start.dy,
      'x2': it.end.dx,
      'y2': it.end.dy,
    };
  }
  if (it is ArrowItem) {
    return {
      ...base,
      'type': 'arrow',
      'x1': it.start.dx,
      'y1': it.start.dy,
      'x2': it.end.dx,
      'y2': it.end.dy,
    };
  }
  if (it is TextItem) {
    return {
      ...base,
      'type': 'text',
      'x': it.position.dx,
      'y': it.position.dy,
      'text': it.text,
      'fontSize': it.fontSize,
    };
  }
  if (it is StickyItem) {
    return {
      ...base,
      'type': 'sticky',
      'x': it.position.dx,
      'y': it.position.dy,
      'text': it.text,
      'bgColor': _colorToInt(it.bgColor),
    };
  }
  return base;
}

CanvasItem? _itemFromJson(Map<String, dynamic> j) {
  final id = (j['id'] as String?) ?? '';
  final color = _intToColor((j['color'] as num?)?.toInt() ?? 0xFF000000);
  final strokeWidth = (j['strokeWidth'] as num?)?.toDouble() ?? 2.0;
  switch (j['type']) {
    case 'path':
      final pts = (j['points'] as List?)
              ?.map((p) => Offset(
                  (p[0] as num).toDouble(), (p[1] as num).toDouble()))
              .toList() ??
          [];
      return PathItem(id: id, points: pts, color: color, strokeWidth: strokeWidth);
    case 'rect':
      return RectItem(
        id: id,
        topLeft: Offset((j['x'] as num).toDouble(), (j['y'] as num).toDouble()),
        size: Size((j['w'] as num).toDouble(), (j['h'] as num).toDouble()),
        color: color,
        strokeWidth: strokeWidth,
      );
    case 'circle':
      return CircleItem(
        id: id,
        center: Offset((j['cx'] as num).toDouble(), (j['cy'] as num).toDouble()),
        radius: (j['r'] as num).toDouble(),
        color: color,
        strokeWidth: strokeWidth,
      );
    case 'line':
      return LineItem(
        id: id,
        start: Offset((j['x1'] as num).toDouble(), (j['y1'] as num).toDouble()),
        end: Offset((j['x2'] as num).toDouble(), (j['y2'] as num).toDouble()),
        color: color,
        strokeWidth: strokeWidth,
      );
    case 'arrow':
      return ArrowItem(
        id: id,
        start: Offset((j['x1'] as num).toDouble(), (j['y1'] as num).toDouble()),
        end: Offset((j['x2'] as num).toDouble(), (j['y2'] as num).toDouble()),
        color: color,
        strokeWidth: strokeWidth,
      );
    case 'text':
      return TextItem(
        id: id,
        position: Offset((j['x'] as num).toDouble(), (j['y'] as num).toDouble()),
        text: (j['text'] as String?) ?? '',
        color: color,
        fontSize: (j['fontSize'] as num?)?.toDouble() ?? 16,
      );
    case 'sticky':
      return StickyItem(
        id: id,
        position: Offset((j['x'] as num).toDouble(), (j['y'] as num).toDouble()),
        text: (j['text'] as String?) ?? '',
        bgColor: _intToColor((j['bgColor'] as num?)?.toInt() ?? 0xFFFFF9C4),
      );
  }
  return null;
}

// ─── Remote cursor (W-11 presence) ───────────────────────────────────────────

class _RemoteCursor {
  final String userId;
  final String displayName;
  final Color color;
  final Offset position;
  const _RemoteCursor({
    required this.userId,
    required this.displayName,
    required this.color,
    required this.position,
  });
}

const List<Color> _kPresenceColors = [
  Color(0xFF7C3AED),
  Color(0xFF06B6D4),
  Color(0xFFF59E0B),
  Color(0xFFEF4444),
  Color(0xFF10B981),
  Color(0xFFEC4899),
];

Color _presenceColor(String key) {
  final hash = key.codeUnits.fold<int>(0, (a, b) => a + b);
  return _kPresenceColors[hash % _kPresenceColors.length];
}

// ─── Canvas items ─────────────────────────────────────────────────────────────

abstract class CanvasItem {
  String id;
  Color color;
  double strokeWidth;
  bool selected;

  CanvasItem({
    required this.id,
    required this.color,
    required this.strokeWidth,
    this.selected = false,
  });

  Rect get bounds;
  CanvasItem copyMoved(Offset delta);
}

class PathItem extends CanvasItem {
  List<Offset> points;
  PathItem({required super.id, required this.points, required super.color, required super.strokeWidth});

  @override
  Rect get bounds {
    if (points.isEmpty) return Rect.zero;
    double minX = points.first.dx, maxX = points.first.dx;
    double minY = points.first.dy, maxY = points.first.dy;
    for (final p in points) {
      if (p.dx < minX) minX = p.dx;
      if (p.dx > maxX) maxX = p.dx;
      if (p.dy < minY) minY = p.dy;
      if (p.dy > maxY) maxY = p.dy;
    }
    return Rect.fromLTRB(minX, minY, maxX, maxY);
  }

  @override
  CanvasItem copyMoved(Offset delta) => PathItem(
      id: id, points: points.map((p) => p + delta).toList(), color: color, strokeWidth: strokeWidth);
}

class RectItem extends CanvasItem {
  Offset topLeft;
  Size size;
  RectItem({required super.id, required this.topLeft, required this.size, required super.color, required super.strokeWidth});

  @override
  Rect get bounds => Rect.fromLTWH(topLeft.dx, topLeft.dy, size.width.abs(), size.height.abs());

  @override
  CanvasItem copyMoved(Offset delta) => RectItem(
      id: id, topLeft: topLeft + delta, size: size, color: color, strokeWidth: strokeWidth);
}

class CircleItem extends CanvasItem {
  Offset center;
  double radius;
  CircleItem({required super.id, required this.center, required this.radius, required super.color, required super.strokeWidth});

  @override
  Rect get bounds => Rect.fromCircle(center: center, radius: radius);

  @override
  CanvasItem copyMoved(Offset delta) => CircleItem(
      id: id, center: center + delta, radius: radius, color: color, strokeWidth: strokeWidth);
}

class LineItem extends CanvasItem {
  Offset start;
  Offset end;
  LineItem({required super.id, required this.start, required this.end, required super.color, required super.strokeWidth});

  @override
  Rect get bounds => Rect.fromPoints(start, end);

  @override
  CanvasItem copyMoved(Offset delta) => LineItem(
      id: id, start: start + delta, end: end + delta, color: color, strokeWidth: strokeWidth);
}

class ArrowItem extends CanvasItem {
  Offset start;
  Offset end;
  ArrowItem({required super.id, required this.start, required this.end, required super.color, required super.strokeWidth});

  @override
  Rect get bounds => Rect.fromPoints(start, end).inflate(12);

  @override
  CanvasItem copyMoved(Offset delta) => ArrowItem(
      id: id, start: start + delta, end: end + delta, color: color, strokeWidth: strokeWidth);
}

class TextItem extends CanvasItem {
  Offset position;
  String text;
  double fontSize;
  TextItem({required super.id, required this.position, required this.text, required super.color, super.strokeWidth = 1, this.fontSize = 16});

  @override
  Rect get bounds {
    final w = (text.length * fontSize * 0.65).clamp(40.0, 800.0);
    return Rect.fromLTWH(position.dx, position.dy, w, fontSize * 1.5);
  }

  @override
  CanvasItem copyMoved(Offset delta) => TextItem(
      id: id, position: position + delta, text: text, color: color, fontSize: fontSize);
}

class StickyItem extends CanvasItem {
  Offset position;
  String text;
  Color bgColor;
  static const double kSize = 160;
  StickyItem({required super.id, required this.position, required this.text, required this.bgColor, super.color = Colors.black87, super.strokeWidth = 1});

  @override
  Rect get bounds => Rect.fromLTWH(position.dx, position.dy, kSize, kSize);

  @override
  CanvasItem copyMoved(Offset delta) => StickyItem(
      id: id, position: position + delta, text: text, bgColor: bgColor, color: color);
}

// ─── Painter ──────────────────────────────────────────────────────────────────

class _CanvasPainter extends CustomPainter {
  final List<CanvasItem> items;
  final CanvasItem? currentItem;
  final GridStyle gridStyle;
  final List<_RemoteCursor> remoteCursors;

  _CanvasPainter({
    required this.items,
    this.currentItem,
    this.gridStyle = GridStyle.line,
    this.remoteCursors = const [],
  });

  @override
  void paint(Canvas canvas, Size size) {
    _drawGrid(canvas, size);

    for (final item in [...items, if (currentItem != null) currentItem!]) {
      _draw(canvas, item);
    }

    // 遠端協作者游標(W-11 presence)
    for (final c in remoteCursors) {
      _drawRemoteCursor(canvas, c);
    }
  }

  void _drawGrid(Canvas canvas, Size size) {
    switch (gridStyle) {
      case GridStyle.line:
        final gp = Paint()..color = const Color(0xFFE5E7EB)..strokeWidth = 0.5;
        for (double x = 0; x < size.width; x += 40) {
          canvas.drawLine(Offset(x, 0), Offset(x, size.height), gp);
        }
        for (double y = 0; y < size.height; y += 40) {
          canvas.drawLine(Offset(0, y), Offset(size.width, y), gp);
        }
        break;
      case GridStyle.dot:
        final dp = Paint()..color = const Color(0xFF4F46E5).withValues(alpha: 0.12);
        for (double x = 0; x < size.width; x += 28) {
          for (double y = 0; y < size.height; y += 28) {
            canvas.drawCircle(Offset(x, y), 1.2, dp);
          }
        }
        break;
      case GridStyle.none:
        break;
    }
  }

  void _drawRemoteCursor(Canvas canvas, _RemoteCursor c) {
    final path = Path()
      ..moveTo(c.position.dx, c.position.dy)
      ..lineTo(c.position.dx + 14, c.position.dy + 4)
      ..lineTo(c.position.dx + 4, c.position.dy + 14)
      ..close();
    canvas.drawPath(path, Paint()..color = c.color);
    final tp = TextPainter(
      text: TextSpan(
        text: c.displayName,
        style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w600),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    final rect = Rect.fromLTWH(
      c.position.dx + 10,
      c.position.dy + 12,
      tp.width + 10,
      tp.height + 4,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, const Radius.circular(3)),
      Paint()..color = c.color,
    );
    tp.paint(canvas, Offset(rect.left + 5, rect.top + 2));
  }

  void _draw(Canvas canvas, CanvasItem item) {
    final p = Paint()
      ..color = item.color
      ..strokeWidth = item.strokeWidth
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    if (item is PathItem) {
      if (item.points.length < 2) return;
      final path = Path()..moveTo(item.points.first.dx, item.points.first.dy);
      for (int i = 1; i < item.points.length; i++) {
        path.lineTo(item.points[i].dx, item.points[i].dy);
      }
      canvas.drawPath(path, p);
    } else if (item is RectItem) {
      final rect = Rect.fromLTWH(item.topLeft.dx, item.topLeft.dy, item.size.width, item.size.height);
      canvas.drawRect(rect, p..style = PaintingStyle.fill..color = item.color.withOpacity(0.08));
      canvas.drawRect(rect, p..style = PaintingStyle.stroke..color = item.color..strokeWidth = item.strokeWidth);
    } else if (item is CircleItem) {
      canvas.drawCircle(item.center, item.radius, p..style = PaintingStyle.fill..color = item.color.withOpacity(0.08));
      canvas.drawCircle(item.center, item.radius, p..style = PaintingStyle.stroke..color = item.color..strokeWidth = item.strokeWidth);
    } else if (item is LineItem) {
      canvas.drawLine(item.start, item.end, p);
    } else if (item is ArrowItem) {
      // 主體線
      canvas.drawLine(item.start, item.end, p);
      // 箭頭頭部
      final dx = item.end.dx - item.start.dx;
      final dy = item.end.dy - item.start.dy;
      final angle = math.atan2(dy, dx);
      final headLen = 10.0 + item.strokeWidth * 1.5;
      final wing = math.pi / 7; // 約 25°
      final tip = item.end;
      final wing1 = Offset(
        tip.dx - headLen * math.cos(angle - wing),
        tip.dy - headLen * math.sin(angle - wing),
      );
      final wing2 = Offset(
        tip.dx - headLen * math.cos(angle + wing),
        tip.dy - headLen * math.sin(angle + wing),
      );
      final path = Path()
        ..moveTo(tip.dx, tip.dy)
        ..lineTo(wing1.dx, wing1.dy)
        ..lineTo(wing2.dx, wing2.dy)
        ..close();
      canvas.drawPath(
        path,
        Paint()
          ..color = item.color
          ..style = PaintingStyle.fill,
      );
    } else if (item is TextItem) {
      final tp = TextPainter(
        text: TextSpan(text: item.text, style: TextStyle(color: item.color, fontSize: item.fontSize, fontWeight: FontWeight.w500)),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, item.position);
    } else if (item is StickyItem) {
      final rect = item.bounds;
      final rr = RRect.fromRectAndRadius(rect, const Radius.circular(8));
      canvas.drawRRect(rr.shift(const Offset(2, 3)),
          Paint()..color = Colors.black.withOpacity(0.12)..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4));
      canvas.drawRRect(rr, Paint()..color = item.bgColor);
      canvas.drawRRect(rr, Paint()..color = item.bgColor.withOpacity(0.6)..style = PaintingStyle.stroke..strokeWidth = 1.5);
      final tp = TextPainter(
        text: TextSpan(text: item.text, style: TextStyle(color: item.color, fontSize: 14, height: 1.4)),
        textDirection: TextDirection.ltr,
      )..layout(maxWidth: StickyItem.kSize - 16);
      tp.paint(canvas, item.position + const Offset(8, 8));
    }

    // Selection highlight
    if (item.selected) {
      final b = item.bounds.inflate(6);
      canvas.drawRect(
        b,
        Paint()
          ..color = const Color(0xFF4F46E5)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
      // Corner handles
      const hSize = 6.0;
      for (final corner in [b.topLeft, b.topRight, b.bottomLeft, b.bottomRight]) {
        canvas.drawRect(
          Rect.fromCenter(center: corner, width: hSize, height: hSize),
          Paint()..color = const Color(0xFF4F46E5),
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant _CanvasPainter old) => true;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

class WhiteboardCanvasPage extends ConsumerStatefulWidget {
  final String boardId;
  const WhiteboardCanvasPage({super.key, required this.boardId});

  @override
  ConsumerState<WhiteboardCanvasPage> createState() => _WhiteboardCanvasPageState();
}

class _WhiteboardCanvasPageState extends ConsumerState<WhiteboardCanvasPage> {
  DrawingTool _currentTool = DrawingTool.select;
  Color _currentColor = const Color(0xFF4F46E5);
  double _strokeWidth = 3.0;
  final TransformationController _tc = TransformationController();

  final List<CanvasItem> _items = [];
  final List<List<CanvasItem>> _undoStack = [];
  final List<List<CanvasItem>> _redoStack = [];

  Offset? _dragStart;
  CanvasItem? _currentItem;
  String? _selectedId;
  Offset? _moveDragPrev;
  int _idCounter = 0;

  Timer? _saveDebounce;
  bool _loaded = false;
  bool _saving = false;
  bool _dirty = false;
  DateTime? _lastSavedAt;
  String? _lastSaveError;
  static const Duration _saveDebounceDuration = Duration(milliseconds: 800);

  // W-11 背景 / 協作者游標 / 匯出
  GridStyle _gridStyle = GridStyle.line;
  final GlobalKey _exportKey = GlobalKey();
  final List<_RemoteCursor> _remoteCursors = []; // 目前為 UI stub,後端 presence 事件未連
  final List<Map<String, dynamic>> _presenceUsers = []; // 目前僅含自己

  // Zoom / pan state
  static const double _canvasWidth = 4000;
  static const double _canvasHeight = 3000;
  static const double _minScale = 0.1;
  static const double _maxScale = 5.0;
  double _scale = 1.0; // 顯示用；實際來源 _tc.value

  void _onTransformChanged() {
    final s = _tc.value.getMaxScaleOnAxis();
    if ((s - _scale).abs() > 0.005) {
      setState(() => _scale = s);
    }
  }

  void _applyScale(double target, {Offset? focal}) {
    final clamped = target.clamp(_minScale, _maxScale);
    final current = _tc.value.getMaxScaleOnAxis();
    if ((clamped - current).abs() < 0.001) return;
    final factor = clamped / current;
    final f = focal ?? Offset(MediaQuery.of(context).size.width / 2,
        (MediaQuery.of(context).size.height - 50) / 2);
    _tc.value = _tc.value.clone()
      ..translate(f.dx, f.dy)
      ..scale(factor)
      ..translate(-f.dx, -f.dy);
  }

  void _zoomIn() => _applyScale(_scale * 1.25);
  void _zoomOut() => _applyScale(_scale / 1.25);
  void _resetView() {
    _tc.value = Matrix4.identity();
    setState(() => _scale = 1.0);
  }

  void _onScrollZoom(PointerScrollEvent e) {
    // 只在按住 Ctrl 時才縮放，否則讓 InteractiveViewer 走 pan（滾輪=上下卷）
    if (!HardwareKeyboard.instance.isControlPressed &&
        !HardwareKeyboard.instance.isMetaPressed) return;
    final delta = -e.scrollDelta.dy;
    final factor = delta > 0 ? 1.1 : (1 / 1.1);
    _applyScale(_scale * factor, focal: e.localPosition);
  }

  static const _stickyColors = [
    Color(0xFFFFF9C4),
    Color(0xFFB3E5FC),
    Color(0xFFC8E6C9),
    Color(0xFFFFCCBC),
    Color(0xFFE1BEE7),
  ];

  final _colorPalette = const [
    Color(0xFF4F46E5), Color(0xFF7C3AED), Color(0xFF06B6D4),
    Color(0xFF10B981), Color(0xFFF59E0B), Color(0xFFEF4444),
    Color(0xFFEC4899), Color(0xFF1F2937), Colors.white,
  ];

  String _nextId() => 'i${++_idCounter}';

  void _saveUndo() {
    _undoStack.add(List.from(_items));
    if (_undoStack.length > 50) _undoStack.removeAt(0);
    _redoStack.clear();
  }

  void _undo() {
    if (_undoStack.isEmpty) return;
    _redoStack.add(List.from(_items));
    final prev = _undoStack.removeLast();
    setState(() { _items..clear()..addAll(prev); _selectedId = null; });
    _scheduleSave();
  }

  void _redo() {
    if (_redoStack.isEmpty) return;
    _undoStack.add(List.from(_items));
    final next = _redoStack.removeLast();
    setState(() { _items..clear()..addAll(next); _selectedId = null; });
    _scheduleSave();
  }

  @override
  void initState() {
    super.initState();
    ref.read(socketProvider).joinBoard(widget.boardId);
    _tc.addListener(_onTransformChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadInitial());
  }

  Future<void> _loadInitial() async {
    try {
      final board = await ref.read(whiteboardProvider(widget.boardId).future);
      final data = board['data'];
      if (data is Map<String, dynamic>) {
        final items = data['canvasItems'];
        if (items is List) {
          final loaded = <CanvasItem>[];
          for (final raw in items) {
            if (raw is Map<String, dynamic>) {
              final it = _itemFromJson(raw);
              if (it != null) loaded.add(it);
            }
          }
          if (mounted) {
            setState(() {
              _items
                ..clear()
                ..addAll(loaded);
              _idCounter = loaded.length;
            });
          }
        }
      }
    } catch (_) {
      // 載入失敗就從空白畫布開始，不阻塞 UI
    } finally {
      _loaded = true;
    }
  }

  void _scheduleSave() {
    if (!_loaded) return; // 還沒載完就別存，避免用空陣列覆蓋
    _dirty = true;
    if (mounted) setState(() {}); // 讓頂部「儲存中」指示亮起
    _saveDebounce?.cancel();
    _saveDebounce = Timer(_saveDebounceDuration, _flushSave);
  }

  /// 立刻 flush(忽略 debounce);保留 retry:若 saving 中則等結束再 flush 一次。
  Future<void> _flushSave() async {
    if (_saving) {
      // 正在存的中途又有新編輯;等結束後我們會被再次呼叫。這裡先把狀態反映上去。
      return;
    }
    if (!_dirty) return;
    _saveDebounce?.cancel();
    _saving = true;
    _dirty = false;
    final payload = _items.map(_itemToJson).toList();
    try {
      await ref.read(apiClientProvider).saveWhiteboardCanvas(widget.boardId, payload);
      _lastSavedAt = DateTime.now();
      _lastSaveError = null;
    } catch (e) {
      _dirty = true; // 下次再試
      _lastSaveError = e.toString();
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('白板儲存失敗:$e')));
      }
    } finally {
      _saving = false;
      if (mounted) setState(() {});
      // 若在 save 的過程中又髒了(_dirty 重新為 true),馬上再存一次
      if (_dirty && mounted) {
        unawaited(_flushSave());
      }
    }
  }

  /// 返回前同步 flush,避免 dispose fire-and-forget 被打斷。
  Future<void> _flushAndPop() async {
    _saveDebounce?.cancel();
    if (_dirty) {
      await _flushSave();
    }
    if (mounted) Navigator.pop(context);
  }

  @override
  void dispose() {
    _saveDebounce?.cancel();
    if (_dirty) {
      // fire-and-forget；dispose 不能 await
      final payload = _items.map(_itemToJson).toList();
      unawaited(
        ref.read(apiClientProvider).saveWhiteboardCanvas(widget.boardId, payload).onError((_, __) {}),
      );
    }
    ref.read(socketProvider).leaveBoard(widget.boardId);
    _tc.removeListener(_onTransformChanged);
    _tc.dispose();
    super.dispose();
  }

  CanvasItem? _hitTest(Offset pos) {
    for (int i = _items.length - 1; i >= 0; i--) {
      if (_items[i].bounds.inflate(8).contains(pos)) return _items[i];
    }
    return null;
  }

  void _onPanStart(DragStartDetails d) {
    final pos = d.localPosition;
    _dragStart = pos;

    if (_currentTool == DrawingTool.select) {
      final hit = _hitTest(pos);
      _selectedId = hit?.id;
      _moveDragPrev = hit != null ? pos : null;
      setState(() {
        for (final it in _items) it.selected = it.id == hit?.id;
      });
      return;
    }

    if (_currentTool == DrawingTool.eraser || _currentTool == DrawingTool.text || _currentTool == DrawingTool.sticky) return;

    if (_currentTool == DrawingTool.pen) {
      _currentItem = PathItem(id: _nextId(), points: [pos], color: _currentColor, strokeWidth: _strokeWidth);
    } else if (_currentTool == DrawingTool.rect) {
      _currentItem = RectItem(id: _nextId(), topLeft: pos, size: Size.zero, color: _currentColor, strokeWidth: _strokeWidth);
    } else if (_currentTool == DrawingTool.circle) {
      _currentItem = CircleItem(id: _nextId(), center: pos, radius: 0, color: _currentColor, strokeWidth: _strokeWidth);
    } else if (_currentTool == DrawingTool.line) {
      _currentItem = LineItem(id: _nextId(), start: pos, end: pos, color: _currentColor, strokeWidth: _strokeWidth);
    } else if (_currentTool == DrawingTool.arrow) {
      _currentItem = ArrowItem(id: _nextId(), start: pos, end: pos, color: _currentColor, strokeWidth: _strokeWidth);
    }
    setState(() {});
  }

  void _onPanUpdate(DragUpdateDetails d) {
    final pos = d.localPosition;

    if (_currentTool == DrawingTool.select) {
      if (_selectedId != null && _moveDragPrev != null) {
        final delta = pos - _moveDragPrev!;
        _moveDragPrev = pos;
        setState(() {
          final idx = _items.indexWhere((it) => it.id == _selectedId);
          if (idx >= 0) {
            final moved = _items[idx].copyMoved(delta);
            moved.selected = true;
            _items[idx] = moved;
          }
        });
        _scheduleSave();
      }
      return;
    }

    if (_currentTool == DrawingTool.eraser) {
      final toRemove = _items.where((it) => it.bounds.inflate(12).contains(pos)).map((it) => it.id).toSet();
      if (toRemove.isNotEmpty) {
        _saveUndo();
        setState(() => _items.removeWhere((it) => toRemove.contains(it.id)));
        _scheduleSave();
      }
      return;
    }

    if (_currentItem == null) return;
    setState(() {
      if (_currentItem is PathItem) {
        (_currentItem as PathItem).points.add(pos);
      } else if (_currentItem is RectItem) {
        final r = Rect.fromPoints(_dragStart!, pos);
        (_currentItem as RectItem)..topLeft = r.topLeft..size = r.size;
      } else if (_currentItem is CircleItem) {
        (_currentItem as CircleItem).radius = (pos - _dragStart!).distance;
      } else if (_currentItem is LineItem) {
        (_currentItem as LineItem).end = pos;
      } else if (_currentItem is ArrowItem) {
        (_currentItem as ArrowItem).end = pos;
      }
    });
  }

  void _onPanEnd(DragEndDetails _) {
    if (_currentTool == DrawingTool.select) {
      _moveDragPrev = null;
      return;
    }
    if (_currentItem != null) {
      _saveUndo();
      setState(() { _items.add(_currentItem!); _currentItem = null; });
      _scheduleSave();
    }
    _dragStart = null;
  }

  void _onTapUp(TapUpDetails d) {
    if (_currentTool == DrawingTool.text) _showTextInput(d.localPosition);
    if (_currentTool == DrawingTool.sticky) _showStickyInput(d.localPosition);
  }

  Future<void> _showTextInput(Offset pos) async {
    final ctrl = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('插入文字'),
        content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(hintText: '輸入文字…', border: OutlineInputBorder())),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () { final t = ctrl.text.trim(); if (t.isNotEmpty) Navigator.pop(ctx, t); }, child: const Text('插入')),
        ],
      ),
    );
    ctrl.dispose();
    if (result == null) return;
    _saveUndo();
    setState(() => _items.add(TextItem(id: _nextId(), position: pos, text: result, color: _currentColor)));
    _scheduleSave();
  }

  Future<void> _showStickyInput(Offset pos) async {
    final ctrl = TextEditingController();
    Color bg = _stickyColors.first;
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('新增便利貼'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: ctrl, autofocus: true, maxLines: 3, decoration: const InputDecoration(hintText: '便利貼內容…', border: OutlineInputBorder())),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: _stickyColors.map((c) => GestureDetector(
                  onTap: () => setSt(() => bg = c),
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 4),
                    width: 28, height: 28,
                    decoration: BoxDecoration(
                      color: c, shape: BoxShape.circle,
                      border: bg == c ? Border.all(color: const Color(0xFF4F46E5), width: 2.5) : Border.all(color: Colors.grey.shade300),
                    ),
                  ),
                )).toList(),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, {'text': ctrl.text, 'color': bg}), child: const Text('插入')),
          ],
        ),
      ),
    );
    ctrl.dispose();
    if (result == null) return;
    _saveUndo();
    setState(() => _items.add(StickyItem(id: _nextId(), position: pos, text: result['text'] as String, bgColor: result['color'] as Color)));
    _scheduleSave();
  }

  void _deleteSelected() {
    if (_selectedId == null) return;
    _saveUndo();
    setState(() { _items.removeWhere((it) => it.id == _selectedId); _selectedId = null; });
    _scheduleSave();
  }

  // ─── Template 套用(W-XX) ──────────────────────────────────────────────
  // 對齊 prototype OideaWhiteboard.jsx L20–56 的三套預設模板。
  void _applyTemplate(String kind) {
    final now = DateTime.now().millisecondsSinceEpoch;
    String nid() => 'tpl$now-${_idCounter++}';
    final items = <CanvasItem>[];
    switch (kind) {
      case 'brainstorm':
        items.addAll([
          TextItem(
            id: nid(),
            position: const Offset(200, 120),
            text: '🧠 腦力激盪',
            color: const Color(0xFF0D0D1F),
            fontSize: 28,
          ),
          RectItem(
            id: nid(),
            topLeft: const Offset(180, 180),
            size: const Size(560, 380),
            color: const Color(0xFF4F46E5),
            strokeWidth: 2,
          ),
          StickyItem(id: nid(), position: const Offset(220, 220), text: '想法 1', bgColor: _stickyColors[0]),
          StickyItem(id: nid(), position: const Offset(400, 220), text: '想法 2', bgColor: _stickyColors[1]),
          StickyItem(id: nid(), position: const Offset(580, 220), text: '想法 3', bgColor: _stickyColors[2]),
          StickyItem(id: nid(), position: const Offset(220, 400), text: '挑戰', bgColor: _stickyColors[3]),
          StickyItem(id: nid(), position: const Offset(400, 400), text: '機會', bgColor: _stickyColors[4]),
          StickyItem(id: nid(), position: const Offset(580, 400), text: '行動', bgColor: _stickyColors[0]),
        ]);
        break;
      case 'retro':
        const colW = 260.0;
        for (var i = 0; i < 3; i++) {
          final x = 200.0 + i * colW;
          items.add(RectItem(
            id: nid(),
            topLeft: Offset(x, 160),
            size: const Size(colW - 20, 460),
            color: const Color(0xFF7C3AED),
            strokeWidth: 1,
          ));
          items.add(TextItem(
            id: nid(),
            position: Offset(x + 12, 176),
            text: ['✅ 做得好', '⚠️ 待改進', '💡 試試看'][i],
            color: const Color(0xFF0D0D1F),
            fontSize: 18,
          ));
        }
        break;
      case 'kanban':
        const lanes = ['待辦', '進行中', '完成'];
        for (var i = 0; i < lanes.length; i++) {
          final x = 200.0 + i * 260;
          items.add(TextItem(
            id: nid(),
            position: Offset(x, 140),
            text: lanes[i],
            color: const Color(0xFF0D0D1F),
            fontSize: 18,
          ));
          for (var j = 0; j < 3; j++) {
            items.add(StickyItem(
              id: nid(),
              position: Offset(x, 180.0 + j * 70),
              text: '${lanes[i]} 任務 ${j + 1}',
              bgColor: _stickyColors[(i + j) % _stickyColors.length],
            ));
          }
        }
        break;
    }
    if (items.isEmpty) return;
    _saveUndo();
    setState(() => _items.addAll(items));
    _scheduleSave();
  }

  // ─── Export PNG(W-XX) ─────────────────────────────────────────────────
  Future<void> _exportPng() async {
    try {
      final boundary = _exportKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      if (boundary == null) return;
      final image = await boundary.toImage(pixelRatio: 2.0);
      final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
      if (byteData == null) return;
      final bytes = byteData.buffer.asUint8List();
      final savePath = await FilePicker.platform.saveFile(
        dialogTitle: '匯出為 PNG',
        fileName: 'whiteboard-${DateTime.now().millisecondsSinceEpoch}.png',
        type: FileType.image,
        bytes: bytes,
      );
      if (!mounted) return;
      if (savePath != null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('已匯出:$savePath')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('匯出失敗:$e')));
      }
    }
  }

  void _cycleGrid() {
    setState(() {
      _gridStyle = switch (_gridStyle) {
        GridStyle.line => GridStyle.dot,
        GridStyle.dot => GridStyle.none,
        GridStyle.none => GridStyle.line,
      };
    });
  }

  String get _gridLabel => switch (_gridStyle) {
        GridStyle.line => '格線',
        GridStyle.dot => '點陣',
        GridStyle.none => '無背景',
      };

  IconData get _gridIcon => switch (_gridStyle) {
        GridStyle.line => Icons.grid_on,
        GridStyle.dot => Icons.grain,
        GridStyle.none => Icons.grid_off,
      };

  Future<void> _pickTemplate() async {
    final kind = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Row(
                children: [
                  Icon(Icons.dashboard_customize_outlined, size: 18),
                  SizedBox(width: 6),
                  Text('套用範本', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                ],
              ),
            ),
            ListTile(
              leading: const Text('🧠', style: TextStyle(fontSize: 22)),
              title: const Text('腦力激盪'),
              subtitle: const Text('6 張便利貼 + 框架'),
              onTap: () => Navigator.pop(ctx, 'brainstorm'),
            ),
            ListTile(
              leading: const Text('🔄', style: TextStyle(fontSize: 22)),
              title: const Text('Sprint Retrospective'),
              subtitle: const Text('做得好 / 待改進 / 試試看'),
              onTap: () => Navigator.pop(ctx, 'retro'),
            ),
            ListTile(
              leading: const Text('📋', style: TextStyle(fontSize: 22)),
              title: const Text('迷你 Kanban'),
              subtitle: const Text('待辦 / 進行中 / 完成 × 3 張卡'),
              onTap: () => Navigator.pop(ctx, 'kanban'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (kind != null) _applyTemplate(kind);
  }

  @override
  Widget build(BuildContext context) {
    final boardAsync = ref.watch(whiteboardProvider(widget.boardId));

    return Scaffold(
      backgroundColor: Colors.white,
      body: Shortcuts(
        shortcuts: const <ShortcutActivator, Intent>{
          SingleActivator(LogicalKeyboardKey.equal, control: true): _ZoomInIntent(),
          SingleActivator(LogicalKeyboardKey.add, control: true): _ZoomInIntent(),
          SingleActivator(LogicalKeyboardKey.minus, control: true): _ZoomOutIntent(),
          SingleActivator(LogicalKeyboardKey.numpadSubtract, control: true): _ZoomOutIntent(),
          SingleActivator(LogicalKeyboardKey.digit0, control: true): _ResetViewIntent(),
          SingleActivator(LogicalKeyboardKey.numpad0, control: true): _ResetViewIntent(),
        },
        child: Actions(
          actions: <Type, Action<Intent>>{
            _ZoomInIntent: CallbackAction<_ZoomInIntent>(onInvoke: (_) { _zoomIn(); return null; }),
            _ZoomOutIntent: CallbackAction<_ZoomOutIntent>(onInvoke: (_) { _zoomOut(); return null; }),
            _ResetViewIntent: CallbackAction<_ResetViewIntent>(onInvoke: (_) { _resetView(); return null; }),
          },
          child: Focus(
            autofocus: true,
            child: Column(
        children: [
          // App bar
          Container(
            height: 50,
            color: Colors.grey.shade100,
            child: Row(
              children: [
                IconButton(icon: const Icon(Icons.arrow_back), onPressed: _flushAndPop),
                boardAsync.when(
                  data: (b) => Text(b['title'] ?? '白板', style: const TextStyle(fontWeight: FontWeight.w600)),
                  loading: () => const Text('載入中...'),
                  error: (_, __) => const Text('白板'),
                ),
                const SizedBox(width: 10),
                _SaveStatus(
                  saving: _saving,
                  dirty: _dirty,
                  lastSavedAt: _lastSavedAt,
                  lastError: _lastSaveError,
                  onRetry: _flushSave,
                ),
                const Spacer(),
                IconButton(
                  tooltip: '縮小 (Ctrl+-)',
                  icon: const Icon(Icons.zoom_out),
                  onPressed: _scale <= _minScale + 0.001 ? null : _zoomOut,
                ),
                SizedBox(
                  width: 52,
                  child: Center(
                    child: InkWell(
                      onTap: _resetView,
                      borderRadius: BorderRadius.circular(6),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                        child: Text(
                          '${(_scale * 100).round()}%',
                          style: const TextStyle(fontSize: 12, fontFeatures: [FontFeature.tabularFigures()]),
                        ),
                      ),
                    ),
                  ),
                ),
                IconButton(
                  tooltip: '放大 (Ctrl++)',
                  icon: const Icon(Icons.zoom_in),
                  onPressed: _scale >= _maxScale - 0.001 ? null : _zoomIn,
                ),
                IconButton(
                  tooltip: '重設檢視 (100%)',
                  icon: const Icon(Icons.crop_free),
                  onPressed: _resetView,
                ),
                Container(width: 1, height: 24, color: Colors.grey.shade300, margin: const EdgeInsets.symmetric(horizontal: 6)),
                IconButton(
                  tooltip: '背景樣式($_gridLabel)',
                  icon: Icon(_gridIcon),
                  onPressed: _cycleGrid,
                ),
                IconButton(
                  tooltip: '套用範本',
                  icon: const Icon(Icons.dashboard_customize_outlined),
                  onPressed: _pickTemplate,
                ),
                IconButton(
                  tooltip: '匯出 PNG',
                  icon: const Icon(Icons.file_download_outlined),
                  onPressed: _items.isEmpty ? null : _exportPng,
                ),
                Container(width: 1, height: 24, color: Colors.grey.shade300, margin: const EdgeInsets.symmetric(horizontal: 6)),
                IconButton(tooltip: '復原', icon: Icon(Icons.undo, color: _undoStack.isEmpty ? Colors.grey.shade300 : null), onPressed: _undoStack.isEmpty ? null : _undo),
                IconButton(tooltip: '重做', icon: Icon(Icons.redo, color: _redoStack.isEmpty ? Colors.grey.shade300 : null), onPressed: _redoStack.isEmpty ? null : _redo),
                IconButton(
                  tooltip: '清除全部',
                  icon: Icon(Icons.delete_sweep_outlined, color: _items.isEmpty ? Colors.grey.shade300 : null),
                  onPressed: _items.isEmpty ? null : () => showDialog<void>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: const Text('清除畫布'),
                      content: const Text('確定要清除所有內容嗎？'),
                      actions: [
                        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
                        FilledButton(style: FilledButton.styleFrom(backgroundColor: Colors.red),
                            onPressed: () { Navigator.pop(ctx); _saveUndo(); setState(() { _items.clear(); _selectedId = null; }); _scheduleSave(); },
                            child: const Text('清除')),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 8),
              ],
            ),
          ),

          Expanded(
            child: Stack(
              children: [
                Listener(
                  onPointerSignal: (e) {
                    if (e is PointerScrollEvent) _onScrollZoom(e);
                  },
                  child: InteractiveViewer(
                    transformationController: _tc,
                    minScale: _minScale,
                    maxScale: _maxScale,
                    // 所有工具都能用兩指 pan；select 工具額外開啟單指 pan
                    panEnabled: _currentTool == DrawingTool.select,
                    scaleEnabled: true,
                    trackpadScrollCausesScale: true,
                    boundaryMargin: const EdgeInsets.all(800),
                    child: GestureDetector(
                      onPanStart: _onPanStart,
                      onPanUpdate: _onPanUpdate,
                      onPanEnd: _onPanEnd,
                      onTapUp: _onTapUp,
                      child: RepaintBoundary(
                        key: _exportKey,
                        child: SizedBox(
                          width: _canvasWidth,
                          height: _canvasHeight,
                          child: CustomPaint(
                            painter: _CanvasPainter(
                              items: _items,
                              currentItem: _currentItem,
                              gridStyle: _gridStyle,
                              remoteCursors: _remoteCursors,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),

                // Tool panel (left)
                Positioned(
                  left: 12,
                  top: 12,
                  child: Container(
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10)],
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: DrawingTool.values.map((tool) {
                        final sel = _currentTool == tool;
                        return Tooltip(
                          message: _toolName(tool),
                          child: IconButton(
                            icon: Icon(_toolIcon(tool), color: sel ? const Color(0xFF4F46E5) : Colors.grey.shade600),
                            style: sel ? IconButton.styleFrom(backgroundColor: const Color(0xFF4F46E5).withOpacity(0.1)) : null,
                            onPressed: () => setState(() {
                              _currentTool = tool;
                              if (tool != DrawingTool.select) {
                                _selectedId = null;
                                for (final it in _items) it.selected = false;
                              }
                            }),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                ),

                // Presence card (right, 對齊 prototype L374–381)
                Positioned(
                  right: 12,
                  top: 12,
                  child: _PresenceCard(
                    users: _presenceUsers,
                    self: ref.read(authStateProvider),
                  ),
                ),

                // Color panel (right, 下移以避開 presence card)
                Positioned(
                  right: 12,
                  top: 60,
                  child: Container(
                    padding: const EdgeInsets.all(8),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10)],
                    ),
                    child: Wrap(
                      spacing: 4, runSpacing: 4,
                      children: _colorPalette.map((c) {
                        final sel = _currentColor == c;
                        return GestureDetector(
                          onTap: () => setState(() => _currentColor = c),
                          child: Container(
                            width: 24, height: 24,
                            decoration: BoxDecoration(
                              color: c, shape: BoxShape.circle,
                              border: sel ? Border.all(color: const Color(0xFF4F46E5), width: 2.5) : Border.all(color: Colors.grey.shade300),
                            ),
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                ),

                // Stroke slider (right bottom) – only for drawing tools
                if (_currentTool != DrawingTool.text && _currentTool != DrawingTool.sticky && _currentTool != DrawingTool.select)
                  Positioned(
                    right: 12,
                    bottom: 60,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10)],
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Text('粗細', style: TextStyle(fontSize: 11)),
                          SizedBox(
                            width: 120,
                            child: Slider(
                              value: _strokeWidth, min: 1, max: 20, divisions: 19,
                              label: _strokeWidth.toStringAsFixed(0),
                              onChanged: (v) => setState(() => _strokeWidth = v),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),

                // Delete button
                if (_selectedId != null)
                  Positioned(
                    bottom: 16,
                    left: 0, right: 0,
                    child: Center(
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(backgroundColor: Colors.red),
                        icon: const Icon(Icons.delete),
                        label: const Text('刪除選取'),
                        onPressed: _deleteSelected,
                      ),
                    ),
                  ),

                // Cursor hint
                Positioned(
                  bottom: 16, right: 16,
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: Colors.black54,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      _toolHint(_currentTool),
                      style: const TextStyle(color: Colors.white, fontSize: 12),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
            ),
          ),
        ),
      ),
    );
  }

  IconData _toolIcon(DrawingTool t) => const {
    DrawingTool.select: Icons.near_me,
    DrawingTool.pen: Icons.edit,
    DrawingTool.line: Icons.horizontal_rule,
    DrawingTool.arrow: Icons.arrow_forward,
    DrawingTool.rect: Icons.crop_square,
    DrawingTool.circle: Icons.circle_outlined,
    DrawingTool.text: Icons.text_fields,
    DrawingTool.sticky: Icons.sticky_note_2,
    DrawingTool.eraser: Icons.cleaning_services,
  }[t]!;

  String _toolName(DrawingTool t) => const {
    DrawingTool.select: '選取 / 移動',
    DrawingTool.pen: '畫筆',
    DrawingTool.line: '直線',
    DrawingTool.arrow: '箭頭 / 連接線',
    DrawingTool.rect: '矩形',
    DrawingTool.circle: '圓形',
    DrawingTool.text: '文字',
    DrawingTool.sticky: '便利貼',
    DrawingTool.eraser: '橡皮擦',
  }[t]!;

  String _toolHint(DrawingTool t) {
    if (t == DrawingTool.text || t == DrawingTool.sticky) return '點擊畫布插入';
    if (t == DrawingTool.select) return '點擊選取，拖曳移動';
    if (t == DrawingTool.eraser) return '拖曳擦除';
    return '拖曳繪製 · Ctrl+滾輪縮放 · Ctrl+0 重設檢視';
  }
}

class _ZoomInIntent extends Intent {
  const _ZoomInIntent();
}

class _ZoomOutIntent extends Intent {
  const _ZoomOutIntent();
}

class _ResetViewIntent extends Intent {
  const _ResetViewIntent();
}

// ─── Presence card(W-11) ─────────────────────────────────────────────────────
// 顯示當前在線協作者;後端 presence 事件尚未接上,目前僅顯示自己。
class _PresenceCard extends StatelessWidget {
  final List<Map<String, dynamic>> users;
  final AuthState self;
  const _PresenceCard({required this.users, required this.self});

  @override
  Widget build(BuildContext context) {
    final all = <Map<String, dynamic>>[
      if (self.userId != null)
        {
          'id': self.userId,
          'displayName': self.displayName ?? self.email ?? 'You',
          'isSelf': true,
        },
      ...users,
    ];
    if (all.isEmpty) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.1), blurRadius: 8)],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: const BoxDecoration(color: Color(0xFF10B981), shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text(
            '線上 ${all.length}',
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
          ),
          const SizedBox(width: 8),
          for (final u in all.take(4))
            Padding(
              padding: const EdgeInsets.only(left: 2),
              child: _PresenceAvatar(
                name: u['displayName'] as String? ?? '?',
                color: _presenceColor(u['id'] as String? ?? u['displayName'] as String? ?? 'x'),
                isSelf: u['isSelf'] == true,
              ),
            ),
          if (all.length > 4)
            Padding(
              padding: const EdgeInsets.only(left: 4),
              child: Text('+${all.length - 4}',
                  style: const TextStyle(fontSize: 10, color: Colors.grey)),
            ),
        ],
      ),
    );
  }
}

// 頂欄儲存狀態:儲存中 / 已儲存 X 秒前 / 錯誤(可點擊重試)
class _SaveStatus extends StatelessWidget {
  final bool saving;
  final bool dirty;
  final DateTime? lastSavedAt;
  final String? lastError;
  final Future<void> Function() onRetry;
  const _SaveStatus({
    required this.saving,
    required this.dirty,
    required this.lastSavedAt,
    required this.lastError,
    required this.onRetry,
  });

  @override
  Widget build(BuildContext context) {
    if (lastError != null) {
      return InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onRetry,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: const [
              Icon(Icons.error_outline, size: 14, color: Color(0xFFEF4444)),
              SizedBox(width: 4),
              Text(
                '儲存失敗 · 點擊重試',
                style: TextStyle(fontSize: 11, color: Color(0xFFEF4444), fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      );
    }
    if (saving) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: const [
          SizedBox(
            width: 10,
            height: 10,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          ),
          SizedBox(width: 4),
          Text('儲存中…', style: TextStyle(fontSize: 11, color: Colors.grey)),
        ],
      );
    }
    if (dirty) {
      return const Text('未儲存的變更', style: TextStyle(fontSize: 11, color: Colors.grey));
    }
    if (lastSavedAt == null) return const SizedBox.shrink();
    final diff = DateTime.now().difference(lastSavedAt!);
    final label = diff.inSeconds < 5
        ? '已儲存'
        : diff.inMinutes < 1
            ? '${diff.inSeconds} 秒前儲存'
            : '${diff.inMinutes} 分鐘前儲存';
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.cloud_done_outlined, size: 12, color: Color(0xFF10B981)),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
      ],
    );
  }
}

class _PresenceAvatar extends StatelessWidget {
  final String name;
  final Color color;
  final bool isSelf;
  const _PresenceAvatar({required this.name, required this.color, required this.isSelf});

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: isSelf ? '$name(你)' : name,
      child: Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(color: Colors.white, width: 1.5),
        ),
        alignment: Alignment.center,
        child: Text(
          name.isNotEmpty ? name.characters.first.toUpperCase() : '?',
          style: const TextStyle(
            color: Colors.white,
            fontSize: 10,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
    );
  }
}
