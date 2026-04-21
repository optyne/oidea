import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/network/api_client.dart';
import '../../../workspace/providers/workspace_provider.dart';

/// Notion / Linear 風格的命令面板：
/// - Ctrl / ⌘ + K 叫出
/// - 邊打邊搜（350ms debounce）
/// - 支援跨 messages / tasks / pages / files
/// - ↑↓ 導覽、Enter 打開、Esc 關閉
Future<void> showCommandPalette(BuildContext context) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withOpacity(0.5),
    builder: (_) => const Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: EdgeInsets.symmetric(horizontal: 24, vertical: 80),
      elevation: 0,
      child: _CommandPaletteBody(),
    ),
  );
}

class _CommandPaletteBody extends ConsumerStatefulWidget {
  const _CommandPaletteBody();

  @override
  ConsumerState<_CommandPaletteBody> createState() => _CommandPaletteBodyState();
}

class _Hit {
  final String label;
  final String? subtitle;
  final IconData icon;
  final Color iconColor;
  final VoidCallback onSelect;

  _Hit({
    required this.label,
    this.subtitle,
    required this.icon,
    required this.iconColor,
    required this.onSelect,
  });
}

class _CommandPaletteBodyState extends ConsumerState<_CommandPaletteBody> {
  final TextEditingController _ctrl = TextEditingController();
  final FocusNode _inputFocus = FocusNode();
  Timer? _debounce;
  String _query = '';
  bool _loading = false;
  String? _error;
  List<_Hit> _hits = [];
  int _highlight = 0;

  @override
  void initState() {
    super.initState();
    _inputFocus.requestFocus();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _ctrl.dispose();
    _inputFocus.dispose();
    super.dispose();
  }

  void _onChanged(String v) {
    setState(() => _query = v);
    _debounce?.cancel();
    if (v.trim().isEmpty) {
      setState(() {
        _hits = [];
        _loading = false;
        _error = null;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 350), _search);
  }

  Future<void> _search() async {
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) {
      setState(() => _error = '請先選擇工作空間');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref
          .read(apiClientProvider)
          .search(workspaceId: wsId, query: _query, limit: 5);
      final hits = <_Hit>[];

      final messages = (res['messages'] as List? ?? []).whereType<Map>();
      for (final m in messages) {
        hits.add(_Hit(
          label: '#${m['channelName'] ?? ''}',
          subtitle: m['snippet'] as String?,
          icon: Icons.chat_bubble_outline,
          iconColor: const Color(0xFF2563EB),
          onSelect: () {
            Navigator.of(context).pop();
            context.push('/chat/channel/${m['channelId']}');
          },
        ));
      }

      final tasks = (res['tasks'] as List? ?? []).whereType<Map>();
      for (final t in tasks) {
        hits.add(_Hit(
          label: (t['title'] as String?) ?? '(無標題任務)',
          subtitle: '專案：${t['projectName'] ?? ''}'
              '${t['snippet'] != null ? ' · ${t['snippet']}' : ''}',
          icon: Icons.check_circle_outline,
          iconColor: const Color(0xFF059669),
          onSelect: () {
            Navigator.of(context).pop();
            context.push('/projects/board/${t['projectId']}/task/${t['id']}');
          },
        ));
      }

      final pages = (res['pages'] as List? ?? []).whereType<Map>();
      for (final p in pages) {
        final icon = p['icon'] as String? ?? '';
        final kind = p['kind'] as String? ?? 'page';
        hits.add(_Hit(
          label: '${icon.isNotEmpty ? '$icon ' : ''}${p['title'] ?? 'Untitled'}',
          subtitle: kind == 'database' ? '資料庫頁' : '筆記頁',
          icon: kind == 'database' ? Icons.table_chart_outlined : Icons.article_outlined,
          iconColor: const Color(0xFF7C3AED),
          onSelect: () {
            Navigator.of(context).pop();
            // NotesHomePage 會接 pageId query param；沒接就導去 /notes
            context.push('/notes?pageId=${p['id']}');
          },
        ));
      }

      final files = (res['files'] as List? ?? []).whereType<Map>();
      for (final f in files) {
        hits.add(_Hit(
          label: (f['fileName'] as String?) ?? '',
          subtitle: '${f['fileType'] ?? 'file'} · ${_formatSize((f['fileSize'] as int?) ?? 0)}',
          icon: Icons.insert_drive_file_outlined,
          iconColor: const Color(0xFF6B7280),
          onSelect: () {
            Navigator.of(context).pop();
            // 簡易處理：目前沒有 /files/:id 頁；開啟 URL
            // 這一代先回報 SnackBar 讓使用者知道
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('檔案：${f['fileName']}')),
            );
          },
        ));
      }

      setState(() {
        _hits = hits;
        _loading = false;
        _highlight = 0;
      });
    } catch (e) {
      setState(() {
        _error = '搜尋失敗：$e';
        _loading = false;
      });
    }
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  KeyEventResult _handleKey(FocusNode _, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      setState(() {
        _highlight = _hits.isEmpty ? 0 : (_highlight + 1) % _hits.length;
      });
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() {
        _highlight = _hits.isEmpty ? 0 : (_highlight - 1 + _hits.length) % _hits.length;
      });
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter) {
      if (_hits.isNotEmpty) {
        _hits[_highlight.clamp(0, _hits.length - 1)].onSelect();
      }
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Focus(
      onKeyEvent: _handleKey,
      child: Material(
        borderRadius: BorderRadius.circular(12),
        elevation: 8,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640, maxHeight: 500),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Row(
                  children: [
                    const Icon(Icons.search, size: 20, color: Colors.grey),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: _ctrl,
                        focusNode: _inputFocus,
                        decoration: const InputDecoration(
                          border: InputBorder.none,
                          hintText: '搜尋訊息、任務、筆記、檔案…',
                          isDense: true,
                        ),
                        onChanged: _onChanged,
                      ),
                    ),
                    if (_loading)
                      const SizedBox(
                        width: 14, height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    const SizedBox(width: 4),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: Colors.grey.shade200,
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text('Esc', style: TextStyle(fontSize: 10, color: Colors.grey)),
                    ),
                  ],
                ),
              ),
              const Divider(height: 16),
              Flexible(child: _results()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _results() {
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Text(_error!, style: const TextStyle(color: Colors.red)),
      );
    }
    if (_query.trim().isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('開始打字以跨類別搜尋', style: TextStyle(color: Colors.grey.shade600)),
            const SizedBox(height: 8),
            Text('提示：Ctrl/⌘ + K 隨處叫出本面板',
                style: TextStyle(color: Colors.grey.shade500, fontSize: 12)),
          ],
        ),
      );
    }
    if (_hits.isEmpty && !_loading) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Text('沒有符合「$_query」的結果', style: TextStyle(color: Colors.grey.shade600)),
      );
    }
    final hl = _highlight.clamp(0, _hits.isEmpty ? 0 : _hits.length - 1);
    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 8),
      shrinkWrap: true,
      itemCount: _hits.length,
      itemBuilder: (_, i) {
        final h = _hits[i];
        final selected = i == hl;
        return InkWell(
          onTap: h.onSelect,
          onHover: (v) {
            if (v) setState(() => _highlight = i);
          },
          child: Container(
            color: selected ? Colors.blue.withOpacity(0.08) : null,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              children: [
                Icon(h.icon, size: 18, color: h.iconColor),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(h.label,
                          style: const TextStyle(fontWeight: FontWeight.w500),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                      if (h.subtitle != null && h.subtitle!.isNotEmpty)
                        Text(h.subtitle!,
                            style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis),
                    ],
                  ),
                ),
                if (selected)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: Colors.grey.shade200,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: const Text('↵', style: TextStyle(fontSize: 11)),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
