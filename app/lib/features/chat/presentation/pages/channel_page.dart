import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../../../core/network/socket_service.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../../shared/widgets/message_body.dart';
import '../../../auth/providers/auth_provider.dart';
import '../../../mentions/presentation/widgets/mention_text_field.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/channel_provider.dart';
import '../../providers/message_provider.dart';
import '../widgets/channel_search_delegate.dart';

class ChannelPage extends ConsumerStatefulWidget {
  final String channelId;
  const ChannelPage({super.key, required this.channelId});

  @override
  ConsumerState<ChannelPage> createState() => _ChannelPageState();
}

class _ChannelPageState extends ConsumerState<ChannelPage> {
  final _messageController = TextEditingController();
  final _scrollController = ScrollController();

  late void Function(dynamic) _newMessageListener;
  late void Function(dynamic) _typingListener;
  late void Function(dynamic) _stopTypingListener;

  final Set<String> _typingUserIds = {};
  Timer? _emitTypingTimer;
  Timer? _stopTypingTimer;

  static const _quickEmojis = ['👍', '❤️', '😂', '😮', '🎉'];

  @override
  void initState() {
    super.initState();
    _newMessageListener = (dynamic data) {
      if (!mounted) return;
      final m = _asMessageMap(data);
      if (m == null) return;
      if ((m['channelId'] as String?) != widget.channelId) return;
      ref.invalidate(messagesProvider(widget.channelId));
    };
    _typingListener = (dynamic data) {
      if (!mounted) return;
      final m = _asMessageMap(data);
      if (m == null) return;
      if ((m['channelId'] as String?) != widget.channelId) return;
      final uid = m['userId'] as String?;
      final myId = ref.read(authStateProvider).userId;
      if (uid == null || uid == myId) return;
      setState(() => _typingUserIds.add(uid));
    };
    _stopTypingListener = (dynamic data) {
      if (!mounted) return;
      final m = _asMessageMap(data);
      if (m == null) return;
      if ((m['channelId'] as String?) != widget.channelId) return;
      final uid = m['userId'] as String?;
      if (uid == null) return;
      setState(() => _typingUserIds.remove(uid));
    };

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final socket = ref.read(socketProvider);
      socket.joinChannel(widget.channelId);
      socket.addListener('newMessage', _newMessageListener);
      socket.addListener('userTyping', _typingListener);
      socket.addListener('userStopTyping', _stopTypingListener);
    });
  }

  Map<String, dynamic>? _asMessageMap(dynamic data) {
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return Map<String, dynamic>.from(data);
    return null;
  }

  @override
  void dispose() {
    _emitTypingTimer?.cancel();
    _stopTypingTimer?.cancel();
    final socket = ref.read(socketProvider);
    socket.removeListener('newMessage', _newMessageListener);
    socket.removeListener('userTyping', _typingListener);
    socket.removeListener('userStopTyping', _stopTypingListener);
    socket.leaveChannel(widget.channelId);
    socket.stopTyping(widget.channelId);
    _messageController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onInputChanged(SocketService socket) {
    _emitTypingTimer?.cancel();
    _emitTypingTimer = Timer(const Duration(milliseconds: 350), () {
      socket.startTyping(widget.channelId);
    });
    _stopTypingTimer?.cancel();
    _stopTypingTimer = Timer(const Duration(seconds: 2), () {
      socket.stopTyping(widget.channelId);
    });
  }

  Future<void> _sendMessage({String? parentId}) async {
    final content = _messageController.text.trim();
    if (content.isEmpty) return;
    final socket = ref.read(socketProvider);
    try {
      if (socket.isConnected) {
        socket.sendMessage(widget.channelId, content, parentId: parentId);
      } else {
        await ref.read(apiClientProvider).createMessage({
          'channelId': widget.channelId,
          'content': content,
          'type': 'text',
          if (parentId != null) 'parentId': parentId,
        });
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('傳送失敗：$e')));
      }
      return;
    }
    _messageController.clear();
    socket.stopTyping(widget.channelId);
    ref.invalidate(messagesProvider(widget.channelId));
  }

  Future<void> _pickAndUploadFile() async {
    final workspaceId = ref.read(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('請先選擇工作空間')));
      }
      return;
    }

    final result = await FilePicker.platform.pickFiles(withData: true);
    if (result == null || result.files.isEmpty) return;
    final picked = result.files.first;
    final bytes = picked.bytes;
    if (bytes == null) return;

    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('上傳中…'), duration: Duration(seconds: 1)));

    try {
      final api = ref.read(apiClientProvider);
      final uploaded = await api.uploadFile(
        workspaceId: workspaceId,
        bytes: bytes,
        fileName: picked.name,
      );

      await api.createMessage({
        'channelId': widget.channelId,
        'content': picked.name,
        'type': 'file',
        'metadata': {
          'fileId': uploaded['id'],
          'url': uploaded['url'],
          'fileName': uploaded['fileName'],
          'fileType': uploaded['fileType'],
          'fileSize': uploaded['fileSize'],
        },
      });
      if (mounted) ref.invalidate(messagesProvider(widget.channelId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('上傳失敗：$e')));
      }
    }
  }

  Future<void> _toggleReaction(String messageId, String emoji, bool currentlyHas) async {
    final api = ref.read(apiClientProvider);
    try {
      if (currentlyHas) {
        await api.removeMessageReaction(messageId, emoji);
      } else {
        await api.addMessageReaction(messageId, emoji);
      }
      if (mounted) ref.invalidate(messagesProvider(widget.channelId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('反應失敗：$e')));
      }
    }
  }

  void _showEmojiPicker(String messageId, List<dynamic> reactions) {
    final myId = ref.read(authStateProvider).userId;
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Wrap(
            spacing: 12,
            runSpacing: 12,
            alignment: WrapAlignment.center,
            children: _quickEmojis.map((e) {
              return InkWell(
                onTap: () {
                  Navigator.pop(ctx);
                  final has = _userHasReaction(myId, e, reactions);
                  _toggleReaction(messageId, e, has);
                },
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Text(e, style: const TextStyle(fontSize: 32)),
                ),
              );
            }).toList(),
          ),
        ),
      ),
    );
  }

  Future<void> _editMessage(String messageId, String currentContent) async {
    final editController = TextEditingController(text: currentContent);
    final newContent = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('編輯訊息'),
        content: TextField(
          controller: editController,
          autofocus: true,
          maxLines: null,
          decoration: const InputDecoration(border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final text = editController.text.trim();
              if (text.isNotEmpty) Navigator.pop(ctx, text);
            },
            child: const Text('儲存'),
          ),
        ],
      ),
    );
    editController.dispose();
    if (newContent == null || newContent == currentContent) return;
    try {
      await ref.read(apiClientProvider).updateMessage(messageId, newContent);
      if (mounted) ref.invalidate(messagesProvider(widget.channelId));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('編輯失敗：$e')));
    }
  }

  Future<void> _deleteMessage(String messageId) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('刪除訊息'),
        content: const Text('確定要刪除這則訊息嗎？此操作無法復原。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('刪除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(apiClientProvider).deleteMessage(messageId);
      if (mounted) ref.invalidate(messagesProvider(widget.channelId));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('刪除失敗：$e')));
    }
  }

  void _showMessageOptions(String messageId, String content, bool isMine) {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.add_reaction_outlined),
              title: const Text('新增反應'),
              onTap: () {
                Navigator.pop(ctx);
                final reactions = <dynamic>[];
                _showEmojiPicker(messageId, reactions);
              },
            ),
            ListTile(
              leading: const Icon(Icons.forum_outlined),
              title: const Text('回覆討論串'),
              onTap: () {
                Navigator.pop(ctx);
                _sendMessage(parentId: messageId);
              },
            ),
            if (isMine) ...[
              ListTile(
                leading: const Icon(Icons.edit_outlined),
                title: const Text('編輯訊息'),
                onTap: () {
                  Navigator.pop(ctx);
                  _editMessage(messageId, content);
                },
              ),
              ListTile(
                leading: const Icon(Icons.delete_outline, color: Colors.red),
                title: const Text('刪除訊息', style: TextStyle(color: Colors.red)),
                onTap: () {
                  Navigator.pop(ctx);
                  _deleteMessage(messageId);
                },
              ),
            ],
          ],
        ),
      ),
    );
  }

  bool _userHasReaction(String? userId, String emoji, List<dynamic> reactions) {
    if (userId == null) return false;
    for (final r in reactions) {
      final m = r as Map<String, dynamic>;
      if (m['userId'] == userId && m['emoji'] == emoji) return true;
    }
    return false;
  }

  Map<String, List<Map<String, dynamic>>> _groupReactions(List<dynamic> reactions) {
    final out = <String, List<Map<String, dynamic>>>{};
    for (final r in reactions) {
      final m = r as Map<String, dynamic>;
      final e = m['emoji'] as String? ?? '';
      out.putIfAbsent(e, () => []).add(m);
    }
    return out;
  }

  void _openThread(Map<String, dynamic> msg) {
    final id = msg['id'] as String?;
    if (id == null) return;
    context.push('/chat/channel/${widget.channelId}/thread/$id', extra: msg);
  }

  @override
  Widget build(BuildContext context) {
    final channelAsync = ref.watch(channelProvider(widget.channelId));
    final messagesAsync = ref.watch(messagesProvider(widget.channelId));
    final socket = ref.watch(socketProvider);
    final myId = ref.watch(authStateProvider).userId;

    return Scaffold(
      appBar: AppBar(
        title: channelAsync.when(
          data: (ch) => Text(ch['name'] as String? ?? ''),
          loading: () => const Text('載入中…'),
          error: (_, __) => const Text('頻道'),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.search),
            onPressed: () {
              showSearch<void>(
                context: context,
                delegate: ChannelSearchDelegate(channelId: widget.channelId),
              );
            },
          ),
          IconButton(icon: const Icon(Icons.more_vert), onPressed: () {}),
        ],
      ),
      body: Column(
        children: [
          if (_typingUserIds.isNotEmpty)
            Material(
              color: Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.35),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                child: Row(
                  children: [
                    SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        _typingUserIds.length == 1
                            ? '有成員正在輸入…'
                            : '${_typingUserIds.length} 人正在輸入…',
                        style: TextStyle(fontSize: 13, color: Theme.of(context).colorScheme.onSurface),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          Expanded(
            child: messagesAsync.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(message: e.toString()),
              data: (messages) {
                if (messages.isEmpty) {
                  return const EmptyStateWidget(
                    icon: Icons.chat,
                    title: '尚無訊息',
                    subtitle: '傳送第一則訊息',
                  );
                }
                return ListView.builder(
                  controller: _scrollController,
                  reverse: true,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  itemCount: messages.length,
                  itemBuilder: (context, index) {
                    final msg = messages[index] as Map<String, dynamic>;
                    final sender = msg['sender'] as Map<String, dynamic>?;
                    final reactions = (msg['reactions'] as List<dynamic>?) ?? [];
                    final replyCount = msg['_count'] is Map ? (msg['_count'] as Map)['replies'] : null;
                    final nReplies = replyCount is int ? replyCount : int.tryParse('$replyCount') ?? 0;
                    final hasThread = nReplies > 0;
                    final messageId = msg['id'] as String?;
                    final grouped = _groupReactions(reactions);

                    final senderId = (msg['sender'] as Map<String, dynamic>?)?['id'] as String?;
                    final isMine = senderId != null && senderId == myId;
                    return GestureDetector(
                      onLongPress: messageId == null
                          ? null
                          : () => _showMessageOptions(
                                messageId,
                                msg['content'] as String? ?? '',
                                isMine,
                              ),
                      child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          UserAvatar(
                            name: sender?['displayName'] as String? ?? '?',
                            avatarUrl: sender?['avatarUrl'] as String?,
                            radius: 18,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Text(
                                      sender?['displayName'] as String? ?? 'Unknown',
                                      style: const TextStyle(fontWeight: FontWeight.w600),
                                    ),
                                    const SizedBox(width: 8),
                                    Text(
                                      _formatTime(msg['createdAt']),
                                      style: TextStyle(fontSize: 12, color: Colors.grey.shade500),
                                    ),
                                    if (msg['editedAt'] != null)
                                      Text(
                                        '（已編輯）',
                                        style: TextStyle(fontSize: 11, color: Colors.grey.shade400),
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 2),
                                if (msg['type'] == 'text')
                                  MessageBody(
                                    content: msg['content'] as String? ?? '',
                                    onMentionTap: (u) {
                                      ScaffoldMessenger.of(context).showSnackBar(
                                        SnackBar(content: Text('@$u')),
                                      );
                                    },
                                  ),
                                if (msg['type'] == 'file')
                                  _FileMessageTile(
                                    metadata: (msg['metadata'] as Map?)?.cast<String, dynamic>(),
                                    fallback: msg['content'] as String? ?? '',
                                  ),
                                if (msg['type'] == 'image')
                                  ClipRRect(
                                    borderRadius: BorderRadius.circular(8),
                                    child: Image.network(
                                      (msg['metadata'] as Map?)?['url'] as String? ?? '',
                                      height: 200,
                                      fit: BoxFit.cover,
                                      errorBuilder: (_, __, ___) => const Icon(Icons.broken_image),
                                    ),
                                  ),
                                const SizedBox(height: 4),
                                Wrap(
                                  spacing: 4,
                                  runSpacing: 4,
                                  crossAxisAlignment: WrapCrossAlignment.center,
                                  children: [
                                    if (messageId != null)
                                      TextButton(
                                        onPressed: () => _openThread(msg),
                                        style: TextButton.styleFrom(
                                          padding: const EdgeInsets.symmetric(horizontal: 8),
                                          minimumSize: Size.zero,
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                        ),
                                        child: const Text('回覆'),
                                      ),
                                    if (hasThread)
                                      TextButton.icon(
                                        onPressed: () => _openThread(msg),
                                        icon: const Icon(Icons.forum_outlined, size: 16),
                                        label: Text('$nReplies 則回覆'),
                                        style: TextButton.styleFrom(
                                          padding: const EdgeInsets.symmetric(horizontal: 8),
                                          minimumSize: Size.zero,
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                        ),
                                      ),
                                    if (messageId != null)
                                      IconButton(
                                        visualDensity: VisualDensity.compact,
                                        icon: const Icon(Icons.add_reaction_outlined, size: 20),
                                        onPressed: () => _showEmojiPicker(messageId, reactions),
                                      ),
                                  ],
                                ),
                                if (grouped.isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 4),
                                    child: Wrap(
                                      spacing: 4,
                                      children: grouped.entries.map((e) {
                                        final emoji = e.key;
                                        final list = e.value;
                                        final count = list.length;
                                        final hasMine = myId != null &&
                                            list.any((x) => x['userId'] == myId);
                                        return ActionChip(
                                          label: Text('$emoji $count'),
                                          onPressed: messageId == null
                                              ? null
                                              : () => _toggleReaction(messageId, emoji, hasMine),
                                        );
                                      }).toList(),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    );  // GestureDetector
                  },
                );
              },
            ),
          ),
          _buildInputBar(socket),
        ],
      ),
    );
  }

  Widget _buildInputBar(SocketService socket) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: Colors.grey.shade200)),
      ),
      child: Row(
        children: [
          IconButton(
            icon: const Icon(Icons.attach_file),
            tooltip: '附加檔案',
            onPressed: _pickAndUploadFile,
          ),
          Expanded(
            child: Builder(builder: (ctx) {
              final wsId = ref.watch(currentWorkspaceIdProvider);
              if (wsId == null) {
                return TextField(
                  controller: _messageController,
                  decoration: const InputDecoration(
                    hintText: '輸入訊息…',
                    border: InputBorder.none,
                  ),
                  onChanged: (_) => _onInputChanged(socket),
                  onSubmitted: (_) => _sendMessage(),
                );
              }
              return MentionTextField(
                controller: _messageController,
                workspaceId: wsId,
                decoration: const InputDecoration(
                  hintText: '輸入訊息… 用 @ 提及成員',
                  border: InputBorder.none,
                ),
                onChanged: (_) => _onInputChanged(socket),
                onSubmitted: (_) => _sendMessage(),
              );
            }),
          ),
          IconButton(icon: const Icon(Icons.emoji_emotions_outlined), onPressed: () {}),
          IconButton(icon: const Icon(Icons.send), onPressed: () => _sendMessage()),
        ],
      ),
    );
  }

  String _formatTime(dynamic createdAt) {
    if (createdAt == null) return '';
    final dt = DateTime.tryParse(createdAt.toString());
    if (dt == null) return '';
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }
}

class _FileMessageTile extends StatelessWidget {
  final Map<String, dynamic>? metadata;
  final String fallback;
  const _FileMessageTile({required this.metadata, required this.fallback});

  bool get _isImage {
    final ft = metadata?['fileType'] as String? ?? '';
    return ft.startsWith('image/');
  }

  @override
  Widget build(BuildContext context) {
    final url = metadata?['url'] as String? ?? '';
    final name = metadata?['fileName'] as String? ?? fallback;
    final size = metadata?['fileSize'];

    if (_isImage && url.isNotEmpty) {
      return ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Image.network(
          url,
          height: 200,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => const Icon(Icons.broken_image),
        ),
      );
    }

    return Container(
      constraints: const BoxConstraints(maxWidth: 320),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        border: Border.all(color: Colors.grey.shade300),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.insert_drive_file_outlined, size: 28),
          const SizedBox(width: 8),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(name, overflow: TextOverflow.ellipsis, maxLines: 1),
                if (size is int)
                  Text(
                    _formatBytes(size),
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }
}
