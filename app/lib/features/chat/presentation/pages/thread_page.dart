import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../../../core/network/socket_service.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../../shared/widgets/message_body.dart';
import '../../../mentions/presentation/widgets/mention_text_field.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/message_provider.dart';

/// 討論串：根訊息 [parentSummary] 可由上一頁 [extra] 傳入以便顯示頂部摘要。
class ThreadPage extends ConsumerStatefulWidget {
  final String channelId;
  final String parentId;
  final Map<String, dynamic>? parentSummary;

  const ThreadPage({
    super.key,
    required this.channelId,
    required this.parentId,
    this.parentSummary,
  });

  @override
  ConsumerState<ThreadPage> createState() => _ThreadPageState();
}

class _ThreadPageState extends ConsumerState<ThreadPage> {
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
      } else {
        m = null;
      }
      if (m == null) return;
      final cid = m['channelId'] as String?;
      if (cid != widget.channelId) return;
      final pid = m['parentId'] as String?;
      if (pid == widget.parentId) {
        ref.invalidate(threadProvider(widget.parentId));
      }
      ref.invalidate(messagesProvider(widget.channelId));
    };
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final socket = ref.read(socketProvider);
      socket.joinChannel(widget.channelId);
      socket.addListener('newMessage', _newMessageListener);
    });
  }

  @override
  void dispose() {
    ref.read(socketProvider).removeListener('newMessage', _newMessageListener);
    ref.read(socketProvider).leaveChannel(widget.channelId);
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
    final threadAsync = ref.watch(threadProvider(widget.parentId));
    final parent = widget.parentSummary;

    return Scaffold(
      appBar: AppBar(
        title: const Text('討論串'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
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
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
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
                            radius: 16,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  sender?['displayName'] as String? ?? '?',
                                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                                ),
                                MessageBody(
                                  content: msg['content'] as String? ?? '',
                                  baseStyle: const TextStyle(fontSize: 14),
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
      ),
    );
  }

  Widget _buildInputBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: Colors.grey.shade200)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Builder(builder: (ctx) {
              final wsId = ref.watch(currentWorkspaceIdProvider);
              const decoration = InputDecoration(
                hintText: '回覆討論串… 用 @ 提及成員',
                border: InputBorder.none,
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
          IconButton(icon: const Icon(Icons.send), onPressed: _send),
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
    return Material(
      color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
      child: Padding(
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
      ),
    );
  }
}
