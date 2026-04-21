import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../providers/notes_providers.dart';

/// 一個可變動的 block item（在 UI 端保留 id 以便 PUT 時標示對應關係；新增的 block id=null）。
class _BlockItem {
  String? id;
  String type;
  Map<String, dynamic> content;
  final TextEditingController controller;

  _BlockItem({
    required this.id,
    required this.type,
    required this.content,
    required String initialText,
  }) : controller = TextEditingController(text: initialText);

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
      default:
        return {'text': txt};
    }
  }

  void dispose() => controller.dispose();
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

  static const _menuTypes = [
    ('text', '一般文字', Icons.notes),
    ('h1', '一級標題', Icons.title),
    ('h2', '二級標題', Icons.text_fields),
    ('h3', '三級標題', Icons.short_text),
    ('todo', '待辦事項', Icons.check_box_outlined),
    ('bullet', '項目符號', Icons.circle),
    ('numbered', '編號列表', Icons.format_list_numbered),
    ('quote', '引用', Icons.format_quote),
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
    setState(() => _blocks[index].type = type);
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
        field = _textField(b, const TextStyle(fontSize: 26, fontWeight: FontWeight.w700));
        break;
      case 'h2':
        field = _textField(b, const TextStyle(fontSize: 22, fontWeight: FontWeight.w700));
        break;
      case 'h3':
        field = _textField(b, const TextStyle(fontSize: 18, fontWeight: FontWeight.w600));
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
            Expanded(child: _textField(b, null)),
          ],
        );
        break;
      case 'numbered':
        final n = _blocks.take(index + 1).where((x) => x.type == 'numbered').length;
        field = Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(padding: const EdgeInsets.fromLTRB(12, 12, 8, 0), child: Text('$n.')),
            Expanded(child: _textField(b, null)),
          ],
        );
        break;
      case 'quote':
        field = Container(
          padding: const EdgeInsets.only(left: 12),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: Colors.grey.shade400, width: 3)),
          ),
          child: _textField(b, const TextStyle(fontStyle: FontStyle.italic)),
        );
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
            _textField(b, const TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        );
        break;
      default:
        field = _textField(b, const TextStyle(fontSize: 15));
    }

    return MouseRegion(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            IconButton(
              icon: const Icon(Icons.add, size: 18),
              tooltip: '於下方插入',
              onPressed: () => _openInsertMenu(index),
              visualDensity: VisualDensity.compact,
            ),
            Expanded(child: field),
            PopupMenuButton<String>(
              icon: const Icon(Icons.drag_indicator, size: 18),
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
      ),
    );
  }

  Widget _textField(_BlockItem b, TextStyle? style) {
    return TextField(
      controller: b.controller,
      style: style,
      maxLines: null,
      decoration: const InputDecoration(
        border: InputBorder.none,
        isCollapsed: true,
        contentPadding: EdgeInsets.symmetric(vertical: 8),
      ),
      onChanged: (_) => _scheduleSave(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        ListView.builder(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 80),
          itemCount: _blocks.length + 1,
          itemBuilder: (ctx, i) {
            if (i == _blocks.length) {
              return TextButton.icon(
                icon: const Icon(Icons.add),
                label: const Text('新增 block'),
                onPressed: () => _openInsertMenu(_blocks.length - 1),
              );
            }
            return _buildBlock(i);
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
