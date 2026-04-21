import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';

/// 可重用的 @mention 自動完成輸入框。
///
/// 當使用者在 caret 前打出 `@` + 非空白字元時，下方出現一個 popup 列出
/// workspace members；`↑↓` 選、`Enter` 套用、`Esc` 關掉。套用後把 `@query`
/// 文字段替換成 Notion-style 的 `@[displayName](userId) `。
///
/// 渲染階段用 [parseMentions] 把那個語法解析回 display name + userId，
/// 以 [MentionRichText] 高亮呈現。
class MentionTextField extends ConsumerStatefulWidget {
  final TextEditingController controller;
  final String workspaceId;
  final InputDecoration decoration;
  final TextStyle? style;
  final int? maxLines;
  final FocusNode? focusNode;
  final void Function(String)? onSubmitted;
  final void Function(String)? onChanged;

  const MentionTextField({
    super.key,
    required this.controller,
    required this.workspaceId,
    this.decoration = const InputDecoration(),
    this.style,
    this.maxLines = 1,
    this.focusNode,
    this.onSubmitted,
    this.onChanged,
  });

  @override
  ConsumerState<MentionTextField> createState() => _MentionTextFieldState();
}

class _MentionTextFieldState extends ConsumerState<MentionTextField> {
  late final FocusNode _focusNode = widget.focusNode ?? FocusNode();
  List<Map<String, dynamic>> _allMembers = [];
  List<Map<String, dynamic>> _filtered = [];
  int _atPos = -1;
  int _highlight = 0;
  bool _open = false;
  Timer? _membersFetchDebounce;

  @override
  void initState() {
    super.initState();
    // 非同步抓成員；失敗就降級成「沒有自動完成」的一般 TextField
    _fetchMembers();
  }

  @override
  void dispose() {
    _membersFetchDebounce?.cancel();
    if (widget.focusNode == null) _focusNode.dispose();
    super.dispose();
  }

  Future<void> _fetchMembers() async {
    try {
      final list = await ref.read(apiClientProvider).getWorkspaceMembers(widget.workspaceId);
      final members = list.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
      if (!mounted) return;
      setState(() => _allMembers = members);
    } catch (_) {
      // 忽略；popup 就不開
    }
  }

  /// 偵測 caret 前的 `@query` 觸發位置。回傳 `@` index；找不到回 -1。
  /// 觸發條件：`@` 位於 start-of-input、空白、或換行之後，且與 caret 之間沒有空白／換行。
  int _detectAt(TextEditingController c) {
    final text = c.text;
    final caret = c.selection.baseOffset;
    if (caret <= 0 || caret > text.length) return -1;
    for (int i = caret - 1; i >= 0; i--) {
      final ch = text[i];
      if (ch == '@') {
        if (i == 0 || text[i - 1] == ' ' || text[i - 1] == '\n') return i;
        return -1;
      }
      if (ch == ' ' || ch == '\n') return -1;
    }
    return -1;
  }

  void _onChanged(String v) {
    widget.onChanged?.call(v);
    final atPos = _detectAt(widget.controller);
    if (atPos < 0) {
      if (_open) setState(() => _open = false);
      return;
    }
    final caret = widget.controller.selection.baseOffset;
    final query = widget.controller.text.substring(atPos + 1, caret).toLowerCase();
    final filtered = _allMembers.where((m) {
      final user = m['user'] as Map? ?? m; // API 有時回 {user: {...}, role}
      final name = ((user['displayName'] as String?) ?? '').toLowerCase();
      final uname = ((user['username'] as String?) ?? '').toLowerCase();
      return name.contains(query) || uname.contains(query);
    }).take(8).toList();
    setState(() {
      _open = filtered.isNotEmpty;
      _filtered = filtered;
      _atPos = atPos;
      _highlight = 0;
    });
  }

  void _apply(Map<String, dynamic> member) {
    final user = member['user'] as Map? ?? member;
    final uid = user['id'] as String?;
    final name = (user['displayName'] as String?) ?? (user['username'] as String?) ?? 'user';
    if (uid == null) return;
    final text = widget.controller.text;
    final caret = widget.controller.selection.baseOffset.clamp(0, text.length);
    final before = text.substring(0, _atPos);
    final after = text.substring(caret);
    final replacement = '@[$name]($uid) ';
    final newText = before + replacement + after;
    widget.controller.value = TextEditingValue(
      text: newText,
      selection: TextSelection.collapsed(offset: before.length + replacement.length),
    );
    setState(() => _open = false);
    widget.onChanged?.call(newText);
  }

  KeyEventResult _handleKey(FocusNode node, KeyEvent event) {
    if (!_open || event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      setState(() => _highlight = (_highlight + 1) % _filtered.length);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() =>
          _highlight = (_highlight - 1 + _filtered.length) % _filtered.length);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter) {
      _apply(_filtered[_highlight.clamp(0, _filtered.length - 1)]);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      setState(() => _open = false);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Focus(
          onKeyEvent: _handleKey,
          child: TextField(
            controller: widget.controller,
            focusNode: _focusNode,
            decoration: widget.decoration,
            style: widget.style,
            maxLines: widget.maxLines,
            onChanged: _onChanged,
            onSubmitted: widget.onSubmitted,
          ),
        ),
        if (_open) _buildMenu(),
      ],
    );
  }

  Widget _buildMenu() {
    return Material(
      elevation: 4,
      borderRadius: BorderRadius.circular(8),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 220),
        child: ListView.builder(
          shrinkWrap: true,
          padding: EdgeInsets.zero,
          itemCount: _filtered.length,
          itemBuilder: (_, i) {
            final m = _filtered[i];
            final user = m['user'] as Map? ?? m;
            final name = (user['displayName'] as String?) ?? '';
            final uname = (user['username'] as String?) ?? '';
            return InkWell(
              onTap: () => _apply(m),
              child: Container(
                color: i == _highlight ? Colors.blue.withOpacity(0.08) : null,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 10,
                      child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?',
                          style: const TextStyle(fontSize: 10)),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                    if (uname.isNotEmpty)
                      Text('@$uname',
                          style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

// ─── Rendering helper ──────────────────────────────────────────────

/// A `@[name](userId)` token parsed out of message text.
class MentionToken {
  final String name;
  final String userId;
  final int start; // in original string
  final int end;
  const MentionToken({
    required this.name,
    required this.userId,
    required this.start,
    required this.end,
  });
}

final _mentionRe = RegExp(r'@\[([^\]]+)\]\(([^)]+)\)');

/// 從純文字裡抓出所有 mentions。
List<MentionToken> parseMentions(String text) {
  final out = <MentionToken>[];
  for (final m in _mentionRe.allMatches(text)) {
    out.add(MentionToken(
      name: m.group(1)!,
      userId: m.group(2)!,
      start: m.start,
      end: m.end,
    ));
  }
  return out;
}

/// 把 `@[name](uid)` 渲染成 **@name** chip；其它文字原樣。
class MentionRichText extends StatelessWidget {
  final String text;
  final TextStyle? baseStyle;
  final void Function(String userId)? onMentionTap;

  const MentionRichText({
    super.key,
    required this.text,
    this.baseStyle,
    this.onMentionTap,
  });

  @override
  Widget build(BuildContext context) {
    final mentions = parseMentions(text);
    if (mentions.isEmpty) {
      return Text(text, style: baseStyle);
    }
    final spans = <InlineSpan>[];
    var cursor = 0;
    for (final t in mentions) {
      if (t.start > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, t.start)));
      }
      spans.add(
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: GestureDetector(
            onTap: () => onMentionTap?.call(t.userId),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              margin: const EdgeInsets.symmetric(horizontal: 1),
              decoration: BoxDecoration(
                color: Colors.blue.withOpacity(0.12),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                '@${t.name}',
                style: TextStyle(
                  color: Colors.blue.shade800,
                  fontSize: (baseStyle?.fontSize ?? 14) - 1,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ),
        ),
      );
      cursor = t.end;
    }
    if (cursor < text.length) {
      spans.add(TextSpan(text: text.substring(cursor)));
    }
    return Text.rich(TextSpan(style: baseStyle, children: spans));
  }
}
