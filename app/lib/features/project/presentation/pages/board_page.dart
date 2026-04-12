import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../providers/project_provider.dart';

class TaskDragData {
  final String taskId;
  final String sourceColumnId;
  const TaskDragData({required this.taskId, required this.sourceColumnId});
}

class BoardPage extends ConsumerStatefulWidget {
  final String projectId;
  const BoardPage({super.key, required this.projectId});

  @override
  ConsumerState<BoardPage> createState() => _BoardPageState();
}

class _BoardPageState extends ConsumerState<BoardPage> {
  @override
  Widget build(BuildContext context) {
    final boardAsync = ref.watch(boardProvider(widget.projectId));

    return Scaffold(
      appBar: AppBar(
        title: boardAsync.when(
          data: (b) => Text(b['name'] as String? ?? '看板'),
          loading: () => const Text('載入中…'),
          error: (_, __) => const Text('看板'),
        ),
        actions: [
          IconButton(icon: const Icon(Icons.filter_list), onPressed: () {}),
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'column') {
                _showAddColumn(context);
              }
            },
            itemBuilder: (ctx) => const [
              PopupMenuItem(value: 'column', child: Text('新增欄位')),
            ],
          ),
        ],
      ),
      body: boardAsync.when(
        loading: () => const Center(child: CircularProgressIndicator.adaptive()),
        error: (e, _) => Center(child: Text('錯誤: $e')),
        data: (board) {
          final columns = (board['columns'] as List<dynamic>?) ?? [];
          if (columns.isEmpty) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('尚無欄位', style: TextStyle(color: Colors.grey)),
                  const SizedBox(height: 12),
                  FilledButton.tonal(
                    onPressed: () => _showAddColumn(context),
                    child: const Text('新增第一個欄位'),
                  ),
                ],
              ),
            );
          }
          return ListView.builder(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(16),
            itemCount: columns.length,
            itemBuilder: (context, index) {
              final column = columns[index] as Map<String, dynamic>;
              final tasks = (column['tasks'] as List<dynamic>?) ?? [];
              return SizedBox(
                width: 300,
                child: Card(
                  margin: const EdgeInsets.only(right: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildColumnHeader(context, column),
                      Expanded(
                        child: DragTarget<TaskDragData>(
                          onWillAcceptWithDetails: (details) =>
                              details.data.sourceColumnId != (column['id'] as String),
                          onAcceptWithDetails: (details) {
                            _onTaskDropped(details.data, column);
                          },
                          builder: (context, candidateData, rejected) {
                            final highlight = candidateData.isNotEmpty;
                            return AnimatedContainer(
                              duration: const Duration(milliseconds: 120),
                              margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(
                                  color: highlight
                                      ? Theme.of(context).colorScheme.primary
                                      : Theme.of(context).dividerColor.withValues(alpha: 0.3),
                                  width: highlight ? 2 : 1,
                                ),
                                color: highlight
                                    ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.2)
                                    : null,
                              ),
                              child: tasks.isEmpty
                                  ? Center(
                                      child: Text(
                                        highlight ? '放開以移入此欄' : '長按任務拖曳到另一欄',
                                        textAlign: TextAlign.center,
                                        style: TextStyle(fontSize: 13, color: Colors.grey.shade600),
                                      ),
                                    )
                                  : ListView.builder(
                                      padding: const EdgeInsets.all(8),
                                      itemCount: tasks.length,
                                      itemBuilder: (context, i) {
                                        final task = tasks[i] as Map<String, dynamic>;
                                        final taskId = task['id'] as String?;
                                        final columnId = column['id'] as String;
                                        if (taskId == null) {
                                          return const SizedBox.shrink();
                                        }
                                        return LongPressDraggable<TaskDragData>(
                                          data: TaskDragData(taskId: taskId, sourceColumnId: columnId),
                                          feedback: Material(
                                            elevation: 8,
                                            borderRadius: BorderRadius.circular(8),
                                            child: SizedBox(
                                              width: 260,
                                              child: _TaskCard(
                                                task: task,
                                                onTap: () {},
                                              ),
                                            ),
                                          ),
                                          childWhenDragging: Opacity(
                                            opacity: 0.35,
                                            child: _TaskCard(task: task, onTap: () {}),
                                          ),
                                          child: _TaskCard(
                                            task: task,
                                            onTap: () {
                                              context.push('/projects/board/${widget.projectId}/task/$taskId');
                                            },
                                          ),
                                        );
                                      },
                                    ),
                            );
                          },
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showAddTask(context),
        child: const Icon(Icons.add),
      ),
    );
  }

  Future<void> _onTaskDropped(TaskDragData data, Map<String, dynamic> targetColumn) async {
    final targetId = targetColumn['id'] as String;
    if (data.sourceColumnId == targetId) return;
    final targetTasks = (targetColumn['tasks'] as List<dynamic>?) ?? [];
    final position = targetTasks.length;
    try {
      await ref.read(apiClientProvider).moveTask(
            data.taskId,
            columnId: targetId,
            position: position,
          );
      ref.invalidate(boardProvider(widget.projectId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('移動任務失敗：$e')));
      }
    }
  }

  Widget _buildColumnHeader(BuildContext context, Map<String, dynamic> column) {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          Expanded(
            child: Text(
              column['name'] as String? ?? '欄位',
              style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _showAddColumn(BuildContext context) async {
    final nameController = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新增欄位'),
        content: TextField(
          controller: nameController,
          decoration: const InputDecoration(labelText: '欄位名稱'),
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final n = nameController.text.trim();
              Navigator.pop(ctx, n.isEmpty ? null : n);
            },
            child: const Text('建立'),
          ),
        ],
      ),
    );
    nameController.dispose();
    if (name == null || name.isEmpty) return;
    try {
      await ref.read(apiClientProvider).addProjectColumn(widget.projectId, {'name': name});
      ref.invalidate(boardProvider(widget.projectId));
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立欄位失敗：$e')));
      }
    }
  }

  Future<void> _showAddTask(BuildContext context) async {
    Map<String, dynamic> board;
    try {
      board = await ref.read(boardProvider(widget.projectId).future);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('無法載入看板：$e')));
      }
      return;
    }
    final cols = (board['columns'] as List<dynamic>?) ?? [];
    if (cols.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('請先新增至少一個欄位')),
        );
      }
      return;
    }

    final titleController = TextEditingController();
    var columnId = (cols.first as Map<String, dynamic>)['id'] as String?;

    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('新增任務'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: titleController,
                  decoration: const InputDecoration(labelText: '標題'),
                  autofocus: true,
                ),
                const SizedBox(height: 16),
                DropdownButtonFormField<String>(
                  value: columnId,
                  decoration: const InputDecoration(labelText: '欄位'),
                  items: cols.map((c) {
                    final m = c as Map<String, dynamic>;
                    return DropdownMenuItem<String>(
                      value: m['id'] as String?,
                      child: Text(m['name'] as String? ?? ''),
                    );
                  }).toList(),
                  onChanged: (v) => setSt(() => columnId = v),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(
              onPressed: () async {
                final title = titleController.text.trim();
                if (title.isEmpty || columnId == null) return;
                Navigator.pop(ctx);
                try {
                  await ref.read(apiClientProvider).createTask({
                    'projectId': widget.projectId,
                    'columnId': columnId,
                    'title': title,
                  });
                  ref.invalidate(boardProvider(widget.projectId));
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立任務失敗：$e')));
                  }
                }
              },
              child: const Text('建立'),
            ),
          ],
        ),
      ),
    );
    titleController.dispose();
  }
}

class _TaskCard extends StatelessWidget {
  final Map<String, dynamic> task;
  final VoidCallback onTap;

  const _TaskCard({required this.task, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text(task['title'] as String? ?? ''),
        subtitle: task['description'] != null
            ? Text(
                task['description'].toString(),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              )
            : null,
        onTap: onTap,
      ),
    );
  }
}
