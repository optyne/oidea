import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

/// 訊息內容渲染：Markdown + @username 高亮/點擊。
class MessageBody extends StatelessWidget {
  final String content;
  final void Function(String username)? onMentionTap;
  final void Function(String channel)? onChannelTap;
  final TextStyle? baseStyle;

  const MessageBody({
    super.key,
    required this.content,
    this.onMentionTap,
    this.onChannelTap,
    this.baseStyle,
  });

  @override
  Widget build(BuildContext context) {
    final style = baseStyle ?? const TextStyle(fontSize: 15);
    return MarkdownBody(
      data: content,
      selectable: true,
      styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
        p: style,
        code: TextStyle(
          fontFamily: 'monospace',
          backgroundColor: Colors.grey.shade200,
          fontSize: style.fontSize,
        ),
      ),
      extensionSet: md.ExtensionSet(
        md.ExtensionSet.gitHubFlavored.blockSyntaxes,
        [
          // 結構化 mention: @[Name](userId) —— autocomplete 產生的格式
          _StructuredMentionSyntax(),
          _MentionSyntax(),
          _ChannelSyntax(),
          ...md.ExtensionSet.gitHubFlavored.inlineSyntaxes,
        ],
      ),
      builders: {
        'mention': _MentionBuilder(onMentionTap),
        'user_mention': _UserMentionBuilder(onMentionTap),
        'channel_mention': _ChannelBuilder(onChannelTap),
      },
    );
  }
}

class _StructuredMentionSyntax extends md.InlineSyntax {
  _StructuredMentionSyntax() : super(r'@\[([^\]]+)\]\(([^)]+)\)');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final el = md.Element.text('user_mention', '@${match[1]}');
    el.attributes['userId'] = match[2]!;
    el.attributes['displayName'] = match[1]!;
    parser.addNode(el);
    return true;
  }
}

class _UserMentionBuilder extends MarkdownElementBuilder {
  final void Function(String)? onTap;
  _UserMentionBuilder(this.onTap);

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final userId = element.attributes['userId'] ?? '';
    final recognizer = onTap == null
        ? null
        : (TapGestureRecognizer()..onTap = () => onTap!(userId));
    return RichText(
      text: TextSpan(
        text: element.textContent,
        style: const TextStyle(
          color: Color(0xFF1976D2),
          fontWeight: FontWeight.w600,
          backgroundColor: Color(0x201976D2),
        ),
        recognizer: recognizer,
      ),
    );
  }
}

class _MentionSyntax extends md.InlineSyntax {
  _MentionSyntax() : super(r'@([A-Za-z0-9_]{2,32})');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final el = md.Element.text('mention', '@${match[1]}');
    el.attributes['username'] = match[1]!;
    parser.addNode(el);
    return true;
  }
}

class _MentionBuilder extends MarkdownElementBuilder {
  final void Function(String)? onTap;
  _MentionBuilder(this.onTap);

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final username = element.attributes['username'] ?? '';
    final recognizer = onTap == null
        ? null
        : (TapGestureRecognizer()..onTap = () => onTap!(username));
    return RichText(
      text: TextSpan(
        text: element.textContent,
        style: const TextStyle(
          color: Color(0xFF1976D2),
          fontWeight: FontWeight.w600,
          backgroundColor: Color(0x201976D2),
        ),
        recognizer: recognizer,
      ),
    );
  }
}

/// #channel — prototype `#\S+` 的 Flutter 對應。限字母、數字、底線、連字,至少 2 字。
class _ChannelSyntax extends md.InlineSyntax {
  _ChannelSyntax() : super(r'(?<![\w/])#([A-Za-z0-9_\-]{2,64})');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final el = md.Element.text('channel_mention', '#${match[1]}');
    el.attributes['channel'] = match[1]!;
    parser.addNode(el);
    return true;
  }
}

class _ChannelBuilder extends MarkdownElementBuilder {
  final void Function(String)? onTap;
  _ChannelBuilder(this.onTap);

  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    final channel = element.attributes['channel'] ?? '';
    final recognizer = onTap == null
        ? null
        : (TapGestureRecognizer()..onTap = () => onTap!(channel));
    return RichText(
      text: TextSpan(
        text: element.textContent,
        style: const TextStyle(
          color: Color(0xFF4F46E5),
          fontWeight: FontWeight.w600,
        ),
        recognizer: recognizer,
      ),
    );
  }
}
