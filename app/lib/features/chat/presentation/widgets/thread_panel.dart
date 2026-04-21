import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/network/api_client.dart';
import '../../../../core/network/socket_service.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../../shared/widgets/message_body.dart';
import '../../../mentions/presentation/widgets/mention_text_field.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/message_provider.dart';

/// 討論串內容(無 Scaffold/AppBar)。可當作整頁(`ThreadPage`)渲染,
/// 或在寬版 ChannelPage 作右側固定面板使用 — 對齊 prototype 的 ThreadPanel。
class ThreadPanel extends ConsumerStatefulWidget {
  final String channelId;
  final String parentId;
  final Map<String, dynamic>? parentSummary;
  final VoidCallback? onClose;
  final bool showHeader;

  const ThreadPanel({
    super.key,
    required this.channelId,
    required this.parentId,
    this.parentSummary,
    this.onClose,
    this.showHeader = true,
  });

  @override
  ConsumerState<ThreadPanel> createState() => _ThreadPanelState();
}

class _ThreadPanelState extends ConsumerState<ThreadPanel> {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();
  late void Function(dynamic) _newMessageListener;

  @override
  void initState() {
    super.initState();
    _newMessageListener = (dynamic data) {
      if (!mounted) return;
      Map<String, dynamic>? m;
      if (data is Map<String, dynamic>) {
        m = data;
      } else if (data is Map) {
        m = Map<String, dynamic>.from(data);
      }
      if (m == null) return;
      if ((m['channelId'] as String?) != widget.channelId) return;
      if ((m['parentId'] as String?) == widget.parentId) {
        ref.invalidate(threadProvider(widget.parentId));
      }
    };
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(socketProvider).addListener('newMessage', _newMessageListener);
    });
  }

  @override
  void dispose() {
    ref.read(socketProvider).removeListener('newMessage', _newMessageListener);
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final content = _messageController.text.trim();
    if (content.isEmpty) return;
    final socket = ref.read(socketProvider);
    try {
      if (socket.isConnected) {
        socket.sendMessage(widget.channelId, content, parentId: widget.parentId);
      } else {
        await ref.read(apiClientProvider).createMessage({
          'channelId': widget.channelId,
          'content': content,
          'type': 'text',
          'parentId': widget.parentId,
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('傳送失敗：$e')));
      }
      return;
    }
    _messageController.clear();
    ref.invalidate(threadProvider(widget.parentId));
    ref.invalidate(messagesProvider(widget.channelId));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final threadAsync = ref.watch(threadProvider(widget.parentId));
    final parent = widget.parentSummary;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.showHeader)
          Container(
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: theme.dividerColor)),
            ),
            padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
            child: Row(
              children: [
                const Icon(Icons.forum_outlined, size: 16),
                const SizedBox(width: 6),
                const Text('討論串',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                const Spacer(),
                if (widget.onClose != null)
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    tooltip: '關閉',
                    onPressed: widget.onClose,
                  ),
              ],
            ),
          ),
        if (parent != null) _ParentHeader(parent: parent),
        Expanded(
          child: threadAsync.when(
            loading: () => const LoadingWidget(),
            error: (e, _) => AppErrorWidget(message: e.toString()),
            data: (replies) {
              if (replies.isEmpty) {
                return const EmptyStateWidget(
                  icon: Icons.forum_outlined,
                  title: '尚無回覆',
                  subtitle: '傳送第一則回覆',
                );
              }
              return ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                itemCount: replies.length,
                itemBuilder: (context, index) {
                  final msg = replies[index] as Map<String, dynamic>;
                  final sender = msg['sender'] as Map<String, dynamic>?;
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        UserAvatar(
                          name: sender?['displayName'] as String? ?? '?',
                          avatarUrl: sender?['avatarUrl'] as String?,
                          radius: 14,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                sender?['displayName'] as String? ?? '?',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600, fontSize: 12),
                              ),
                              MessageBody(
                                content: msg['content'] as String? ?? '',
                                baseStyle: const TextStyle(fontSize: 13),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  );
                },
              );
            },
          ),
        ),
        _buildInputBar(),
      ],
    );
  }

  Widget _buildInputBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Builder(builder: (ctx) {
              final wsId = ref.watch(currentWorkspaceIdProvider);
              const decoration = InputDecoration(
                hintText: '回覆討論串…',
                border: InputBorder.none,
                isDense: true,
              );
              if (wsId == null) {
                return TextField(
                  controller: _messageController,
                  decoration: decoration,
                  onSubmitted: (_) => _send(),
                );
              }
              return MentionTextField(
                controller: _messageController,
                workspaceId: wsId,
                decoration: decoration,
                onSubmitted: (_) => _send(),
              );
            }),
          ),
          IconButton(icon: const Icon(Icons.send, size: 20), onPressed: _send),
        ],
      ),
    );
  }
}

class _ParentHeader extends StatelessWidget {
  final Map<String, dynamic> parent;
  const _ParentHeader({required this.parent});

  @override
  Widget build(BuildContext context) {
    final sender = parent['sender'] as Map<String, dynamic>?;
    final theme = Theme.of(context);
    return Container(
      color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '根訊息',
            style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.primary),
          ),
          const SizedBox(height: 4),
          Text(
            sender?['displayName'] as String? ?? '?',
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
          ),
          const SizedBox(height: 2),
          MessageBody(
            content: parent['content'] as String? ?? '',
            baseStyle: const TextStyle(fontSize: 14),
          ),
        ],
      ),
    );
  }
}
