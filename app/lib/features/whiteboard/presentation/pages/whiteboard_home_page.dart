import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/whiteboard_provider.dart';

class WhiteboardHomePage extends ConsumerStatefulWidget {
  const WhiteboardHomePage({super.key});

  @override
  ConsumerState<WhiteboardHomePage> createState() => _WhiteboardHomePageState();
}

class _WhiteboardHomePageState extends ConsumerState<WhiteboardHomePage> {
  @override
  Widget build(BuildContext context) {
    final workspacesAsync = ref.watch(workspacesProvider);
    final workspaceId = ref.watch(currentWorkspaceIdProvider);

    if (workspacesAsync.isLoading) {
      return Scaffold(
        appBar: AppBar(title: const Text('白板')),
        body: const LoadingWidget(),
      );
    }
    final list = workspacesAsync.value ?? [];
    if (list.isNotEmpty && workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('白板')),
        body: const LoadingWidget(),
      );
    }
    if (workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('白板')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('請在頂端建立或選擇工作空間', textAlign: TextAlign.center),
          ),
        ),
      );
    }

    final boardsAsync = ref.watch(whiteboardsProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('白板'),
        actions: [
          IconButton(icon: const Icon(Icons.auto_awesome), onPressed: () => _showTemplates(context)),
        ],
      ),
      body: boardsAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(
              message: e.toString(),
              onRetry: () => ref.invalidate(whiteboardsProvider(workspaceId)),
            ),
        data: (boards) {
          if (boards.isEmpty) {
            return EmptyStateWidget(
              icon: Icons.draw_outlined,
              title: '尚無白板',
              subtitle: '建立白板開始協作繪圖',
              action: FilledButton(onPressed: () => _createNew(context, workspaceId), child: const Text('建立白板')),
            );
          }

          return GridView.builder(
            padding: const EdgeInsets.all(16),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              childAspectRatio: 1.2,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
            ),
            itemCount: boards.length,
            itemBuilder: (context, index) {
              final board = boards[index] as Map<String, dynamic>;
              return Card(
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => context.go('/whiteboard/canvas/${board['id']}'),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(Icons.draw, color: Color(0xFF7C3AED)),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                board['title'] ?? '',
                                style: const TextStyle(fontWeight: FontWeight.w600),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            PopupMenuButton(
                              itemBuilder: (ctx) => [
                                const PopupMenuItem(value: 'delete', child: Text('刪除')),
                              ],
                              onSelected: (val) async {
                                if (val == 'delete') {
                                  final api = ref.read(apiClientProvider);
                                  await api.deleteWhiteboard(board['id'] as String);
                                  ref.invalidate(whiteboardsProvider(workspaceId));
                                }
                              },
                            ),
                          ],
                        ),
                        const Spacer(),
                        if (board['description'] != null)
                          Text(
                            board['description'],
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                          ),
                        const SizedBox(height: 8),
                        Text(
                          '更新於 ${_formatDate(board['updatedAt'])}',
                          style: TextStyle(fontSize: 11, color: Colors.grey.shade400),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _createNew(context, workspaceId),
        child: const Icon(Icons.add),
      ),
    );
  }

  void _createNew(BuildContext context, String workspaceId) {
    final titleController = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('建立白板'),
        content: TextField(controller: titleController, decoration: const InputDecoration(labelText: '白板名稱')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () async {
              final api = ref.read(apiClientProvider);
              final board = await api.createWhiteboard({
                'workspaceId': workspaceId,
                'title': titleController.text,
              });
              if (ctx.mounted) Navigator.pop(ctx);
              ref.invalidate(whiteboardsProvider(workspaceId));
              if (context.mounted) context.go('/whiteboard/canvas/${board['id']}');
            },
            child: const Text('建立'),
          ),
        ],
      ),
    );
  }

  void _showTemplates(BuildContext context) {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('範本', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 16),
            Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                _TemplateChip(icon: Icons.lightbulb_outline, label: '腦力激盪'),
                _TemplateChip(icon: Icons.account_tree, label: '流程圖'),
                _TemplateChip(icon: Icons.grid_view, label: 'SWOT 分析'),
                _TemplateChip(icon: Icons.psychology, label: '心智圖'),
                _TemplateChip(icon: Icons.timeline, label: '時間軸'),
                _TemplateChip(icon: Icons.sticky_note_2, label: '便利貼牆'),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _formatDate(dynamic date) {
    if (date == null) return '';
    final dt = DateTime.tryParse(date.toString());
    if (dt == null) return '';
    return '${dt.month}/${dt.day}';
  }
}

class _TemplateChip extends StatelessWidget {
  final IconData icon;
  final String label;
  const _TemplateChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: Icon(icon, size: 18),
      label: Text(label),
      onPressed: () {
        Navigator.pop(context);
      },
    );
  }
}
