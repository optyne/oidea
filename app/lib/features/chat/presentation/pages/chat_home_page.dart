import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/channel_provider.dart';
import 'channel_page.dart';

class ChatHomePage extends ConsumerStatefulWidget {
  const ChatHomePage({super.key});

  @override
  ConsumerState<ChatHomePage> createState() => _ChatHomePageState();
}

class _ChatHomePageState extends ConsumerState<ChatHomePage> {
  String? _selectedChannelId;

  @override
  Widget build(BuildContext context) {
    final workspacesAsync = ref.watch(workspacesProvider);
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    final isWide = MediaQuery.sizeOf(context).width > 768;

    if (workspacesAsync.isLoading) {
      return Scaffold(
        appBar: AppBar(title: const Text('聊天')),
        body: const LoadingWidget(),
      );
    }

    final list = workspacesAsync.value ?? [];
    if (list.isNotEmpty && workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('聊天')),
        body: const LoadingWidget(),
      );
    }
    if (workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('聊天')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('請在頂端建立或選擇工作空間', textAlign: TextAlign.center),
          ),
        ),
      );
    }

    final channelsAsync = ref.watch(channelsProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('聊天'),
        actions: [
          IconButton(icon: const Icon(Icons.search), onPressed: () {}),
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () => _showCreateChannelDialog(context, workspaceId),
          ),
        ],
      ),
      body: Row(
        children: [
          Expanded(
            flex: isWide ? 2 : 3,
            child: channelsAsync.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(
                message: e.toString(),
                onRetry: () => ref.invalidate(channelsProvider(workspaceId)),
              ),
              data: (channels) {
                if (channels.isEmpty) {
                  return EmptyStateWidget(
                    icon: Icons.chat_bubble_outline,
                    title: '尚無頻道',
                    subtitle: '建立第一個頻道開始聊天',
                    action: FilledButton(
                      onPressed: () => _showCreateChannelDialog(context, workspaceId),
                      child: const Text('建立頻道'),
                    ),
                  );
                }
                return ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  itemCount: channels.length,
                  itemBuilder: (context, index) {
                    final channel = channels[index] as Map<String, dynamic>;
                    final id = channel['id'] as String?;
                    final name = channel['name'] as String? ?? '';
                    final type = channel['type'] as String? ?? 'public';
                    final isSelected = id == _selectedChannelId;

                    return ListTile(
                      selected: isSelected,
                      selectedTileColor: Theme.of(context).colorScheme.primaryContainer.withOpacity(0.35),
                      leading: CircleAvatar(
                        backgroundColor: type == 'dm'
                            ? Theme.of(context).colorScheme.tertiaryContainer
                            : Theme.of(context).colorScheme.primary,
                        radius: 20,
                        child: Icon(
                          type == 'dm' ? Icons.person : Icons.tag,
                          size: 18,
                          color: type == 'dm'
                              ? Theme.of(context).colorScheme.onTertiaryContainer
                              : Theme.of(context).colorScheme.onPrimary,
                        ),
                      ),
                      title: Text(name),
                      subtitle: channel['topic'] != null
                          ? Text(
                              channel['topic'].toString(),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                            )
                          : null,
                      onTap: () {
                        if (id == null) return;
                        setState(() => _selectedChannelId = id);
                        if (!isWide) {
                          context.push('/chat/channel/$id');
                        }
                      },
                    );
                  },
                );
              },
            ),
          ),
          if (isWide && _selectedChannelId != null)
            Expanded(
              flex: 5,
              child: ChannelPage(channelId: _selectedChannelId!),
            ),
        ],
      ),
      floatingActionButton: isWide
          ? null
          : FloatingActionButton(
              onPressed: () => _showCreateChannelDialog(context, workspaceId),
              child: const Icon(Icons.add),
            ),
    );
  }

  void _showCreateChannelDialog(BuildContext context, String workspaceId) {
    final nameController = TextEditingController();
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('建立頻道'),
        content: TextField(
          controller: nameController,
          decoration: const InputDecoration(labelText: '頻道名稱'),
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () async {
              final name = nameController.text.trim();
              if (name.isEmpty) return;
              Navigator.pop(ctx);
              try {
                final api = ref.read(apiClientProvider);
                await api.createChannel({
                  'workspaceId': workspaceId,
                  'name': name,
                  'type': 'public',
                });
                ref.invalidate(channelsProvider(workspaceId));
              } catch (e) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
                }
              }
            },
            child: const Text('建立'),
          ),
        ],
      ),
    ).then((_) => nameController.dispose());
  }
}
