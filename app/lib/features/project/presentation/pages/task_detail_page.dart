import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../mentions/presentation/widgets/mention_text_field.dart';
import '../../../../shared/widgets/message_body.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/project_provider.dart';

class TaskDetailPage extends ConsumerStatefulWidget {
  final String taskId;
  const TaskDetailPage({super.key, required this.taskId});

  @override
  ConsumerState<TaskDetailPage> createState() => _TaskDetailPageState();
}

class _TaskDetailPageState extends ConsumerState<TaskDetailPage> {
  final _commentController = TextEditingController();
  final _subtaskController = TextEditingController();
  bool _addingSubtask = false;

  @override
  void dispose() {
    _commentController.dispose();
    _subtaskController.dispose();
    super.dispose();
  }

  Future<void> _toggleSubtask(String subtaskId) async {
    try {
      await ref.read(apiClientProvider).toggleSubtask(subtaskId);
      ref.invalidate(taskProvider(widget.taskId));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失敗：$e')));
    }
  }

  Future<void> _pickAndUploadAttachment() async {
    final workspaceId = ref.read(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('請先選擇工作空間')),
      );
      return;
    }
    final result = await FilePicker.platform.pickFiles(withData: true);
    if (result == null || result.files.isEmpty) return;
    final picked = result.files.first;
    final bytes = picked.bytes;
    if (bytes == null) return;

    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('上傳中…'), duration: Duration(seconds: 1)),
    );
    try {
      await ref.read(apiClientProvider).uploadFile(
            workspaceId: workspaceId,
            bytes: bytes,
            fileName: picked.name,
            taskId: widget.taskId,
          );
      if (mounted) ref.invalidate(taskProvider(widget.taskId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('上傳失敗：$e')));
      }
    }
  }

  Future<void> _addSubtask(String title) async {
    if (title.trim().isEmpty) return;
    try {
      await ref.read(apiClientProvider).addSubtaskItem(widget.taskId, title.trim());
      _subtaskController.clear();
      setState(() => _addingSubtask = false);
      ref.invalidate(taskProvider(widget.taskId));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('新增失敗：$e')));
    }
  }

  Future<void> _showEditDialog(Map<String, dynamic> task) async {
    final titleController = TextEditingController(text: task['title'] as String? ?? '');
    final descController = TextEditingController(text: task['description'] as String? ?? '');
    String? priority = task['priority'] as String? ?? 'medium';
    DateTime? dueDate = task['dueDate'] != null ? DateTime.tryParse(task['dueDate'].toString()) : null;

    await showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('編輯任務'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: titleController,
                  decoration: const InputDecoration(labelText: '標題', border: OutlineInputBorder()),
                  autofocus: true,
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: descController,
                  decoration: const InputDecoration(
                    labelText: '描述（選填）',
                    border: OutlineInputBorder(),
                  ),
                  maxLines: 3,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: priority,
                  decoration: const InputDecoration(labelText: '優先級', border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(value: 'urgent', child: Text('🔴 緊急')),
                    DropdownMenuItem(value: 'high', child: Text('🟠 高')),
                    DropdownMenuItem(value: 'medium', child: Text('🟡 中')),
                    DropdownMenuItem(value: 'low', child: Text('🟢 低')),
                  ],
                  onChanged: (v) => setSt(() => priority = v),
                ),
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
                if (title.isEmpty) return;
                Navigator.pop(ctx);
                try {
                  await ref.read(apiClientProvider).updateTask(widget.taskId, {
                    'title': title,
                    'description': descController.text.trim().isEmpty
                        ? null
                        : descController.text.trim(),
                    'priority': priority,
                    if (dueDate != null) 'dueDate': dueDate!.toIso8601String(),
                  });
                  ref.invalidate(taskProvider(widget.taskId));
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context)
                        .showSnackBar(SnackBar(content: Text('更新失敗：$e')));
                  }
                }
              },
              child: const Text('儲存'),
            ),
          ],
        ),
      ),
    );
    titleController.dispose();
    descController.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final taskAsync = ref.watch(taskProvider(widget.taskId));
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('任務詳情'),
        actions: [
          taskAsync.when(
            data: (task) => IconButton(
              icon: const Icon(Icons.edit),
              tooltip: '編輯任務',
              onPressed: () => _showEditDialog(task),
            ),
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
          ),
          IconButton(icon: const Icon(Icons.more_vert), onPressed: () {}),
        ],
      ),
      body: taskAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(message: e.toString()),
        data: (task) {
          final comments = (task['comments'] as List<dynamic>?) ?? [];
          final subtasks = (task['subtasks'] as List<dynamic>?) ?? [];
          final assignee = task['assignee'] as Map<String, dynamic>?;
          final tags = (task['tags'] as List<dynamic>?) ?? [];
          final activities = (task['activities'] as List<dynamic>?) ?? [];

          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Tags
                if (tags.isNotEmpty)
                  Wrap(
                    spacing: 6,
                    children: tags
                        .map<Widget>((t) => Chip(
                              label: Text(t['name'] ?? ''),
                              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ))
                        .toList(),
                  ),
                const SizedBox(height: 8),

                // Title
                Text(
                  task['title'] ?? '',
                  style: theme.textTheme.headlineSmall
                      ?.copyWith(fontWeight: FontWeight.bold),
                ),

                // Description
                if (task['description'] != null &&
                    (task['description'] as String).isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.grey.shade200),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(task['description'],
                        style: theme.textTheme.bodyMedium),
                  ),
                ],
                const SizedBox(height: 16),

                // Info rows
                _buildInfoRow(
                    Icons.person_outline, '負責人', assignee?['displayName'] ?? '未指派'),
                if (task['dueDate'] != null)
                  _buildInfoRow(
                      Icons.calendar_today, '截止日', _formatDate(task['dueDate'])),
                if (task['startDate'] != null)
                  _buildInfoRow(
                      Icons.play_arrow, '開始日', _formatDate(task['startDate'])),
                _buildInfoRow(
                    Icons.flag, '優先級', _priorityLabel(task['priority'])),

                const Divider(height: 32),

                // Subtasks
                Row(
                  children: [
                    Text('子任務 (${subtasks.length})',
                        style: theme.textTheme.titleMedium),
                    const Spacer(),
                    TextButton.icon(
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('新增'),
                      onPressed: () =>
                          setState(() => _addingSubtask = !_addingSubtask),
                    ),
                  ],
                ),
                const SizedBox(height: 8),

                // Add subtask input
                if (_addingSubtask)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _subtaskController,
                            autofocus: true,
                            decoration: const InputDecoration(
                              hintText: '子任務名稱…',
                              border: OutlineInputBorder(),
                              isDense: true,
                              contentPadding: EdgeInsets.symmetric(
                                  horizontal: 12, vertical: 10),
                            ),
                            onSubmitted: _addSubtask,
                          ),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () => _addSubtask(_subtaskController.text),
                          style: FilledButton.styleFrom(
                              minimumSize: const Size(60, 40)),
                          child: const Text('新增'),
                        ),
                        const SizedBox(width: 4),
                        TextButton(
                          onPressed: () {
                            setState(() => _addingSubtask = false);
                            _subtaskController.clear();
                          },
                          child: const Text('取消'),
                        ),
                      ],
                    ),
                  ),

                if (subtasks.isEmpty && !_addingSubtask)
                  const Text('尚無子任務', style: TextStyle(color: Colors.grey)),

                ...subtasks.map((st) {
                  final subtaskId = st['id'] as String?;
                  final completed = st['completed'] as bool? ?? false;
                  return CheckboxListTile(
                    value: completed,
                    title: Text(
                      st['title'] ?? '',
                      style: TextStyle(
                        decoration:
                            completed ? TextDecoration.lineThrough : null,
                        color: completed ? Colors.grey : null,
                      ),
                    ),
                    controlAffinity: ListTileControlAffinity.leading,
                    dense: true,
                    onChanged:
                        subtaskId == null ? null : (_) => _toggleSubtask(subtaskId),
                  );
                }),

                const Divider(height: 32),

                // Attachments
                Row(
                  children: [
                    Text(
                      '附件 (${(task['files'] as List?)?.length ?? 0})',
                      style: theme.textTheme.titleMedium,
                    ),
                    const Spacer(),
                    TextButton.icon(
                      icon: const Icon(Icons.attach_file, size: 18),
                      label: const Text('上傳'),
                      onPressed: _pickAndUploadAttachment,
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                ...((task['files'] as List<dynamic>?) ?? []).map((f) {
                  final file = f as Map<String, dynamic>;
                  final name = file['fileName'] as String? ?? '';
                  final type = file['fileType'] as String? ?? '';
                  final size = file['fileSize'];
                  final isImage = type.startsWith('image/');
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      isImage ? Icons.image_outlined : Icons.insert_drive_file_outlined,
                    ),
                    title: Text(name, overflow: TextOverflow.ellipsis),
                    subtitle: size is int ? Text(_formatBytes(size)) : null,
                  );
                }),
                if ((task['files'] as List?)?.isEmpty ?? true)
                  const Text('尚無附件', style: TextStyle(color: Colors.grey)),

                const Divider(height: 32),

                // Comments
                Text('評論 (${comments.length})',
                    style: theme.textTheme.titleMedium),
                const SizedBox(height: 8),
                if (comments.isEmpty)
                  const Text('尚無評論', style: TextStyle(color: Colors.grey)),
                ...comments.map((c) {
                  final user = c['user'] as Map<String, dynamic>?;
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: UserAvatar(
                        name: user?['displayName'] ?? '?', radius: 16),
                    title: Row(
                      children: [
                        Text(
                          user?['displayName'] ?? '',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          _formatDate(c['createdAt']),
                          style: const TextStyle(
                              fontSize: 12, color: Colors.grey),
                        ),
                      ],
                    ),
                    subtitle: MessageBody(
                      content: (c['content'] as String?) ?? '',
                      baseStyle: const TextStyle(fontSize: 14),
                    ),
                  );
                }),

                // Activity log
                if (activities.isNotEmpty) ...[
                  const Divider(height: 32),
                  Text('活動記錄', style: theme.textTheme.titleMedium),
                  const SizedBox(height: 8),
                  ...activities.take(5).map((a) {
                    final user = a['user'] as Map<String, dynamic>?;
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Row(
                        children: [
                          Icon(Icons.history,
                              size: 16, color: Colors.grey.shade400),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              '${user?['displayName'] ?? '?'} ${_actionLabel(a['action'])}',
                              style: TextStyle(
                                  fontSize: 13, color: Colors.grey.shade700),
                            ),
                          ),
                          Text(
                            _formatDate(a['createdAt']),
                            style: const TextStyle(
                                fontSize: 11, color: Colors.grey),
                          ),
                        ],
                      ),
                    );
                  }),
                ],

                const SizedBox(height: 80),
              ],
            ),
          );
        },
      ),
      bottomNavigationBar: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          border:
              Border(top: BorderSide(color: Colors.grey.shade200)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Builder(builder: (ctx) {
                final wsId = ref.watch(currentWorkspaceIdProvider);
                const decoration = InputDecoration(
                  hintText: '新增評論… 用 @ 提及成員',
                  border: OutlineInputBorder(),
                  isDense: true,
                  contentPadding:
                      EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                );
                Future<void> submit(String v) async {
                  if (v.trim().isEmpty) return;
                  await ref.read(apiClientProvider).addComment(widget.taskId, v.trim());
                  _commentController.clear();
                  ref.invalidate(taskProvider(widget.taskId));
                }
                if (wsId == null) {
                  return TextField(
                    controller: _commentController,
                    decoration: decoration,
                    onSubmitted: submit,
                  );
                }
                return MentionTextField(
                  controller: _commentController,
                  workspaceId: wsId,
                  decoration: decoration,
                  onSubmitted: submit,
                );
              }),
            ),
            const SizedBox(width: 8),
            IconButton(
              icon: const Icon(Icons.send),
              onPressed: () async {
                final text = _commentController.text.trim();
                if (text.isNotEmpty) {
                  await ref
                      .read(apiClientProvider)
                      .addComment(widget.taskId, text);
                  _commentController.clear();
                  ref.invalidate(taskProvider(widget.taskId));
                }
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoRow(IconData icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(icon, size: 18, color: Colors.grey),
          const SizedBox(width: 8),
          Text(label, style: const TextStyle(color: Colors.grey)),
          const SizedBox(width: 8),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }

  String _formatDate(dynamic date) {
    if (date == null) return '';
    final dt = DateTime.tryParse(date.toString());
    if (dt == null) return '';
    return '${dt.year}/${dt.month.toString().padLeft(2, '0')}/${dt.day.toString().padLeft(2, '0')}';
  }

  String _priorityLabel(String? priority) {
    return const {
          'urgent': '🔴 緊急',
          'high': '🟠 高',
          'medium': '🟡 中',
          'low': '🟢 低',
        }[priority] ??
        '🟡 中';
  }

  static String _formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  String _actionLabel(String? action) {
    return const {
          'created': '建立了此任務',
          'updated': '更新了此任務',
          'moved': '移動了此任務',
          'commented': '新增了評論',
        }[action] ??
        (action ?? '進行了操作');
  }
}
