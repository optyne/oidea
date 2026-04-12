import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/network/socket_service.dart';
import '../../providers/whiteboard_provider.dart';

enum DrawingTool { select, pen, line, rect, circle, text, sticky, eraser }

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

  _CanvasPainter({required this.items, this.currentItem});

  @override
  void paint(Canvas canvas, Size size) {
    // Subtle grid
    final gp = Paint()..color = const Color(0xFFE5E7EB)..strokeWidth = 0.5;
    for (double x = 0; x < size.width; x += 40) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), gp);
    }
    for (double y = 0; y < size.height; y += 40) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), gp);
    }

    for (final item in [...items, if (currentItem != null) currentItem!]) {
      _draw(canvas, item);
    }
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
  }

  void _redo() {
    if (_redoStack.isEmpty) return;
    _undoStack.add(List.from(_items));
    final next = _redoStack.removeLast();
    setState(() { _items..clear()..addAll(next); _selectedId = null; });
  }

  @override
  void initState() {
    super.initState();
    ref.read(socketProvider).joinBoard(widget.boardId);
  }

  @override
  void dispose() {
    ref.read(socketProvider).leaveBoard(widget.boardId);
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
      }
      return;
    }

    if (_currentTool == DrawingTool.eraser) {
      final toRemove = _items.where((it) => it.bounds.inflate(12).contains(pos)).map((it) => it.id).toSet();
      if (toRemove.isNotEmpty) {
        _saveUndo();
        setState(() => _items.removeWhere((it) => toRemove.contains(it.id)));
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
  }

  void _deleteSelected() {
    if (_selectedId == null) return;
    _saveUndo();
    setState(() { _items.removeWhere((it) => it.id == _selectedId); _selectedId = null; });
  }

  @override
  Widget build(BuildContext context) {
    final boardAsync = ref.watch(whiteboardProvider(widget.boardId));

    return Scaffold(
      backgroundColor: Colors.white,
      body: Column(
        children: [
          // App bar
          Container(
            height: 50,
            color: Colors.grey.shade100,
            child: Row(
              children: [
                IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.pop(context)),
                boardAsync.when(
                  data: (b) => Text(b['title'] ?? '白板', style: const TextStyle(fontWeight: FontWeight.w600)),
                  loading: () => const Text('載入中...'),
                  error: (_, __) => const Text('白板'),
                ),
                const Spacer(),
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
                            onPressed: () { Navigator.pop(ctx); _saveUndo(); setState(() { _items.clear(); _selectedId = null; }); },
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
                InteractiveViewer(
                  transformationController: _tc,
                  minScale: 0.1,
                  maxScale: 5.0,
                  panEnabled: _currentTool == DrawingTool.select,
                  child: GestureDetector(
                    onPanStart: _onPanStart,
                    onPanUpdate: _onPanUpdate,
                    onPanEnd: _onPanEnd,
                    onTapUp: _onTapUp,
                    child: SizedBox(
                      width: 4000,
                      height: 3000,
                      child: CustomPaint(painter: _CanvasPainter(items: _items, currentItem: _currentItem)),
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

                // Color panel (right)
                Positioned(
                  right: 12,
                  top: 12,
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
    );
  }

  IconData _toolIcon(DrawingTool t) => const {
    DrawingTool.select: Icons.near_me,
    DrawingTool.pen: Icons.edit,
    DrawingTool.line: Icons.horizontal_rule,
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
    return '拖曳繪製';
  }
}
