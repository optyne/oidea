import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../../../core/network/socket_service.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../../shared/widgets/message_body.dart';
import '../../../auth/providers/auth_provider.dart';
import '../../../mentions/presentation/widgets/mention_text_field.dart';
import '../../../project/providers/project_provider.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/channel_provider.dart';
import '../../providers/message_provider.dart';
import '../widgets/channel_search_delegate.dart';
import '../widgets/thread_panel.dart';

/// 寬螢幕以上直接在右側嵌入 ThreadPanel;低於此寬度則推路由。
const double _kThreadInlineBreakpoint = 900;

const List<String> _kQuickEmojis = ['👍', '❤️', '😂', '😮', '🎉'];
const List<String> _kHoverEmojis = ['👍', '❤️', '🎉'];

/// C-15 內建訊息範本(客戶端)。真正的 workspace/個人 snippet 需後端支援;
/// 先以 prototype 同樣的 4 筆作為 starter。
const List<_Snippet> _kSnippets = [
  _Snippet(
    name: '週會開場',
    content: '📅 本週進度同步：\n1. 上週完成項目\n2. 本週計劃\n3. 阻塞/風險',
    scope: 'workspace',
  ),
  _Snippet(
    name: '請假公告',
    content: '我今天因個人事務請假,如有急事請透過 Email 聯繫。',
    scope: 'personal',
  ),
  _Snippet(
    name: '部署通知',
    content: '🚀 即將部署 v{version} 到 production,預計影響時間 5 分鐘。',
    scope: 'workspace',
  ),
  _Snippet(
    name: 'Bug 回報',
    content: '**Bug:** \n**步驟:** \n**預期:** \n**實際:** \n**環境:** ',
    scope: 'personal',
  ),
];

class _Snippet {
  final String name;
  final String content;
  final String scope;
  const _Snippet({required this.name, required this.content, required this.scope});
}

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

  bool _showPinnedDrawer = false;
  Map<String, dynamic>? _inlineThread; // 寬螢幕開啟時保存 parent summary

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
            children: _kQuickEmojis.map((e) {
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

  Future<void> _togglePin(String messageId, bool currentlyPinned) async {
    final api = ref.read(apiClientProvider);
    try {
      if (currentlyPinned) {
        await api.unpinMessage(messageId);
      } else {
        await api.pinMessage(messageId);
      }
      if (!mounted) return;
      ref.invalidate(pinnedMessagesProvider(widget.channelId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失敗：$e')));
      }
    }
  }

  Future<void> _openConvertToTask(Map<String, dynamic> msg) async {
    final workspaceId = ref.read(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('請先選擇工作空間')));
      }
      return;
    }
    final messageId = msg['id'] as String?;
    if (messageId == null) return;

    final result = await showDialog<_ConvertToTaskResult>(
      context: context,
      builder: (ctx) => _ConvertToTaskDialog(
        workspaceId: workspaceId,
        initialTitle: (msg['content'] as String? ?? '').trim(),
      ),
    );
    if (result == null) return;

    try {
      final task = await ref.read(apiClientProvider).convertMessageToTask(
            messageId,
            projectId: result.projectId,
            columnId: result.columnId,
            title: result.title,
          );
      if (!mounted) return;
      final taskId = task['id'] as String?;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('已轉為任務「${result.title}」'),
          action: taskId == null
              ? null
              : SnackBarAction(
                  label: '前往',
                  onPressed: () => context.push('/task/$taskId'),
                ),
        ),
      );
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('轉任務失敗：$e')));
      }
    }
  }

  void _showMessageOptions(Map<String, dynamic> msg, bool isMine, bool isPinned) {
    final messageId = msg['id'] as String?;
    if (messageId == null) return;
    final content = msg['content'] as String? ?? '';
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
                _showEmojiPicker(messageId, (msg['reactions'] as List<dynamic>?) ?? const []);
              },
            ),
            ListTile(
              leading: const Icon(Icons.forum_outlined),
              title: const Text('回覆討論串'),
              onTap: () {
                Navigator.pop(ctx);
                _openThread(msg);
              },
            ),
            ListTile(
              leading: Icon(isPinned ? Icons.push_pin : Icons.push_pin_outlined,
                  color: isPinned ? const Color(0xFFF59E0B) : null),
              title: Text(isPinned ? '取消置頂' : '置頂訊息'),
              onTap: () {
                Navigator.pop(ctx);
                _togglePin(messageId, isPinned);
              },
            ),
            ListTile(
              leading: const Icon(Icons.task_alt_outlined),
              title: const Text('轉為任務 (C-18)'),
              onTap: () {
                Navigator.pop(ctx);
                _openConvertToTask(msg);
              },
            ),
            if (isMine) ...[
              const Divider(height: 1),
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
    // 寬螢幕:改在右側嵌入 ThreadPanel,不離開頻道。
    final width = MediaQuery.sizeOf(context).width;
    if (width >= _kThreadInlineBreakpoint) {
      setState(() => _inlineThread = msg);
      return;
    }
    context.push('/chat/channel/${widget.channelId}/thread/$id', extra: msg);
  }

  @override
  Widget build(BuildContext context) {
    final channelAsync = ref.watch(channelProvider(widget.channelId));
    final messagesAsync = ref.watch(messagesProvider(widget.channelId));
    final pinnedAsync = ref.watch(pinnedMessagesProvider(widget.channelId));
    final pinnedIds = ref.watch(pinnedIdsProvider(widget.channelId));
    final socket = ref.watch(socketProvider);
    final myId = ref.watch(authStateProvider).userId;

    final pinnedCount = pinnedAsync.value?.length ?? 0;

    return Scaffold(
      appBar: AppBar(
        title: channelAsync.when(
          data: (ch) => Text(ch['name'] as String? ?? ''),
          loading: () => const Text('載入中…'),
          error: (_, __) => const Text('頻道'),
        ),
        actions: [
          if (pinnedCount > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: () => setState(() => _showPinnedDrawer = !_showPinnedDrawer),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: _showPinnedDrawer
                        ? const Color(0x26F59E0B)
                        : const Color(0x14F59E0B),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.push_pin, size: 14, color: Color(0xFFF59E0B)),
                      const SizedBox(width: 4),
                      Text(
                        '$pinnedCount',
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFFF59E0B),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
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
      body: LayoutBuilder(
        builder: (context, constraints) {
          final wideEnough = constraints.maxWidth >= _kThreadInlineBreakpoint;
          final showInline = wideEnough && _inlineThread != null;
          final channelColumn = _buildChannelColumn(
            pinnedCount: pinnedCount,
            pinnedAsync: pinnedAsync,
            messagesAsync: messagesAsync,
            pinnedIds: pinnedIds,
            myId: myId,
            socket: socket,
          );
          if (!showInline) return channelColumn;
          final parentId = _inlineThread!['id'] as String?;
          if (parentId == null) return channelColumn;
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: channelColumn),
              Container(
                width: 340,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface,
                  border: Border(left: BorderSide(color: Theme.of(context).dividerColor)),
                ),
                child: ThreadPanel(
                  channelId: widget.channelId,
                  parentId: parentId,
                  parentSummary: _inlineThread,
                  onClose: () => setState(() => _inlineThread = null),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildChannelColumn({
    required int pinnedCount,
    required AsyncValue<List<dynamic>> pinnedAsync,
    required AsyncValue<List<dynamic>> messagesAsync,
    required Set<String> pinnedIds,
    required String? myId,
    required SocketService socket,
  }) {
    return Column(
        children: [
          if (_showPinnedDrawer && pinnedCount > 0)
            _PinnedDrawer(
              pinned: pinnedAsync.value ?? const [],
              onTap: (messageId) {
                // 先關閉抽屜，再捲到訊息(目前 ListView reverse:true,暫不支援 scroll-to-index,維持關閉)
                setState(() => _showPinnedDrawer = false);
              },
              onUnpin: (messageId) => _togglePin(messageId, true),
            ),
          if (_typingUserIds.isNotEmpty)
            _TypingDots(count: _typingUserIds.length),
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
                    final messageId = msg['id'] as String?;
                    final senderId = (msg['sender'] as Map<String, dynamic>?)?['id'] as String?;
                    final isMine = senderId != null && senderId == myId;
                    final isPinned = messageId != null && pinnedIds.contains(messageId);
                    return _MessageRow(
                      msg: msg,
                      isMine: isMine,
                      isPinned: isPinned,
                      myId: myId,
                      quickEmojis: _kHoverEmojis,
                      onReact: _toggleReaction,
                      onOpenThread: _openThread,
                      onLongPress: () => _showMessageOptions(msg, isMine, isPinned),
                      onAddReaction: messageId == null
                          ? null
                          : () => _showEmojiPicker(
                                messageId,
                                (msg['reactions'] as List<dynamic>?) ?? const [],
                              ),
                      onTogglePin: messageId == null
                          ? null
                          : () => _togglePin(messageId, isPinned),
                      onConvertToTask: () => _openConvertToTask(msg),
                      onChannelTap: (_) {},
                      groupReactions: _groupReactions,
                      userHasReaction: _userHasReaction,
                    );
                  },
                );
              },
            ),
          ),
          _buildInputBar(socket),
        ],
    );
  }

  void _pickSnippet(_Snippet s) {
    final current = _messageController.text;
    _messageController.text = current.isEmpty ? s.content : '$current\n${s.content}';
    _messageController.selection = TextSelection.collapsed(offset: _messageController.text.length);
    setState(() {});
  }

  Future<void> _openBroadcast() async {
    final workspaceId = ref.read(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('請先選擇工作空間')));
      }
      return;
    }
    final content = _messageController.text.trim();
    if (content.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('請先輸入訊息內容')));
      }
      return;
    }
    final result = await showDialog<List<String>>(
      context: context,
      builder: (ctx) => _BroadcastDialog(
        workspaceId: workspaceId,
        currentChannelId: widget.channelId,
        content: content,
      ),
    );
    if (result == null || result.isEmpty) return;
    try {
      await ref.read(apiClientProvider).broadcastMessages(
        channelIds: result,
        content: content,
      );
      if (!mounted) return;
      _messageController.clear();
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('已廣播到 ${result.length} 個頻道')));
      ref.invalidate(messagesProvider(widget.channelId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('廣播失敗：$e')));
      }
    }
  }

  Future<void> _openSchedule() async {
    if (_messageController.text.trim().isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('請先輸入訊息內容')));
      }
      return;
    }
    final result = await showDialog<DateTime>(
      context: context,
      builder: (ctx) => const _ScheduleDialog(),
    );
    if (result == null) return;
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '已排程 ${result.year}-${result.month.toString().padLeft(2, '0')}-${result.day.toString().padLeft(2, '0')} '
            '${result.hour.toString().padLeft(2, '0')}:${result.minute.toString().padLeft(2, '0')}'
            ' (C-17 後端未接,本地提示)',
          ),
        ),
      );
    }
  }

  Widget _buildInputBar(SocketService socket) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.attach_file),
                tooltip: '附加檔案 (C-05)',
                onPressed: _pickAndUploadFile,
              ),
              PopupMenuButton<_Snippet>(
                tooltip: '訊息範本 (C-15)',
                icon: const Icon(Icons.integration_instructions_outlined),
                onSelected: _pickSnippet,
                itemBuilder: (_) => [
                  for (final s in _kSnippets)
                    PopupMenuItem<_Snippet>(
                      value: s,
                      child: _SnippetMenuItem(snippet: s),
                    ),
                ],
              ),
              IconButton(
                icon: const Icon(Icons.campaign_outlined),
                tooltip: '跨頻道廣播 (C-16)',
                onPressed: _openBroadcast,
              ),
              IconButton(
                icon: const Icon(Icons.schedule_outlined),
                tooltip: '排程訊息 (C-17)',
                onPressed: _openSchedule,
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
          Padding(
            padding: const EdgeInsets.only(left: 12, top: 2, bottom: 2),
            child: DefaultTextStyle.merge(
              style: TextStyle(
                fontSize: 10,
                color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.45),
              ),
              child: Row(
                children: const [
                  Text('↵ 送出'),
                  SizedBox(width: 12),
                  Text('⇧↵ 換行'),
                  SizedBox(width: 12),
                  Text('@ 提及'),
                  SizedBox(width: 12),
                  Text('/ 指令'),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────── message row ───────────────────────────

class _MessageRow extends StatefulWidget {
  final Map<String, dynamic> msg;
  final bool isMine;
  final bool isPinned;
  final String? myId;
  final List<String> quickEmojis;
  final Future<void> Function(String messageId, String emoji, bool currentlyHas) onReact;
  final void Function(Map<String, dynamic> msg) onOpenThread;
  final VoidCallback onLongPress;
  final VoidCallback? onAddReaction;
  final VoidCallback? onTogglePin;
  final VoidCallback onConvertToTask;
  final void Function(String channel) onChannelTap;
  final Map<String, List<Map<String, dynamic>>> Function(List<dynamic>) groupReactions;
  final bool Function(String?, String, List<dynamic>) userHasReaction;

  const _MessageRow({
    required this.msg,
    required this.isMine,
    required this.isPinned,
    required this.myId,
    required this.quickEmojis,
    required this.onReact,
    required this.onOpenThread,
    required this.onLongPress,
    required this.onAddReaction,
    required this.onTogglePin,
    required this.onConvertToTask,
    required this.onChannelTap,
    required this.groupReactions,
    required this.userHasReaction,
  });

  @override
  State<_MessageRow> createState() => _MessageRowState();
}

class _MessageRowState extends State<_MessageRow> {
  bool _hover = false;

  bool get _isAutomation {
    final type = widget.msg['type'] as String?;
    if (type == 'system') return true;
    final meta = widget.msg['metadata'];
    if (meta is Map && meta['automation'] == true) return true;
    return false;
  }

  String? get _scheduledFor {
    final meta = widget.msg['metadata'];
    if (meta is Map) {
      final v = meta['scheduledFor'] ?? meta['scheduledAt'];
      if (v is String) return v;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final msg = widget.msg;
    final sender = msg['sender'] as Map<String, dynamic>?;
    final reactions = (msg['reactions'] as List<dynamic>?) ?? const [];
    final replyCount = msg['_count'] is Map ? (msg['_count'] as Map)['replies'] : null;
    final nReplies = replyCount is int ? replyCount : int.tryParse('$replyCount') ?? 0;
    final hasThread = nReplies > 0;
    final messageId = msg['id'] as String?;
    final grouped = widget.groupReactions(reactions);
    final content = msg['content'] as String? ?? '';

    if (_isAutomation) {
      return _AutomationMessage(content: content);
    }

    final row = Padding(
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
                if (widget.isPinned)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: const [
                        Icon(Icons.push_pin, size: 11, color: Color(0xFFF59E0B)),
                        SizedBox(width: 4),
                        Text(
                          '已置頂',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFFF59E0B),
                            letterSpacing: 0.8,
                          ),
                        ),
                      ],
                    ),
                  ),
                if (_scheduledFor != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.schedule, size: 11, color: OideaTokens.accent),
                        const SizedBox(width: 4),
                        Text(
                          '排程中 · $_scheduledFor',
                          style: const TextStyle(
                            fontSize: 10,
                            fontWeight: FontWeight.w700,
                            color: OideaTokens.accent,
                            letterSpacing: 0.6,
                          ),
                        ),
                      ],
                    ),
                  ),
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
                    content: content,
                    onMentionTap: (u) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text('@$u')),
                      );
                    },
                    onChannelTap: widget.onChannelTap,
                  ),
                if (msg['type'] == 'file')
                  _FileMessageTile(
                    metadata: (msg['metadata'] as Map?)?.cast<String, dynamic>(),
                    fallback: content,
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
                if (grouped.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Wrap(
                      spacing: 4,
                      runSpacing: 4,
                      children: grouped.entries.map((e) {
                        final emoji = e.key;
                        final list = e.value;
                        final count = list.length;
                        final hasMine =
                            widget.myId != null && list.any((x) => x['userId'] == widget.myId);
                        return _ReactionChip(
                          emoji: emoji,
                          count: count,
                          mine: hasMine,
                          onTap: messageId == null
                              ? null
                              : () => widget.onReact(messageId, emoji, hasMine),
                        );
                      }).toList(),
                    ),
                  ),
                if (hasThread)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: InkWell(
                      onTap: () => widget.onOpenThread(msg),
                      borderRadius: BorderRadius.circular(6),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 4),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.forum_outlined, size: 14, color: OideaTokens.accent),
                            const SizedBox(width: 6),
                            Text(
                              '$nReplies 則回覆',
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                                color: OideaTokens.accent,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onLongPress: widget.onLongPress,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              decoration: BoxDecoration(
                color: widget.isPinned
                    ? const Color(0x0DF59E0B) // pinned tint
                    : _hover
                        ? Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.035)
                        : Colors.transparent,
                border: widget.isPinned
                    ? const Border(left: BorderSide(color: Color(0xFFF59E0B), width: 3))
                    : null,
                borderRadius: BorderRadius.circular(6),
              ),
              padding: EdgeInsets.only(
                left: widget.isPinned ? 8 : 0,
                right: 4,
              ),
              child: row,
            ),
            if (_hover && messageId != null)
              Positioned(
                top: -4,
                right: 8,
                child: _HoverActions(
                  quickEmojis: widget.quickEmojis,
                  onQuickReact: (e) {
                    final has = widget.userHasReaction(widget.myId, e,
                        (widget.msg['reactions'] as List<dynamic>?) ?? const []);
                    widget.onReact(messageId, e, has);
                  },
                  onThread: () => widget.onOpenThread(widget.msg),
                  onAddReaction: widget.onAddReaction,
                  isPinned: widget.isPinned,
                  onTogglePin: widget.onTogglePin,
                  onConvertToTask: widget.onConvertToTask,
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _formatTime(dynamic createdAt) {
    if (createdAt == null) return '';
    final dt = DateTime.tryParse(createdAt.toString());
    if (dt == null) return '';
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }
}

// ─────────────────────────── hover action bar ───────────────────────────

class _HoverActions extends StatelessWidget {
  final List<String> quickEmojis;
  final void Function(String emoji) onQuickReact;
  final VoidCallback onThread;
  final VoidCallback? onAddReaction;
  final bool isPinned;
  final VoidCallback? onTogglePin;
  final VoidCallback onConvertToTask;

  const _HoverActions({
    required this.quickEmojis,
    required this.onQuickReact,
    required this.onThread,
    required this.onAddReaction,
    required this.isPinned,
    required this.onTogglePin,
    required this.onConvertToTask,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surface,
      elevation: 2,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(color: theme.dividerColor),
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final e in quickEmojis)
              InkWell(
                borderRadius: BorderRadius.circular(5),
                onTap: () => onQuickReact(e),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 3),
                  child: Text(e, style: const TextStyle(fontSize: 16)),
                ),
              ),
            if (onAddReaction != null)
              _HoverIconButton(
                icon: Icons.add_reaction_outlined,
                tooltip: '更多表情',
                onTap: onAddReaction,
              ),
            _HoverIconButton(
              icon: Icons.forum_outlined,
              tooltip: '回覆討論串',
              onTap: onThread,
            ),
            _HoverIconButton(
              icon: isPinned ? Icons.push_pin : Icons.push_pin_outlined,
              tooltip: isPinned ? '取消置頂' : '置頂',
              color: isPinned ? const Color(0xFFF59E0B) : null,
              onTap: onTogglePin,
            ),
            _HoverIconButton(
              icon: Icons.task_alt_outlined,
              tooltip: '轉為任務 (C-18)',
              onTap: onConvertToTask,
            ),
          ],
        ),
      ),
    );
  }
}

class _HoverIconButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final Color? color;
  const _HoverIconButton({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(5),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
          child: Icon(icon, size: 14, color: color ?? Theme.of(context).iconTheme.color),
        ),
      ),
    );
  }
}

// ─────────────────────────── reaction chip ───────────────────────────

class _ReactionChip extends StatelessWidget {
  final String emoji;
  final int count;
  final bool mine;
  final VoidCallback? onTap;
  const _ReactionChip({
    required this.emoji,
    required this.count,
    required this.mine,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final border = mine
        ? const Color(0xFF4F46E5).withValues(alpha: 0.4)
        : Theme.of(context).dividerColor;
    final bg = mine
        ? const Color(0xFF4F46E5).withValues(alpha: 0.15)
        : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.05);
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: bg,
          border: Border.all(color: border),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(emoji, style: const TextStyle(fontSize: 13)),
            const SizedBox(width: 4),
            Text(
              '$count',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.78),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────── typing dots ───────────────────────────

class _TypingDots extends StatefulWidget {
  final int count;
  const _TypingDots({required this.count});
  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200))
      ..repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accent = OideaTokens.accent;
    return Material(
      color: Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.3),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Row(
          children: [
            AnimatedBuilder(
              animation: _c,
              builder: (_, __) {
                return SizedBox(
                  width: 28,
                  height: 10,
                  child: Stack(
                    children: List.generate(3, (i) {
                      final phase = (_c.value - i * 0.15) % 1.0;
                      final up = phase < 0.3 ? (phase / 0.3) : phase < 0.6 ? 1 - (phase - 0.3) / 0.3 : 0.0;
                      return Positioned(
                        left: i * 10.0,
                        top: 5 - 4 * up,
                        child: Container(
                          width: 6,
                          height: 6,
                          decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
                        ),
                      );
                    }),
                  ),
                );
              },
            ),
            const SizedBox(width: 10),
            Text(
              widget.count == 1 ? '有成員正在輸入…' : '${widget.count} 人正在輸入…',
              style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurface),
            ),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────── pinned drawer ───────────────────────────

class _PinnedDrawer extends StatelessWidget {
  final List<dynamic> pinned;
  final void Function(String messageId) onTap;
  final void Function(String messageId) onUnpin;
  const _PinnedDrawer({
    required this.pinned,
    required this.onTap,
    required this.onUnpin,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(maxHeight: 180),
      decoration: BoxDecoration(
        color: const Color(0x0DF59E0B),
        border: Border(bottom: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Row(
            children: [
              Icon(Icons.push_pin, size: 12, color: Color(0xFFF59E0B)),
              SizedBox(width: 4),
              Text(
                '置頂訊息 (C-13)',
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFFF59E0B),
                  letterSpacing: 0.8,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Flexible(
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: pinned.length,
              itemBuilder: (_, i) {
                final entry = pinned[i] as Map<String, dynamic>;
                final msg = entry['message'] is Map
                    ? (entry['message'] as Map).cast<String, dynamic>()
                    : entry;
                final messageId = msg['id'] as String? ?? entry['messageId'] as String?;
                final sender = (msg['sender'] as Map?)?.cast<String, dynamic>();
                final content = (msg['content'] as String?) ?? '';
                return InkWell(
                  onTap: messageId == null ? null : () => onTap(messageId),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        Expanded(
                          child: RichText(
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            text: TextSpan(
                              style: DefaultTextStyle.of(context).style.copyWith(fontSize: 12),
                              children: [
                                TextSpan(
                                  text:
                                      '${sender?['displayName'] as String? ?? 'Unknown'}: ',
                                  style: const TextStyle(fontWeight: FontWeight.w600),
                                ),
                                TextSpan(
                                  text: content,
                                  style: TextStyle(
                                    color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.8),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                        if (messageId != null)
                          IconButton(
                            icon: const Icon(Icons.close, size: 14),
                            tooltip: '取消置頂',
                            visualDensity: VisualDensity.compact,
                            onPressed: () => onUnpin(messageId),
                          ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────── automation message ───────────────────────────

class _AutomationMessage extends StatelessWidget {
  final String content;
  const _AutomationMessage({required this.content});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: OideaTokens.accent.withValues(alpha: 0.1),
              border: Border.all(color: OideaTokens.accent, style: BorderStyle.solid),
              borderRadius: BorderRadius.circular(8),
            ),
            alignment: Alignment.center,
            child: const Text('🤖', style: TextStyle(fontSize: 14)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 7),
              child: Text(
                content,
                style: TextStyle(
                  fontSize: 12,
                  fontStyle: FontStyle.italic,
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────── convert-to-task dialog ───────────────────────────

class _ConvertToTaskResult {
  final String projectId;
  final String columnId;
  final String title;
  _ConvertToTaskResult({
    required this.projectId,
    required this.columnId,
    required this.title,
  });
}

class _ConvertToTaskDialog extends ConsumerStatefulWidget {
  final String workspaceId;
  final String initialTitle;
  const _ConvertToTaskDialog({required this.workspaceId, required this.initialTitle});

  @override
  ConsumerState<_ConvertToTaskDialog> createState() => _ConvertToTaskDialogState();
}

class _ConvertToTaskDialogState extends ConsumerState<_ConvertToTaskDialog> {
  late TextEditingController _titleController;
  String? _selectedProjectId;
  String? _selectedColumnId;
  List<dynamic> _columns = const [];
  bool _loadingColumns = false;

  @override
  void initState() {
    super.initState();
    final raw = widget.initialTitle.trim();
    final short = raw.length > 80 ? '${raw.substring(0, 80)}…' : raw;
    _titleController = TextEditingController(text: short);
  }

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  Future<void> _loadColumns(String projectId) async {
    setState(() {
      _loadingColumns = true;
      _selectedColumnId = null;
      _columns = const [];
    });
    try {
      final project = await ref.read(apiClientProvider).getProject(projectId);
      final cols = (project['columns'] as List<dynamic>?) ?? const [];
      if (!mounted) return;
      setState(() {
        _columns = cols;
        if (cols.isNotEmpty) {
          _selectedColumnId = (cols.first as Map<String, dynamic>)['id'] as String?;
        }
      });
    } finally {
      if (mounted) setState(() => _loadingColumns = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final projectsAsync = ref.watch(projectsProvider(widget.workspaceId));

    return AlertDialog(
      title: const Text('轉為任務 (C-18)'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _titleController,
              maxLines: null,
              decoration: const InputDecoration(
                labelText: '任務標題',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 12),
            projectsAsync.when(
              loading: () => const LinearProgressIndicator(),
              error: (e, _) => Text('載入專案失敗：$e'),
              data: (projects) {
                if (projects.isEmpty) {
                  return const Text('此工作空間尚無專案。請先建立專案。');
                }
                return DropdownButtonFormField<String>(
                  value: _selectedProjectId,
                  decoration: const InputDecoration(
                    labelText: '專案',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  items: [
                    for (final p in projects.cast<Map<String, dynamic>>())
                      DropdownMenuItem(
                        value: p['id'] as String?,
                        child: Text(p['name'] as String? ?? p['id'] as String? ?? ''),
                      ),
                  ],
                  onChanged: (v) {
                    if (v == null) return;
                    setState(() => _selectedProjectId = v);
                    _loadColumns(v);
                  },
                );
              },
            ),
            const SizedBox(height: 12),
            if (_loadingColumns) const LinearProgressIndicator(),
            if (!_loadingColumns && _columns.isNotEmpty)
              DropdownButtonFormField<String>(
                value: _selectedColumnId,
                decoration: const InputDecoration(
                  labelText: '欄位',
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
                items: [
                  for (final c in _columns.cast<Map<String, dynamic>>())
                    DropdownMenuItem(
                      value: c['id'] as String?,
                      child: Text(c['name'] as String? ?? c['id'] as String? ?? ''),
                    ),
                ],
                onChanged: (v) => setState(() => _selectedColumnId = v),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _selectedProjectId == null ||
                  _selectedColumnId == null ||
                  _titleController.text.trim().isEmpty
              ? null
              : () {
                  Navigator.pop(
                    context,
                    _ConvertToTaskResult(
                      projectId: _selectedProjectId!,
                      columnId: _selectedColumnId!,
                      title: _titleController.text.trim(),
                    ),
                  );
                },
          child: const Text('建立任務'),
        ),
      ],
    );
  }
}

// ─────────────────────────── file tile (preserved) ───────────────────────────

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

// ─────────────────────────── snippet menu item ───────────────────────────

class _SnippetMenuItem extends StatelessWidget {
  final _Snippet snippet;
  const _SnippetMenuItem({required this.snippet});

  @override
  Widget build(BuildContext context) {
    final isWorkspace = snippet.scope == 'workspace';
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 260),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Text(
                snippet.name,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                decoration: BoxDecoration(
                  color: isWorkspace
                      ? OideaTokens.accent.withValues(alpha: 0.12)
                      : Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.07),
                  borderRadius: BorderRadius.circular(3),
                ),
                child: Text(
                  snippet.scope.toUpperCase(),
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w700,
                    color: isWorkspace ? OideaTokens.accent : Theme.of(context).hintColor,
                    letterSpacing: 0.6,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            snippet.content.replaceAll('\n', ' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 11,
              color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────── broadcast dialog ───────────────────────────

class _BroadcastDialog extends ConsumerStatefulWidget {
  final String workspaceId;
  final String currentChannelId;
  final String content;
  const _BroadcastDialog({
    required this.workspaceId,
    required this.currentChannelId,
    required this.content,
  });

  @override
  ConsumerState<_BroadcastDialog> createState() => _BroadcastDialogState();
}

class _BroadcastDialogState extends ConsumerState<_BroadcastDialog> {
  final Set<String> _selected = <String>{};

  @override
  void initState() {
    super.initState();
    _selected.add(widget.currentChannelId);
  }

  @override
  Widget build(BuildContext context) {
    final api = ref.watch(apiClientProvider);
    return AlertDialog(
      title: const Text('跨頻道廣播 (C-16)'),
      content: SizedBox(
        width: 460,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.04),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Theme.of(context).dividerColor),
              ),
              child: Text(
                widget.content,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              '選擇頻道 (${_selected.length})',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: Theme.of(context).hintColor,
                letterSpacing: 0.8,
              ),
            ),
            const SizedBox(height: 4),
            FutureBuilder<List<dynamic>>(
              future: api.getChannels(widget.workspaceId),
              builder: (_, snap) {
                if (!snap.hasData) return const LinearProgressIndicator();
                final channels = snap.data!.cast<Map<String, dynamic>>();
                return Flexible(
                  child: SizedBox(
                    height: 240,
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final c in channels)
                          CheckboxListTile(
                            value: _selected.contains(c['id']),
                            dense: true,
                            controlAffinity: ListTileControlAffinity.leading,
                            title: Text(
                              '# ${c['name'] ?? c['id']}',
                              style: const TextStyle(fontSize: 13),
                            ),
                            onChanged: (v) {
                              final id = c['id'] as String?;
                              if (id == null) return;
                              setState(() {
                                if (v == true) {
                                  _selected.add(id);
                                } else {
                                  _selected.remove(id);
                                }
                              });
                            },
                          ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _selected.isEmpty
              ? null
              : () => Navigator.pop(context, _selected.toList()),
          child: Text('廣播到 ${_selected.length} 個頻道'),
        ),
      ],
    );
  }
}

// ─────────────────────────── schedule dialog ───────────────────────────

class _ScheduleDialog extends StatefulWidget {
  const _ScheduleDialog();

  @override
  State<_ScheduleDialog> createState() => _ScheduleDialogState();
}

class _ScheduleDialogState extends State<_ScheduleDialog> {
  DateTime? _selected;
  int _presetIndex = 0;

  List<_SchedulePreset> get _presets {
    final now = DateTime.now();
    final tomorrow9 = DateTime(now.year, now.month, now.day + 1, 9);
    final daysToMonday = (DateTime.monday - now.weekday) % 7;
    final monday = DateTime(now.year, now.month, now.day + (daysToMonday == 0 ? 7 : daysToMonday), 9);
    final later = DateTime(now.year, now.month, now.day, 17);
    final laterValid = later.isAfter(now) ? later : now.add(const Duration(hours: 2));
    return [
      _SchedulePreset('明天 09:00', tomorrow9),
      _SchedulePreset('下週一 09:00', monday),
      _SchedulePreset('今天稍晚 17:00', laterValid),
      const _SchedulePreset('自訂…', null),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final presets = _presets;
    return AlertDialog(
      title: const Text('排程訊息 (C-17)'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < presets.length; i++)
              RadioListTile<int>(
                value: i,
                groupValue: _presetIndex,
                dense: true,
                title: Text(presets[i].label),
                subtitle: presets[i].when == null
                    ? null
                    : Text(
                        '${presets[i].when!.year}-'
                        '${presets[i].when!.month.toString().padLeft(2, '0')}-'
                        '${presets[i].when!.day.toString().padLeft(2, '0')} '
                        '${presets[i].when!.hour.toString().padLeft(2, '0')}:'
                        '${presets[i].when!.minute.toString().padLeft(2, '0')}',
                        style: const TextStyle(fontSize: 11),
                      ),
                onChanged: (v) async {
                  if (v == null) return;
                  setState(() => _presetIndex = v);
                  if (presets[v].when != null) {
                    _selected = presets[v].when;
                  } else {
                    final picked = await _pickCustom();
                    if (picked != null) _selected = picked;
                  }
                },
              ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final when = _selected ?? presets[_presetIndex].when;
            if (when != null) Navigator.pop(context, when);
          },
          child: const Text('排程'),
        ),
      ],
    );
  }

  Future<DateTime?> _pickCustom() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: now,
      firstDate: now,
      lastDate: now.add(const Duration(days: 365)),
    );
    if (date == null || !mounted) return null;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(now.add(const Duration(hours: 1))),
    );
    if (time == null) return null;
    return DateTime(date.year, date.month, date.day, time.hour, time.minute);
  }
}

class _SchedulePreset {
  final String label;
  final DateTime? when;
  const _SchedulePreset(this.label, this.when);
}
