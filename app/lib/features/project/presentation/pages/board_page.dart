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
  final Set<String> _filterAssigneeIds = {};
  final Set<String> _filterPriorities = {};

  bool _passesFilter(Map<String, dynamic> task) {
    if (_filterAssigneeIds.isNotEmpty) {
      final aid = (task['assignee'] as Map<String, dynamic>?)?['id'] as String?;
      if (aid == null || !_filterAssigneeIds.contains(aid)) return false;
    }
    if (_filterPriorities.isNotEmpty) {
      final p = task['priority'] as String? ?? 'medium';
      if (!_filterPriorities.contains(p)) return false;
    }
    return true;
  }

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
          IconButton(
            icon: Icon(
              Icons.filter_list,
              color: (_filterAssigneeIds.isNotEmpty || _filterPriorities.isNotEmpty)
                  ? Theme.of(context).colorScheme.primary
                  : null,
            ),
            onPressed: () async {
              final board = await ref.read(boardProvider(widget.projectId).future);
              if (!context.mounted) return;
              _openFilterSheet(context, board);
            },
          ),
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
              final allTasks = (column['tasks'] as List<dynamic>?) ?? [];
              final tasks = allTasks
                  .where((t) => _passesFilter(t as Map<String, dynamic>))
                  .toList();
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

  void _openFilterSheet(BuildContext context, Map<String, dynamic> board) {
    final columns = (board['columns'] as List<dynamic>?) ?? [];
    final assigneeMap = <String, Map<String, dynamic>>{};
    for (final c in columns) {
      final tasks = ((c as Map<String, dynamic>)['tasks'] as List<dynamic>?) ?? [];
      for (final t in tasks) {
        final a = (t as Map<String, dynamic>)['assignee'] as Map<String, dynamic>?;
        if (a != null && a['id'] is String) {
          assigneeMap[a['id'] as String] = a;
        }
      }
    }
    final assignees = assigneeMap.values.toList();

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => Padding(
          padding: EdgeInsets.only(
            left: 16,
            right: 16,
            top: 16,
            bottom: MediaQuery.of(ctx).viewInsets.bottom + 16,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('篩選', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  TextButton(
                    onPressed: () {
                      setSt(() {
                        _filterAssigneeIds.clear();
                        _filterPriorities.clear();
                      });
                      setState(() {});
                    },
                    child: const Text('清除'),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              const Text('優先級', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                children: const ['urgent', 'high', 'medium', 'low'].map((p) {
                  final selected = _filterPriorities.contains(p);
                  return FilterChip(
                    label: Text(_TaskCard._priorityLabel(p)),
                    selected: selected,
                    onSelected: (v) {
                      setSt(() {
                        if (v) {
                          _filterPriorities.add(p);
                        } else {
                          _filterPriorities.remove(p);
                        }
                      });
                      setState(() {});
                    },
                  );
                }).toList(),
              ),
              const SizedBox(height: 12),
              const Text('負責人', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              if (assignees.isEmpty)
                const Text('看板尚無指派', style: TextStyle(color: Colors.grey))
              else
                Wrap(
                  spacing: 6,
                  children: assignees.map((a) {
                    final id = a['id'] as String;
                    final name = a['displayName'] as String? ?? '';
                    final selected = _filterAssigneeIds.contains(id);
                    return FilterChip(
                      label: Text(name),
                      selected: selected,
                      onSelected: (v) {
                        setSt(() {
                          if (v) {
                            _filterAssigneeIds.add(id);
                          } else {
                            _filterAssigneeIds.remove(id);
                          }
                        });
                        setState(() {});
                      },
                    );
                  }).toList(),
                ),
              const SizedBox(height: 16),
            ],
          ),
        ),
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
    String priority = 'medium';
    String? assigneeId;
    DateTime? dueDate;

    // 列出工作空間成員作為可指派對象（來自現存任務的 assignee 集合）。
    final memberMap = <String, Map<String, dynamic>>{};
    for (final c in cols) {
      final tasks = ((c as Map<String, dynamic>)['tasks'] as List<dynamic>?) ?? [];
      for (final t in tasks) {
        final a = (t as Map<String, dynamic>)['assignee'] as Map<String, dynamic>?;
        if (a != null && a['id'] is String) {
          memberMap[a['id'] as String] = a;
        }
      }
    }
    final members = memberMap.values.toList();

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
                const SizedBox(height: 12),
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
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: priority,
                  decoration: const InputDecoration(labelText: '優先級'),
                  items: const [
                    DropdownMenuItem(value: 'urgent', child: Text('🔴 緊急')),
                    DropdownMenuItem(value: 'high', child: Text('🟠 高')),
                    DropdownMenuItem(value: 'medium', child: Text('🟡 中')),
                    DropdownMenuItem(value: 'low', child: Text('🟢 低')),
                  ],
                  onChanged: (v) => setSt(() => priority = v ?? 'medium'),
                ),
                if (members.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String?>(
                    value: assigneeId,
                    decoration: const InputDecoration(labelText: '負責人（選填）'),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('未指派')),
                      ...members.map((m) => DropdownMenuItem<String?>(
                            value: m['id'] as String,
                            child: Text(m['displayName'] as String? ?? ''),
                          )),
                    ],
                    onChanged: (v) => setSt(() => assigneeId = v),
                  ),
                ],
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  icon: const Icon(Icons.calendar_today, size: 18),
                  label: Text(dueDate != null
                      ? '截止日：${dueDate!.year}/${dueDate!.month.toString().padLeft(2, '0')}/${dueDate!.day.toString().padLeft(2, '0')}'
                      : '設定截止日（選填）'),
                  onPressed: () async {
                    final picked = await showDatePicker(
                      context: ctx,
                      initialDate: dueDate ?? DateTime.now().add(const Duration(days: 7)),
                      firstDate: DateTime.now().subtract(const Duration(days: 365)),
                      lastDate: DateTime.now().add(const Duration(days: 365 * 3)),
                    );
                    if (picked != null) setSt(() => dueDate = picked);
                  },
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
                    'priority': priority,
                    if (assigneeId != null) 'assigneeId': assigneeId,
                    if (dueDate != null) 'dueDate': dueDate!.toIso8601String(),
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

  static Color priorityColor(String? p) {
    switch (p) {
      case 'urgent':
        return const Color(0xFFE53935);
      case 'high':
        return const Color(0xFFFB8C00);
      case 'low':
        return const Color(0xFF9E9E9E);
      case 'medium':
      default:
        return const Color(0xFFFDD835);
    }
  }

  static String _priorityLabel(String? p) {
    return const {
          'urgent': '緊急',
          'high': '高',
          'medium': '中',
          'low': '低',
        }[p] ??
        '中';
  }

  @override
  Widget build(BuildContext context) {
    final priority = task['priority'] as String?;
    final assignee = task['assignee'] as Map<String, dynamic>?;
    final tags = (task['tags'] as List<dynamic>?) ?? [];
    final dueDate = task['dueDate'] != null
        ? DateTime.tryParse(task['dueDate'].toString())
        : null;
    final title = task['title'] as String? ?? '';
    final desc = task['description'] as String?;
    final overdue =
        dueDate != null && dueDate.isBefore(DateTime.now()) && task['completedAt'] == null;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(width: 4, color: priorityColor(priority)),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                      ),
                      if (desc != null && desc.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          desc,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                        ),
                      ],
                      if (tags.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 4,
                          runSpacing: 4,
                          children: tags.take(4).map<Widget>((t) {
                            final tm = t as Map<String, dynamic>;
                            final color = _parseColor(tm['color'] as String?) ??
                                Colors.blueGrey.shade100;
                            return Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: color,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                tm['name'] as String? ?? '',
                                style: const TextStyle(fontSize: 11),
                              ),
                            );
                          }).toList(),
                        ),
                      ],
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: priorityColor(priority).withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: Text(
                              _priorityLabel(priority),
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: priorityColor(priority),
                              ),
                            ),
                          ),
                          const Spacer(),
                          if (dueDate != null) ...[
                            Icon(
                              Icons.event,
                              size: 12,
                              color: overdue ? Colors.red : Colors.grey.shade600,
                            ),
                            const SizedBox(width: 2),
                            Text(
                              '${dueDate.month}/${dueDate.day}',
                              style: TextStyle(
                                fontSize: 11,
                                color: overdue ? Colors.red : Colors.grey.shade600,
                                fontWeight: overdue ? FontWeight.bold : FontWeight.normal,
                              ),
                            ),
                            const SizedBox(width: 6),
                          ],
                          if (assignee != null)
                            CircleAvatar(
                              radius: 10,
                              backgroundImage: (assignee['avatarUrl'] as String?) != null
                                  ? NetworkImage(assignee['avatarUrl'] as String)
                                  : null,
                              child: (assignee['avatarUrl'] as String?) == null
                                  ? Text(
                                      (assignee['displayName'] as String? ?? '?').characters.first,
                                      style: const TextStyle(fontSize: 10),
                                    )
                                  : null,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static Color? _parseColor(String? hex) {
    if (hex == null) return null;
    var s = hex.replaceAll('#', '');
    if (s.length == 6) s = 'FF$s';
    final v = int.tryParse(s, radix: 16);
    return v == null ? null : Color(v);
  }
}
