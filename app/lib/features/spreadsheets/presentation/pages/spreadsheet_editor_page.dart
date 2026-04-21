import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';

/// 試算表編輯頁 —— Excel-like 可捲動格線。
///
/// 純前端純值編輯（formula / 樣式留給未來）。
///
/// - 兩個 sync'd ScrollController 讓 header row、header column 跟著內容捲動。
/// - 選到的 cell 可直接打字；底部 formula bar 是 canonical input source。
/// - 按 Enter / Tab 移動 active cell，Esc 還原。
/// - Debounce 1.2 秒把 `{cells, rows, cols}` 整份 PUT 回 server。
class SpreadsheetEditorPage extends ConsumerStatefulWidget {
  final String sheetId;
  const SpreadsheetEditorPage({super.key, required this.sheetId});

  @override
  ConsumerState<SpreadsheetEditorPage> createState() => _SpreadsheetEditorPageState();
}

class _SpreadsheetEditorPageState extends ConsumerState<SpreadsheetEditorPage> {
  static const double _rowH = 28;
  static const double _colW = 96;
  static const double _headerW = 44; // 左側列號欄寬
  static const double _headerH = 26; // 上方欄頭高

  bool _loading = true;
  String? _error;
  String _title = '';
  int _rows = 50;
  int _cols = 26;
  // key: "A1" → {"v": value}
  final Map<String, Map<String, dynamic>> _cells = {};

  int _activeRow = 0;
  int _activeCol = 0;
  final TextEditingController _formulaCtrl = TextEditingController();
  final FocusNode _formulaFocus = FocusNode();

  Timer? _saveDebounce;
  bool _dirty = false;
  bool _saving = false;

  final ScrollController _bodyVertical = ScrollController();
  final ScrollController _bodyHorizontal = ScrollController();
  final ScrollController _rowHeaderVertical = ScrollController();
  final ScrollController _colHeaderHorizontal = ScrollController();

  @override
  void initState() {
    super.initState();
    // 兩組 scroll controller 鏡射：任一滾動都同步對側 header
    _bodyVertical.addListener(() {
      if (_rowHeaderVertical.hasClients &&
          _rowHeaderVertical.offset != _bodyVertical.offset) {
        _rowHeaderVertical.jumpTo(_bodyVertical.offset);
      }
    });
    _bodyHorizontal.addListener(() {
      if (_colHeaderHorizontal.hasClients &&
          _colHeaderHorizontal.offset != _bodyHorizontal.offset) {
        _colHeaderHorizontal.jumpTo(_bodyHorizontal.offset);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _saveDebounce?.cancel();
    if (_dirty) {
      _flushSave(); // fire-and-forget
    }
    _formulaCtrl.dispose();
    _formulaFocus.dispose();
    _bodyVertical.dispose();
    _bodyHorizontal.dispose();
    _rowHeaderVertical.dispose();
    _colHeaderHorizontal.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final data = await ref.read(apiClientProvider).getSpreadsheet(widget.sheetId);
      final d = data['data'];
      int rows = 50, cols = 26;
      Map<String, Map<String, dynamic>> cells = {};
      if (d is Map<String, dynamic>) {
        rows = (d['rows'] as int?) ?? 50;
        cols = (d['cols'] as int?) ?? 26;
        final c = d['cells'];
        if (c is Map<String, dynamic>) {
          for (final e in c.entries) {
            if (e.value is Map) {
              cells[e.key] = Map<String, dynamic>.from(e.value as Map);
            }
          }
        }
      }
      setState(() {
        _title = (data['title'] as String?) ?? '試算表';
        _rows = rows;
        _cols = cols;
        _cells
          ..clear()
          ..addAll(cells);
        _loading = false;
      });
      _syncFormulaFromActive();
    } catch (e) {
      setState(() {
        _error = '載入失敗：$e';
        _loading = false;
      });
    }
  }

  void _scheduleSave() {
    _dirty = true;
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(milliseconds: 1200), _flushSave);
  }

  Future<void> _flushSave() async {
    if (_saving || !_dirty) return;
    _saving = true;
    _dirty = false;
    try {
      final cells = <String, dynamic>{};
      _cells.forEach((k, v) {
        cells[k] = v;
      });
      await ref.read(apiClientProvider).saveSpreadsheetData(widget.sheetId, {
        'rows': _rows,
        'cols': _cols,
        'cells': cells,
      });
    } catch (_) {
      _dirty = true; // 下次再試
    } finally {
      _saving = false;
    }
  }

  // ─── Cell helpers ──────────────────────────────────────────────────

  String _colLabel(int c) {
    // 0→A, 25→Z, 26→AA…（支援到 ZZ）
    if (c < 26) return String.fromCharCode(65 + c);
    final hi = (c ~/ 26) - 1;
    final lo = c % 26;
    return String.fromCharCode(65 + hi) + String.fromCharCode(65 + lo);
  }

  String _addr(int row, int col) => '${_colLabel(col)}${row + 1}';

  String _cellDisplay(int row, int col) {
    final a = _addr(row, col);
    final c = _cells[a];
    if (c == null) return '';
    final v = c['v'];
    if (v == null) return '';
    return v.toString();
  }

  void _setCell(int row, int col, String raw) {
    final a = _addr(row, col);
    if (raw.isEmpty) {
      _cells.remove(a);
    } else {
      // 嘗試 int / double，失敗保留 string
      final asInt = int.tryParse(raw);
      final asNum = asInt ?? double.tryParse(raw);
      _cells[a] = {'v': asNum ?? raw};
    }
    _scheduleSave();
  }

  void _syncFormulaFromActive() {
    _formulaCtrl.text = _cellDisplay(_activeRow, _activeCol);
    _formulaCtrl.selection = TextSelection.collapsed(offset: _formulaCtrl.text.length);
  }

  void _selectCell(int row, int col) {
    row = row.clamp(0, _rows - 1);
    col = col.clamp(0, _cols - 1);
    setState(() {
      _activeRow = row;
      _activeCol = col;
    });
    _syncFormulaFromActive();
    _formulaFocus.requestFocus();
  }

  void _commitFormula({bool moveDown = true, bool moveRight = false}) {
    setState(() => _setCell(_activeRow, _activeCol, _formulaCtrl.text));
    if (moveDown) {
      _selectCell(_activeRow + 1, _activeCol);
    } else if (moveRight) {
      _selectCell(_activeRow, _activeCol + 1);
    }
  }

  KeyEventResult _handleFormulaKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.enter) {
      _commitFormula(moveDown: true);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.tab) {
      _commitFormula(moveRight: true);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      _syncFormulaFromActive();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Future<void> _renameSheet() async {
    final ctrl = TextEditingController(text: _title);
    final newTitle = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重新命名'),
        content: TextField(controller: ctrl, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('確定'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (newTitle == null || newTitle.isEmpty || newTitle == _title) return;
    try {
      await ref.read(apiClientProvider).updateSpreadsheetMeta(widget.sheetId, title: newTitle);
      setState(() => _title = newTitle);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('更新失敗：$e')));
      }
    }
  }

  void _addRows(int n) {
    setState(() => _rows = (_rows + n).clamp(1, 1000));
    _scheduleSave();
  }

  void _addCols(int n) {
    setState(() => _cols = (_cols + n).clamp(1, 200));
    _scheduleSave();
  }

  // ─── Build ─────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: InkWell(
          onTap: _renameSheet,
          child: Padding(
            padding: const EdgeInsets.all(4),
            child: Text(_title.isEmpty ? '試算表' : _title),
          ),
        ),
        actions: [
          if (_saving)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12),
              child: Center(
                child: SizedBox(
                  width: 14, height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ),
          IconButton(
            tooltip: '加 10 列',
            icon: const Icon(Icons.keyboard_double_arrow_down),
            onPressed: () => _addRows(10),
          ),
          IconButton(
            tooltip: '加 5 欄',
            icon: const Icon(Icons.keyboard_double_arrow_right),
            onPressed: () => _addCols(5),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: Colors.red)))
              : Column(
                  children: [
                    _formulaBar(),
                    const Divider(height: 1),
                    Expanded(child: _grid()),
                  ],
                ),
    );
  }

  Widget _formulaBar() {
    final addr = _addr(_activeRow, _activeCol);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      color: Colors.grey.shade50,
      child: Row(
        children: [
          SizedBox(
            width: 64,
            child: Text(addr, style: const TextStyle(fontWeight: FontWeight.w600, fontFamily: 'monospace')),
          ),
          const Icon(Icons.functions, size: 16, color: Colors.grey),
          const SizedBox(width: 8),
          Expanded(
            child: Focus(
              onKeyEvent: _handleFormulaKey,
              child: TextField(
                controller: _formulaCtrl,
                focusNode: _formulaFocus,
                decoration: const InputDecoration(
                  border: InputBorder.none,
                  isDense: true,
                  hintText: '輸入內容，Enter 下移 / Tab 右移',
                ),
                onSubmitted: (_) => _commitFormula(moveDown: true),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _grid() {
    final totalWidth = _cols * _colW;
    final totalHeight = _rows * _rowH;
    return Column(
      children: [
        // 上方欄頭（橫向捲軸跟著 body 同步）
        Row(
          children: [
            Container(
              width: _headerW,
              height: _headerH,
              color: Colors.grey.shade100,
              alignment: Alignment.center,
              child: const Text('', style: TextStyle(fontSize: 11)),
            ),
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                controller: _colHeaderHorizontal,
                physics: const NeverScrollableScrollPhysics(),
                child: SizedBox(
                  width: totalWidth,
                  height: _headerH,
                  child: Row(
                    children: [
                      for (var c = 0; c < _cols; c++) _colHeader(c),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
        Expanded(
          child: Row(
            children: [
              // 左側列號
              SizedBox(
                width: _headerW,
                child: SingleChildScrollView(
                  controller: _rowHeaderVertical,
                  physics: const NeverScrollableScrollPhysics(),
                  child: SizedBox(
                    height: totalHeight,
                    child: Column(
                      children: [
                        for (var r = 0; r < _rows; r++) _rowHeader(r),
                      ],
                    ),
                  ),
                ),
              ),
              // Body：雙向捲動
              Expanded(
                child: Scrollbar(
                  controller: _bodyVertical,
                  child: SingleChildScrollView(
                    controller: _bodyVertical,
                    child: Scrollbar(
                      controller: _bodyHorizontal,
                      notificationPredicate: (n) => n.depth == 1,
                      child: SingleChildScrollView(
                        controller: _bodyHorizontal,
                        scrollDirection: Axis.horizontal,
                        child: SizedBox(
                          width: totalWidth,
                          height: totalHeight,
                          child: Column(
                            children: [
                              for (var r = 0; r < _rows; r++)
                                Row(
                                  children: [
                                    for (var c = 0; c < _cols; c++) _cell(r, c),
                                  ],
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _colHeader(int c) {
    final selected = c == _activeCol;
    return Container(
      width: _colW,
      height: _headerH,
      decoration: BoxDecoration(
        color: selected ? Colors.blue.shade100 : Colors.grey.shade100,
        border: Border(
          right: BorderSide(color: Colors.grey.shade300),
          bottom: BorderSide(color: Colors.grey.shade300),
        ),
      ),
      alignment: Alignment.center,
      child: Text(
        _colLabel(c),
        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, fontFamily: 'monospace'),
      ),
    );
  }

  Widget _rowHeader(int r) {
    final selected = r == _activeRow;
    return Container(
      width: _headerW,
      height: _rowH,
      decoration: BoxDecoration(
        color: selected ? Colors.blue.shade100 : Colors.grey.shade100,
        border: Border(
          right: BorderSide(color: Colors.grey.shade300),
          bottom: BorderSide(color: Colors.grey.shade200),
        ),
      ),
      alignment: Alignment.center,
      child: Text(
        '${r + 1}',
        style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w500, fontFamily: 'monospace'),
      ),
    );
  }

  Widget _cell(int r, int c) {
    final selected = r == _activeRow && c == _activeCol;
    final display = _cellDisplay(r, c);
    return GestureDetector(
      onTap: () => _selectCell(r, c),
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: _colW,
        height: _rowH,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        alignment: Alignment.centerLeft,
        decoration: BoxDecoration(
          color: selected ? Colors.blue.shade50 : Colors.white,
          border: Border(
            right: BorderSide(color: Colors.grey.shade200),
            bottom: BorderSide(color: Colors.grey.shade200),
            top: selected ? BorderSide(color: Colors.blue.shade600, width: 2) : BorderSide.none,
            left: selected ? BorderSide(color: Colors.blue.shade600, width: 2) : BorderSide.none,
          ),
        ),
        child: Text(
          display,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 13),
        ),
      ),
    );
  }
}
