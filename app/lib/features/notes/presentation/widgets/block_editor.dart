import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../providers/notes_providers.dart';

/// 一個可變動的 block item（在 UI 端保留 id 以便 PUT 時標示對應關係；新增的 block id=null）。
class _BlockItem {
  String? id;
  String type;
  Map<String, dynamic> content;
  final TextEditingController controller;
  final FocusNode focusNode;
  /// 當 UI 端還沒拿到 server 的 id（新建 block）時，ReorderableListView 也要一個
  /// 穩定的 Key —— 用這個 client-only id。絕不等於 server id（開頭 `c_`）。
  final String clientId;
  /// toggle block 專用：body 內容的獨立 controller（頭摘要用 `controller`）。
  /// 非 toggle 類型保持 null。
  TextEditingController? bodyController;

  static int _nextClientId = 0;

  _BlockItem({
    required this.id,
    required this.type,
    required this.content,
    required String initialText,
  })  : controller = TextEditingController(text: initialText),
        focusNode = FocusNode(),
        clientId = 'c_${++_nextClientId}' {
    if (type == 'toggle') {
      bodyController = TextEditingController(text: (content['body'] ?? '').toString());
    }
  }

  Map<String, dynamic> toPayload(int position) => {
        if (id != null) 'id': id,
        'type': type,
        'content': _serializeContent(),
        'position': position,
      };

  Map<String, dynamic> _serializeContent() {
    final txt = controller.text;
    switch (type) {
      case 'todo':
        return {'text': txt, 'checked': content['checked'] == true};
      case 'code':
        return {'text': txt, 'language': content['language'] ?? 'text'};
      case 'image':
        return {'url': content['url'] ?? '', 'caption': txt};
      case 'divider':
        return {};
      case 'toggle':
        return {
          'text': txt,
          'collapsed': content['collapsed'] == true,
          'body': bodyController?.text ?? '',
        };
      default:
        return {'text': txt};
    }
  }

  void dispose() {
    controller.dispose();
    focusNode.dispose();
    bodyController?.dispose();
  }
}

class BlockEditor extends ConsumerStatefulWidget {
  final String pageId;
  final List<dynamic> initialBlocks;

  const BlockEditor({
    super.key,
    required this.pageId,
    required this.initialBlocks,
  });

  @override
  ConsumerState<BlockEditor> createState() => _BlockEditorState();
}

class _BlockEditorState extends ConsumerState<BlockEditor> {
  late List<_BlockItem> _blocks;
  Timer? _saveDebounce;
  bool _saving = false;

  // Slash-command menu state. When _slashIndex != null, we render an inline
  // popup under that block row filtered by _slashQuery (the text typed after
  // the `/`). Caret position of the `/` is cached so we can remove it on pick.
  int? _slashIndex;
  String _slashQuery = '';
  int _slashStart = -1; // index of the '/' in the block's text
  int _slashHighlight = 0; // which filtered item is selected by arrow keys

  static const _menuTypes = [
    ('text', '一般文字', Icons.notes),
    ('h1', '一級標題', Icons.title),
    ('h2', '二級標題', Icons.text_fields),
    ('h3', '三級標題', Icons.short_text),
    ('todo', '待辦事項', Icons.check_box_outlined),
    ('bullet', '項目符號', Icons.circle),
    ('numbered', '編號列表', Icons.format_list_numbered),
    ('quote', '引用', Icons.format_quote),
    ('toggle', '折疊區塊', Icons.keyboard_arrow_right),
    ('code', '程式碼', Icons.code),
    ('divider', '分隔線', Icons.horizontal_rule),
  ];

  @override
  void initState() {
    super.initState();
    _blocks = widget.initialBlocks.map((b) {
      final m = b as Map<String, dynamic>;
      final content = (m['content'] as Map?)?.cast<String, dynamic>() ?? {};
      final initialText = (content['text'] ?? content['caption'] ?? '').toString();
      return _BlockItem(
        id: m['id'] as String?,
        type: m['type'] as String? ?? 'text',
        content: content,
        initialText: initialText,
      );
    }).toList();
    if (_blocks.isEmpty) {
      _blocks.add(_BlockItem(id: null, type: 'text', content: {}, initialText: ''));
    }
  }

  @override
  void dispose() {
    _saveDebounce?.cancel();
    for (final b in _blocks) {
      b.dispose();
    }
    super.dispose();
  }

  void _scheduleSave() {
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(milliseconds: 800), _save);
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      final payload = <Map<String, dynamic>>[
        for (var i = 0; i < _blocks.length; i++) _blocks[i].toPayload(i),
      ];
      final saved = await ref.read(apiClientProvider).replaceBlocks(widget.pageId, payload);
      // 以回傳結果更新本地 id（新 block 會獲得 uuid）
      for (var i = 0; i < saved.length && i < _blocks.length; i++) {
        final m = saved[i] as Map<String, dynamic>;
        _blocks[i].id = m['id'] as String?;
      }
      ref.invalidate(pageDetailProvider(widget.pageId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('儲存失敗：$e')));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _insertAfter(int index, String type) {
    setState(() {
      _blocks.insert(
        index + 1,
        _BlockItem(id: null, type: type, content: {}, initialText: ''),
      );
    });
    _scheduleSave();
  }

  void _changeType(int index, String type) {
    setState(() {
      final b = _blocks[index];
      final oldType = b.type;
      b.type = type;
      // toggle 需要獨立的 body controller；切換時建立或釋放。
      if (type == 'toggle' && b.bodyController == null) {
        b.bodyController = TextEditingController(text: (b.content['body'] ?? '').toString());
      } else if (oldType == 'toggle' && type != 'toggle') {
        b.bodyController?.dispose();
        b.bodyController = null;
      }
    });
    _scheduleSave();
  }

  void _delete(int index) {
    if (_blocks.length == 1) {
      // 保留至少一個空 block
      setState(() {
        _blocks[0]
          ..type = 'text'
          ..controller.text = ''
          ..content = {};
      });
    } else {
      setState(() {
        final removed = _blocks.removeAt(index);
        removed.dispose();
      });
    }
    _scheduleSave();
  }

  void _toggleTodo(int index) {
    setState(() {
      _blocks[index].content = {
        ..._blocks[index].content,
        'checked': !(_blocks[index].content['checked'] == true),
      };
    });
    _scheduleSave();
  }

  // ─── Slash command detection ────────────────────────────────────────────

  /// 偵測 caret 前是否有一個觸發中的 slash（`/` 位於詞首且中間沒有空白／換行）。
  /// 回傳 `/` 在文字中的 index，找不到則回傳 -1。
  int _detectSlash(TextEditingController ctrl) {
    final text = ctrl.text;
    final caret = ctrl.selection.baseOffset;
    if (caret <= 0 || caret > text.length) return -1;
    for (int i = caret - 1; i >= 0; i--) {
      final ch = text[i];
      if (ch == '/') {
        if (i == 0 || text[i - 1] == ' ' || text[i - 1] == '\n') return i;
        return -1;
      }
      if (ch == ' ' || ch == '\n') return -1;
    }
    return -1;
  }

  void _onBlockTextChanged(int index) {
    final b = _blocks[index];
    final slashPos = _detectSlash(b.controller);
    if (slashPos >= 0) {
      final caret = b.controller.selection.baseOffset;
      final query = b.controller.text.substring(slashPos + 1, caret);
      setState(() {
        _slashIndex = index;
        _slashStart = slashPos;
        _slashQuery = query;
        _slashHighlight = 0;
      });
    } else if (_slashIndex != null) {
      _closeSlash();
    }
    _scheduleSave();
  }

  void _closeSlash() {
    if (_slashIndex == null) return;
    setState(() {
      _slashIndex = null;
      _slashQuery = '';
      _slashStart = -1;
      _slashHighlight = 0;
    });
  }

  List<(String, String, IconData)> _filteredSlashTypes() {
    final q = _slashQuery.toLowerCase().trim();
    if (q.isEmpty) return _menuTypes;
    return _menuTypes.where((t) {
      // 用 type id、中文名的任何子字串都算命中。
      return t.$1.toLowerCase().contains(q) || t.$2.toLowerCase().contains(q);
    }).toList();
  }

  void _applySlash(int index, String type) {
    final b = _blocks[index];
    final text = b.controller.text;
    // 把 `/query` 部分從文字裡拿掉
    final caret = b.controller.selection.baseOffset;
    final before = text.substring(0, _slashStart.clamp(0, text.length));
    final after = caret <= text.length ? text.substring(caret) : '';
    final newText = before + after;
    b.controller.text = newText;
    b.controller.selection = TextSelection.collapsed(offset: before.length);

    if (type == 'divider') {
      // divider 沒有文字 → 永遠新增一個 block
      _insertAfter(index, 'divider');
    } else if (newText.isEmpty) {
      // 空 block → 轉換類型（透過 _changeType 以正確初始化 bodyController 等）
      _changeType(index, type);
    } else {
      // 有前文 → 新 block
      _insertAfter(index, type);
    }
    _closeSlash();
    // 把焦點還給當前 / 新 block
    Future.microtask(() {
      final insertedNew = (type == 'divider') || newText.isNotEmpty;
      final target = insertedNew
          ? (index + 1 < _blocks.length ? _blocks[index + 1] : b)
          : b;
      target.focusNode.requestFocus();
    });
  }

  KeyEventResult _handleSlashKey(int index, KeyEvent event) {
    if (_slashIndex != index || event is! KeyDownEvent) return KeyEventResult.ignored;
    final filtered = _filteredSlashTypes();
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      setState(() => _slashHighlight = filtered.isEmpty ? 0 : (_slashHighlight + 1) % filtered.length);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() => _slashHighlight = filtered.isEmpty ? 0 : (_slashHighlight - 1 + filtered.length) % filtered.length);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter) {
      if (filtered.isNotEmpty) {
        _applySlash(index, filtered[_slashHighlight.clamp(0, filtered.length - 1)].$1);
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      _closeSlash();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Future<void> _openInsertMenu(int index) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: _menuTypes
              .map((t) => ListTile(
                    leading: Icon(t.$3),
                    title: Text(t.$2),
                    onTap: () => Navigator.pop(ctx, t.$1),
                  ))
              .toList(),
        ),
      ),
    );
    if (picked != null) _insertAfter(index, picked);
  }

  Widget _buildBlock(int index) {
    final b = _blocks[index];
    Widget field;
    switch (b.type) {
      case 'h1':
        field = _textField(b, const TextStyle(fontSize: 26, fontWeight: FontWeight.w700), index: index);
        break;
      case 'h2':
        field = _textField(b, const TextStyle(fontSize: 22, fontWeight: FontWeight.w700), index: index);
        break;
      case 'h3':
        field = _textField(b, const TextStyle(fontSize: 18, fontWeight: FontWeight.w600), index: index);
        break;
      case 'todo':
        field = Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Checkbox(
              value: b.content['checked'] == true,
              onChanged: (_) => _toggleTodo(index),
            ),
            Expanded(
              child: _textField(
                b,
                TextStyle(
                  decoration:
                      b.content['checked'] == true ? TextDecoration.lineThrough : null,
                  color: b.content['checked'] == true ? Colors.grey : null,
                ),
                index: index,
              ),
            ),
          ],
        );
        break;
      case 'bullet':
        field = Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(padding: EdgeInsets.fromLTRB(12, 12, 12, 0), child: Text('•')),
            Expanded(child: _textField(b, null, index: index)),
          ],
        );
        break;
      case 'numbered':
        final n = _blocks.take(index + 1).where((x) => x.type == 'numbered').length;
        field = Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(padding: const EdgeInsets.fromLTRB(12, 12, 8, 0), child: Text('$n.')),
            Expanded(child: _textField(b, null, index: index)),
          ],
        );
        break;
      case 'quote':
        field = Container(
          padding: const EdgeInsets.only(left: 12),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: Colors.grey.shade400, width: 3)),
          ),
          child: _textField(b, const TextStyle(fontStyle: FontStyle.italic), index: index),
        );
        break;
      case 'toggle':
        field = _buildToggle(index);
        break;
      case 'code':
        field = Container(
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: Colors.grey.shade100,
            borderRadius: BorderRadius.circular(6),
          ),
          child: _textField(
            b,
            const TextStyle(fontFamily: 'monospace', fontSize: 13),
            index: index,
          ),
        );
        break;
      case 'divider':
        field = const Divider(thickness: 1.4);
        break;
      case 'image':
        final url = b.content['url'] as String? ?? '';
        field = Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (url.isNotEmpty)
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: Image.network(url, errorBuilder: (_, __, ___) => const Icon(Icons.broken_image)),
              ),
            _textField(b, const TextStyle(fontSize: 12, color: Colors.grey), index: index),
          ],
        );
        break;
      default:
        field = _textField(b, const TextStyle(fontSize: 15), index: index);
    }

    return MouseRegion(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 拖移手柄 —— 拖它才開始 reorder，避免誤觸 TextField。
                // ReorderableDragStartListener 接 index，長按即開始拖。
                ReorderableDragStartListener(
                  index: index,
                  child: Tooltip(
                    message: '拖曳以排序',
                    child: MouseRegion(
                      cursor: SystemMouseCursors.grab,
                      child: Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Icon(
                          Icons.drag_indicator,
                          size: 16,
                          color: Colors.grey.shade400,
                        ),
                      ),
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.add, size: 18),
                  tooltip: '於下方插入',
                  onPressed: () => _openInsertMenu(index),
                  visualDensity: VisualDensity.compact,
                ),
                Expanded(child: field),
                PopupMenuButton<String>(
                  icon: const Icon(Icons.more_horiz, size: 18),
                  tooltip: '轉換／刪除',
                  onSelected: (v) {
                    if (v == '__delete') {
                      _delete(index);
                    } else {
                      _changeType(index, v);
                    }
                  },
                  itemBuilder: (_) => [
                    ..._menuTypes.map(
                      (t) => PopupMenuItem(
                        value: t.$1,
                        child: Row(children: [Icon(t.$3, size: 16), const SizedBox(width: 8), Text(t.$2)]),
                      ),
                    ),
                    const PopupMenuDivider(),
                    const PopupMenuItem(
                      value: '__delete',
                      child: Text('刪除', style: TextStyle(color: Colors.red)),
                    ),
                  ],
                ),
              ],
            ),
            if (_slashIndex == index) _buildSlashMenu(index),
          ],
        ),
      ),
    );
  }

  /// Toggle block —— 可折疊分組。
  /// 頭：chevron + 摘要（用既有 `controller` / `_textField`）。
  /// 身：展開時顯示多行 body（獨立 `bodyController`）。
  ///
  /// 收合時只存 summary，body 字還留著但不可見。body 是純文字；下一輪 iteration
  /// 可升級為內嵌 block list（schema 已有 parentBlockId 可利用）。
  Widget _buildToggle(int index) {
    final b = _blocks[index];
    final collapsed = b.content['collapsed'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: () {
                setState(() {
                  b.content = {...b.content, 'collapsed': !collapsed};
                });
                _scheduleSave();
              },
              borderRadius: BorderRadius.circular(4),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(0, 10, 2, 0),
                child: Icon(
                  collapsed ? Icons.keyboard_arrow_right : Icons.keyboard_arrow_down,
                  size: 18,
                  color: Colors.grey.shade700,
                ),
              ),
            ),
            Expanded(
              child: _textField(
                b,
                const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                index: index,
              ),
            ),
          ],
        ),
        if (!collapsed)
          Padding(
            padding: const EdgeInsets.only(left: 20, top: 2, bottom: 4),
            child: TextField(
              controller: b.bodyController,
              maxLines: null,
              style: const TextStyle(fontSize: 14),
              decoration: InputDecoration(
                border: InputBorder.none,
                isCollapsed: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 4),
                hintText: '空內容 —— 在此輸入',
                hintStyle: TextStyle(color: Colors.grey.shade400, fontSize: 13),
              ),
              onChanged: (_) => _scheduleSave(),
            ),
          ),
      ],
    );
  }

  Widget _buildSlashMenu(int index) {
    final filtered = _filteredSlashTypes();
    if (filtered.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(left: 44, top: 4, bottom: 4),
        child: Text(
          '沒有符合「$_slashQuery」的 block 類型',
          style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
        ),
      );
    }
    final highlight = _slashHighlight.clamp(0, filtered.length - 1);
    return Padding(
      padding: const EdgeInsets.only(left: 44, top: 2, bottom: 4),
      child: Material(
        elevation: 3,
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 260),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < filtered.length; i++)
                InkWell(
                  onTap: () => _applySlash(index, filtered[i].$1),
                  child: Container(
                    color: i == highlight ? Colors.blue.withOpacity(0.08) : null,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    child: Row(
                      children: [
                        Icon(filtered[i].$3, size: 16, color: Colors.grey.shade700),
                        const SizedBox(width: 10),
                        Expanded(child: Text(filtered[i].$2, style: const TextStyle(fontSize: 13))),
                        Text('/${filtered[i].$1}',
                            style: TextStyle(fontSize: 11, color: Colors.grey.shade500, fontFamily: 'monospace')),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _textField(_BlockItem b, TextStyle? style, {int? index}) {
    // 僅在純文字 block 且沒有內容時顯示 slash 提示，其他 block type 就保持乾淨。
    final showHint = index != null && b.type == 'text' && b.controller.text.isEmpty;
    final tf = TextField(
      controller: b.controller,
      focusNode: b.focusNode,
      style: style,
      maxLines: null,
      decoration: InputDecoration(
        border: InputBorder.none,
        isCollapsed: true,
        contentPadding: const EdgeInsets.symmetric(vertical: 8),
        hintText: showHint ? '輸入 / 叫出指令' : null,
        hintStyle: showHint ? TextStyle(color: Colors.grey.shade400, fontSize: 14) : null,
      ),
      onChanged: (_) => index != null ? _onBlockTextChanged(index) : _scheduleSave(),
    );
    if (index == null) return tf;
    // 當 slash 選單開著時，用 Focus 包裹 TextField 攔截上下／Enter／Esc，
    // 但不會影響一般輸入（非選單鍵回傳 ignored）。
    return Focus(
      onKeyEvent: (node, event) => _handleSlashKey(index, event),
      child: tf,
    );
  }

  /// 拖移排序 —— Flutter's ReorderableListView 把新 index 套到「移除後」的 list
  /// 上：往下拖要 -1 才對齊，往上拖直接就是目標位置。
  void _onReorder(int oldIndex, int newIndex) {
    if (newIndex > oldIndex) newIndex -= 1;
    if (newIndex == oldIndex) return;
    setState(() {
      final item = _blocks.removeAt(oldIndex);
      _blocks.insert(newIndex, item);
      _closeSlash(); // 拖移完就關掉 slash 選單（如果開著）
    });
    _scheduleSave();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        ReorderableListView.builder(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 80),
          // 用自製 drag handle（`=` 圖示）代替預設右側 handle，視覺上更貼近 Notion
          buildDefaultDragHandles: false,
          itemCount: _blocks.length,
          onReorder: _onReorder,
          footer: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: TextButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('新增 block'),
              onPressed: () => _openInsertMenu(_blocks.length - 1),
            ),
          ),
          itemBuilder: (ctx, i) {
            final b = _blocks[i];
            // 穩定 Key: server id 優先，否則 clientId —— 確保拖移時 Flutter 能正確追蹤。
            return KeyedSubtree(
              key: ValueKey(b.id ?? b.clientId),
              child: _buildBlock(i),
            );
          },
        ),
        if (_saving)
          const Positioned(
            right: 16,
            top: 8,
            child: Row(
              children: [
                SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 6),
                Text('儲存中…', style: TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
          ),
      ],
    );
  }
}
