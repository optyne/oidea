import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../providers/project_provider.dart';

enum _ViewMode { board, list, gantt }

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
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';
  _ViewMode _viewMode = _ViewMode.board;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  bool _passesFilter(Map<String, dynamic> task) {
    if (_filterAssigneeIds.isNotEmpty) {
      final aid = (task['assignee'] as Map<String, dynamic>?)?['id'] as String?;
      if (aid == null || !_filterAssigneeIds.contains(aid)) return false;
    }
    if (_filterPriorities.isNotEmpty) {
      final p = task['priority'] as String? ?? 'medium';
      if (!_filterPriorities.contains(p)) return false;
    }
    if (_searchQuery.isNotEmpty) {
      final q = _searchQuery.toLowerCase();
      final title = (task['title'] as String? ?? '').toLowerCase();
      final desc = (task['description'] as String? ?? '').toLowerCase();
      if (!title.contains(q) && !desc.contains(q)) return false;
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
          _ViewModeToggle(
            mode: _viewMode,
            onChanged: (v) => setState(() => _viewMode = v),
          ),
          const SizedBox(width: 8),
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'column') _showAddColumn(context);
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
          final columns = (board['columns'] as List<dynamic>?) ?? const [];
          final assigneeMap = _collectAssignees(columns);
          return Column(
            children: [
              _BoardToolbar(
                searchController: _searchController,
                onSearchChanged: (v) => setState(() => _searchQuery = v.trim()),
                filterPriorities: _filterPriorities,
                filterAssigneeIds: _filterAssigneeIds,
                assignees: assigneeMap.values.toList(),
                onTogglePriority: (p) => setState(() {
                  _filterPriorities.contains(p)
                      ? _filterPriorities.remove(p)
                      : _filterPriorities.add(p);
                }),
                onToggleAssignee: (id) => setState(() {
                  _filterAssigneeIds.contains(id)
                      ? _filterAssigneeIds.remove(id)
                      : _filterAssigneeIds.add(id);
                }),
                onClearFilters: _filterPriorities.isEmpty &&
                        _filterAssigneeIds.isEmpty &&
                        _searchQuery.isEmpty
                    ? null
                    : () => setState(() {
                          _filterPriorities.clear();
                          _filterAssigneeIds.clear();
                          _searchController.clear();
                          _searchQuery = '';
                        }),
              ),
              Expanded(
                child: _buildViewBody(context, columns),
              ),
            ],
          );
        },
      ),
      floatingActionButton: _viewMode == _ViewMode.board
          ? FloatingActionButton(
              onPressed: () => _showAddTask(context),
              child: const Icon(Icons.add),
            )
          : null,
    );
  }

  Widget _buildViewBody(BuildContext context, List<dynamic> columns) {
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

    switch (_viewMode) {
      case _ViewMode.board:
        return _BoardView(
          columns: columns,
          passesFilter: _passesFilter,
          onTaskTap: (taskId) =>
              context.push('/projects/board/${widget.projectId}/task/$taskId'),
          onTaskDropped: _onTaskDropped,
          onAddTaskToColumn: (col) => _showAddTask(context, prefilledColumn: col),
        );
      case _ViewMode.list:
        return _ListView(
          columns: columns,
          passesFilter: _passesFilter,
          onTaskTap: (taskId) =>
              context.push('/projects/board/${widget.projectId}/task/$taskId'),
        );
      case _ViewMode.gantt:
        return _GanttView(
          columns: columns,
          passesFilter: _passesFilter,
          onTaskTap: (taskId) =>
              context.push('/projects/board/${widget.projectId}/task/$taskId'),
        );
    }
  }

  Map<String, Map<String, dynamic>> _collectAssignees(List<dynamic> columns) {
    final out = <String, Map<String, dynamic>>{};
    for (final c in columns) {
      final tasks = ((c as Map<String, dynamic>)['tasks'] as List<dynamic>?) ?? const [];
      for (final t in tasks) {
        final a = (t as Map<String, dynamic>)['assignee'] as Map<String, dynamic>?;
        if (a != null && a['id'] is String) {
          out[a['id'] as String] = a;
        }
      }
    }
    return out;
  }

  Future<void> _onTaskDropped(TaskDragData data, Map<String, dynamic> targetColumn) async {
    final targetId = targetColumn['id'] as String;
    if (data.sourceColumnId == targetId) return;
    final targetTasks = (targetColumn['tasks'] as List<dynamic>?) ?? const [];
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

  Future<void> _showAddTask(BuildContext context, {Map<String, dynamic>? prefilledColumn}) async {
    Map<String, dynamic> board;
    try {
      board = await ref.read(boardProvider(widget.projectId).future);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('無法載入看板：$e')));
      }
      return;
    }
    final cols = (board['columns'] as List<dynamic>?) ?? const [];
    if (cols.isEmpty) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('請先新增至少一個欄位')),
        );
      }
      return;
    }

    final titleController = TextEditingController();
    var columnId = (prefilledColumn?['id'] as String?) ??
        (cols.first as Map<String, dynamic>)['id'] as String?;
    String priority = 'medium';
    String? assigneeId;
    DateTime? dueDate;

    final memberMap = _collectAssignees(cols);
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
                    decoration: const InputDecoration(labelText: '負責人(選填)'),
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
                      : '設定截止日(選填)'),
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

// ─────────────────────────── view mode toggle ───────────────────────────

class _ViewModeToggle extends StatelessWidget {
  final _ViewMode mode;
  final ValueChanged<_ViewMode> onChanged;
  const _ViewModeToggle({required this.mode, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: SegmentedButton<_ViewMode>(
        segments: const [
          ButtonSegment(value: _ViewMode.board, icon: Icon(Icons.view_column_outlined), label: Text('看板')),
          ButtonSegment(value: _ViewMode.list, icon: Icon(Icons.view_list_outlined), label: Text('列表')),
          ButtonSegment(value: _ViewMode.gantt, icon: Icon(Icons.timeline), label: Text('甘特')),
        ],
        selected: {mode},
        showSelectedIcon: false,
        onSelectionChanged: (s) => onChanged(s.first),
        style: const ButtonStyle(visualDensity: VisualDensity.compact),
      ),
    );
  }
}

// ─────────────────────────── toolbar ───────────────────────────

class _BoardToolbar extends StatelessWidget {
  final TextEditingController searchController;
  final ValueChanged<String> onSearchChanged;
  final Set<String> filterPriorities;
  final Set<String> filterAssigneeIds;
  final List<Map<String, dynamic>> assignees;
  final ValueChanged<String> onTogglePriority;
  final ValueChanged<String> onToggleAssignee;
  final VoidCallback? onClearFilters;

  const _BoardToolbar({
    required this.searchController,
    required this.onSearchChanged,
    required this.filterPriorities,
    required this.filterAssigneeIds,
    required this.assignees,
    required this.onTogglePriority,
    required this.onToggleAssignee,
    required this.onClearFilters,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          SizedBox(
            width: 240,
            child: TextField(
              controller: searchController,
              onChanged: onSearchChanged,
              decoration: const InputDecoration(
                hintText: '搜尋任務…',
                prefixIcon: Icon(Icons.search, size: 18),
                isDense: true,
                border: OutlineInputBorder(),
                contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              ),
            ),
          ),
          const SizedBox(width: 12),
          _PriorityDropdown(
            selected: filterPriorities,
            onToggle: onTogglePriority,
          ),
          const SizedBox(width: 8),
          _AssigneeDropdown(
            selected: filterAssigneeIds,
            assignees: assignees,
            onToggle: onToggleAssignee,
          ),
          const Spacer(),
          if (onClearFilters != null)
            TextButton.icon(
              icon: const Icon(Icons.clear, size: 16),
              label: const Text('清除篩選'),
              onPressed: onClearFilters,
            ),
        ],
      ),
    );
  }
}

class _PriorityDropdown extends StatelessWidget {
  final Set<String> selected;
  final ValueChanged<String> onToggle;
  const _PriorityDropdown({required this.selected, required this.onToggle});

  static const _choices = [
    ('urgent', '🔴 緊急'),
    ('high', '🟠 高'),
    ('medium', '🟡 中'),
    ('low', '🟢 低'),
  ];

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: '優先級篩選',
      onSelected: onToggle,
      itemBuilder: (_) => [
        for (final (v, label) in _choices)
          CheckedPopupMenuItem(
            value: v,
            checked: selected.contains(v),
            child: Text(label),
          ),
      ],
      child: _ToolbarChip(
        icon: Icons.flag_outlined,
        label: selected.isEmpty ? '優先級' : '優先級 · ${selected.length}',
        active: selected.isNotEmpty,
      ),
    );
  }
}

class _AssigneeDropdown extends StatelessWidget {
  final Set<String> selected;
  final List<Map<String, dynamic>> assignees;
  final ValueChanged<String> onToggle;
  const _AssigneeDropdown({
    required this.selected,
    required this.assignees,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      tooltip: '成員篩選',
      enabled: assignees.isNotEmpty,
      onSelected: onToggle,
      itemBuilder: (_) => [
        for (final a in assignees)
          CheckedPopupMenuItem(
            value: a['id'] as String,
            checked: selected.contains(a['id']),
            child: Text(a['displayName'] as String? ?? (a['id'] as String? ?? '')),
          ),
      ],
      child: _ToolbarChip(
        icon: Icons.person_outline,
        label: selected.isEmpty ? '成員' : '成員 · ${selected.length}',
        active: selected.isNotEmpty,
      ),
    );
  }
}

class _ToolbarChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;
  const _ToolbarChip({required this.icon, required this.label, required this.active});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: active
            ? theme.colorScheme.primary.withValues(alpha: 0.1)
            : theme.colorScheme.onSurface.withValues(alpha: 0.04),
        border: Border.all(
          color: active ? theme.colorScheme.primary : theme.dividerColor,
          width: active ? 1.2 : 1,
        ),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: active ? theme.colorScheme.primary : null),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: active ? theme.colorScheme.primary : null,
            ),
          ),
          const SizedBox(width: 2),
          Icon(Icons.arrow_drop_down, size: 16, color: active ? theme.colorScheme.primary : null),
        ],
      ),
    );
  }
}

// ─────────────────────────── board view ───────────────────────────

class _BoardView extends StatelessWidget {
  final List<dynamic> columns;
  final bool Function(Map<String, dynamic>) passesFilter;
  final void Function(String taskId) onTaskTap;
  final Future<void> Function(TaskDragData, Map<String, dynamic>) onTaskDropped;
  final void Function(Map<String, dynamic> column) onAddTaskToColumn;

  const _BoardView({
    required this.columns,
    required this.passesFilter,
    required this.onTaskTap,
    required this.onTaskDropped,
    required this.onAddTaskToColumn,
  });

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.all(16),
      itemCount: columns.length,
      itemBuilder: (context, index) {
        final column = columns[index] as Map<String, dynamic>;
        final allTasks = (column['tasks'] as List<dynamic>?) ?? const [];
        final tasks = allTasks
            .where((t) => passesFilter(t as Map<String, dynamic>))
            .toList();
        return SizedBox(
          width: 300,
          child: Card(
            margin: const EdgeInsets.only(right: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _ColumnHeader(
                  column: column,
                  count: tasks.length,
                  totalCount: allTasks.length,
                ),
                Expanded(
                  child: DragTarget<TaskDragData>(
                    onWillAcceptWithDetails: (details) =>
                        details.data.sourceColumnId != (column['id'] as String),
                    onAcceptWithDetails: (details) {
                      onTaskDropped(details.data, column);
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
                        child: Column(
                          children: [
                            Expanded(
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
                                        if (taskId == null) return const SizedBox.shrink();
                                        return LongPressDraggable<TaskDragData>(
                                          data: TaskDragData(
                                            taskId: taskId,
                                            sourceColumnId: columnId,
                                          ),
                                          feedback: Transform.rotate(
                                            angle: 0.035, // ~2°
                                            child: Material(
                                              elevation: 14,
                                              shadowColor: Colors.black54,
                                              borderRadius: BorderRadius.circular(10),
                                              child: SizedBox(
                                                width: 260,
                                                child: TaskCard(task: task, onTap: () {}),
                                              ),
                                            ),
                                          ),
                                          childWhenDragging: Opacity(
                                            opacity: 0.35,
                                            child: TaskCard(task: task, onTap: () {}),
                                          ),
                                          child: TaskCard(
                                            task: task,
                                            onTap: () => onTaskTap(taskId),
                                          ),
                                        );
                                      },
                                    ),
                            ),
                            _AddTaskFooter(
                              onPressed: () => onAddTaskToColumn(column),
                            ),
                          ],
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
  }
}

class _ColumnHeader extends StatelessWidget {
  final Map<String, dynamic> column;
  final int count;
  final int totalCount;
  const _ColumnHeader({required this.column, required this.count, required this.totalCount});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final filtered = count != totalCount;
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: _parseColor(column['color'] as String?) ??
                  theme.colorScheme.primary,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              column['name'] as String? ?? '欄位',
              style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: theme.colorScheme.onSurface.withValues(alpha: 0.06),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              filtered ? '$count / $totalCount' : '$count',
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
            ),
          ),
        ],
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

class _AddTaskFooter extends StatelessWidget {
  final VoidCallback onPressed;
  const _AddTaskFooter({required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 4, 6, 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onPressed,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 6),
          decoration: BoxDecoration(
            border: Border.all(
              color: theme.dividerColor,
              style: BorderStyle.solid, // Flutter doesn't have dashed border built-in; solid light border
              width: 1,
            ),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.add, size: 14, color: theme.colorScheme.onSurface.withValues(alpha: 0.6)),
              const SizedBox(width: 4),
              Text(
                '新增任務',
                style: TextStyle(
                  fontSize: 12,
                  color: theme.colorScheme.onSurface.withValues(alpha: 0.6),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────── task card (with badges) ───────────────────────────

class TaskCard extends StatelessWidget {
  final Map<String, dynamic> task;
  final VoidCallback onTap;

  const TaskCard({super.key, required this.task, required this.onTap});

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

  static String priorityLabel(String? p) {
    return const {
          'urgent': '緊急',
          'high': '高',
          'medium': '中',
          'low': '低',
        }[p] ??
        '中';
  }

  static int _subtaskTotal(Map<String, dynamic> task) {
    final list = task['subtasks'] as List<dynamic>?;
    if (list != null) return list.length;
    final count = task['_count'] is Map ? (task['_count'] as Map)['subtasks'] : null;
    return count is int ? count : 0;
  }

  static int _subtaskDone(Map<String, dynamic> task) {
    final list = task['subtasks'] as List<dynamic>?;
    if (list == null) return 0;
    var n = 0;
    for (final s in list) {
      final m = s as Map<String, dynamic>;
      if (m['completedAt'] != null || m['isDone'] == true) n++;
    }
    return n;
  }

  static int _commentCount(Map<String, dynamic> task) {
    final count = task['_count'] is Map ? (task['_count'] as Map)['comments'] : null;
    if (count is int) return count;
    final list = task['comments'] as List<dynamic>?;
    return list?.length ?? 0;
  }

  static bool _isRecurring(Map<String, dynamic> task) {
    final r = task['recurrence'] as String?;
    return r != null && r != 'none';
  }

  @override
  Widget build(BuildContext context) {
    final priority = task['priority'] as String?;
    final assignee = task['assignee'] as Map<String, dynamic>?;
    final tags = (task['tags'] as List<dynamic>?) ?? const [];
    final dueDate = task['dueDate'] != null
        ? DateTime.tryParse(task['dueDate'].toString())
        : null;
    final title = task['title'] as String? ?? '';
    final desc = task['description'] as String?;
    final overdue =
        dueDate != null && dueDate.isBefore(DateTime.now()) && task['completedAt'] == null;

    final subTotal = _subtaskTotal(task);
    final subDone = _subtaskDone(task);
    final comments = _commentCount(task);
    final recurring = _isRecurring(task);

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
                              priorityLabel(priority),
                              style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: priorityColor(priority),
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          if (recurring)
                            const _CardBadge(icon: Icons.autorenew, label: '週期'),
                          if (subTotal > 0)
                            _CardBadge(
                              icon: Icons.check_box_outlined,
                              label: '$subDone/$subTotal',
                            ),
                          if (comments > 0)
                            _CardBadge(
                              icon: Icons.mode_comment_outlined,
                              label: '$comments',
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

class _CardBadge extends StatelessWidget {
  final IconData icon;
  final String label;
  const _CardBadge({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: Colors.grey.shade600),
          const SizedBox(width: 2),
          Text(label, style: TextStyle(fontSize: 11, color: Colors.grey.shade700)),
        ],
      ),
    );
  }
}

// ─────────────────────────── list view ───────────────────────────

class _ListView extends StatelessWidget {
  final List<dynamic> columns;
  final bool Function(Map<String, dynamic>) passesFilter;
  final void Function(String taskId) onTaskTap;
  const _ListView({
    required this.columns,
    required this.passesFilter,
    required this.onTaskTap,
  });

  @override
  Widget build(BuildContext context) {
    final allRows = <Map<String, dynamic>>[];
    for (final c in columns) {
      final cm = c as Map<String, dynamic>;
      final cname = cm['name'] as String? ?? '';
      final tasks = (cm['tasks'] as List<dynamic>?) ?? const [];
      for (final t in tasks) {
        final tm = t as Map<String, dynamic>;
        if (!passesFilter(tm)) continue;
        allRows.add({...tm, '_columnName': cname});
      }
    }
    if (allRows.isEmpty) {
      return const Center(child: Text('目前無符合條件的任務', style: TextStyle(color: Colors.grey)));
    }
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: ConstrainedBox(
        constraints: BoxConstraints(minWidth: MediaQuery.sizeOf(context).width),
        child: DataTable(
          columns: const [
            DataColumn(label: Text('任務')),
            DataColumn(label: Text('欄位')),
            DataColumn(label: Text('優先級')),
            DataColumn(label: Text('負責人')),
            DataColumn(label: Text('截止日')),
            DataColumn(label: Text('subtask')),
            DataColumn(label: Text('留言')),
          ],
          rows: [
            for (final t in allRows)
              DataRow(
                onSelectChanged: (_) {
                  final id = t['id'] as String?;
                  if (id != null) onTaskTap(id);
                },
                cells: [
                  DataCell(
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 280),
                      child: Text(
                        t['title'] as String? ?? '',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                  DataCell(Text(t['_columnName'] as String? ?? '')),
                  DataCell(Text(TaskCard.priorityLabel(t['priority'] as String?))),
                  DataCell(Text(
                      (t['assignee'] as Map<String, dynamic>?)?['displayName'] as String? ?? '—')),
                  DataCell(Text(_formatDate(t['dueDate']))),
                  DataCell(Text(
                      TaskCard._subtaskTotal(t) == 0
                          ? '—'
                          : '${TaskCard._subtaskDone(t)}/${TaskCard._subtaskTotal(t)}')),
                  DataCell(Text(
                      TaskCard._commentCount(t) == 0 ? '—' : '${TaskCard._commentCount(t)}')),
                ],
              ),
          ],
        ),
      ),
    );
  }

  static String _formatDate(dynamic v) {
    if (v == null) return '—';
    final dt = DateTime.tryParse(v.toString());
    if (dt == null) return '—';
    return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
  }
}

// ─────────────────────────── gantt view ───────────────────────────

class _GanttView extends StatelessWidget {
  final List<dynamic> columns;
  final bool Function(Map<String, dynamic>) passesFilter;
  final void Function(String taskId) onTaskTap;
  const _GanttView({
    required this.columns,
    required this.passesFilter,
    required this.onTaskTap,
  });

  @override
  Widget build(BuildContext context) {
    final tasks = <Map<String, dynamic>>[];
    for (final c in columns) {
      final cm = c as Map<String, dynamic>;
      final list = (cm['tasks'] as List<dynamic>?) ?? const [];
      for (final t in list) {
        final tm = t as Map<String, dynamic>;
        if (!passesFilter(tm)) continue;
        if (tm['dueDate'] != null) tasks.add(tm);
      }
    }
    if (tasks.isEmpty) {
      return const Center(child: Text('需要有截止日才會出現在甘特圖', style: TextStyle(color: Colors.grey)));
    }
    tasks.sort((a, b) {
      final da = DateTime.tryParse(a['dueDate'].toString()) ?? DateTime.now();
      final db = DateTime.tryParse(b['dueDate'].toString()) ?? DateTime.now();
      return da.compareTo(db);
    });

    final now = DateTime.now();
    final earliest = tasks
        .map((t) {
          final c = DateTime.tryParse(t['createdAt']?.toString() ?? '');
          final d = DateTime.tryParse(t['dueDate'].toString());
          return c ?? (d != null ? d.subtract(const Duration(days: 7)) : now);
        })
        .reduce((a, b) => a.isBefore(b) ? a : b);
    final latest = tasks
        .map((t) => DateTime.tryParse(t['dueDate'].toString()) ?? now)
        .reduce((a, b) => a.isAfter(b) ? a : b);
    final totalDays = math.max(1, latest.difference(earliest).inDays + 1);
    const pxPerDay = 18.0;
    final totalWidth = math.max(MediaQuery.sizeOf(context).width, totalDays * pxPerDay + 240);

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SizedBox(
        width: totalWidth.toDouble(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _GanttHeader(earliest: earliest, totalDays: totalDays, pxPerDay: pxPerDay),
            const Divider(height: 1),
            Expanded(
              child: ListView.builder(
                itemCount: tasks.length,
                itemBuilder: (_, i) {
                  final t = tasks[i];
                  final due = DateTime.parse(t['dueDate'].toString());
                  final start = DateTime.tryParse(t['createdAt']?.toString() ?? '') ??
                      due.subtract(const Duration(days: 3));
                  final offsetDays = start.difference(earliest).inDays.clamp(0, totalDays);
                  final durationDays = math.max(1, due.difference(start).inDays + 1);
                  final left = 200.0 + offsetDays * pxPerDay;
                  final barW = durationDays * pxPerDay;
                  final color = TaskCard.priorityColor(t['priority'] as String?);
                  return InkWell(
                    onTap: () {
                      final id = t['id'] as String?;
                      if (id != null) onTaskTap(id);
                    },
                    child: SizedBox(
                      height: 36,
                      child: Stack(
                        children: [
                          Positioned(
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: 200,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                              child: Text(
                                t['title'] as String? ?? '',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                          ),
                          Positioned(
                            left: left,
                            top: 8,
                            width: barW,
                            height: 18,
                            child: Container(
                              decoration: BoxDecoration(
                                color: color.withValues(alpha: 0.8),
                                borderRadius: BorderRadius.circular(4),
                                boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 2)],
                              ),
                              alignment: Alignment.centerLeft,
                              padding: const EdgeInsets.symmetric(horizontal: 6),
                              child: Text(
                                t['title'] as String? ?? '',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontSize: 11, color: Colors.white),
                              ),
                            ),
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
      ),
    );
  }
}

class _GanttHeader extends StatelessWidget {
  final DateTime earliest;
  final int totalDays;
  final double pxPerDay;
  const _GanttHeader({
    required this.earliest,
    required this.totalDays,
    required this.pxPerDay,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 32,
      child: Row(
        children: [
          const SizedBox(width: 200),
          Expanded(
            child: Stack(
              children: [
                for (var i = 0; i < totalDays; i += math.max(1, (totalDays / 10).ceil()))
                  Positioned(
                    left: i * pxPerDay,
                    top: 8,
                    child: Text(
                      _fmt(earliest.add(Duration(days: i))),
                      style: const TextStyle(fontSize: 10, color: Colors.grey),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _fmt(DateTime d) =>
      '${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';
}
