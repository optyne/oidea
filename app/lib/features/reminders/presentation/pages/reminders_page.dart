import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../workspace/providers/workspace_provider.dart';

/// 提醒列表 —— 後端的 /reminders 已存在但沒有前端介面。
/// 功能：建立、切換顯示已完成、暫停／恢復／完成／刪除、分成「逾期 / 今日 / 未來」。
class RemindersPage extends ConsumerStatefulWidget {
  const RemindersPage({super.key});

  @override
  ConsumerState<RemindersPage> createState() => _RemindersPageState();
}

class _RemindersPageState extends ConsumerState<RemindersPage> {
  List<Map<String, dynamic>> _items = [];
  bool _loading = false;
  bool _includeCompleted = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _fetch());
  }

  Future<void> _fetch() async {
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) {
      setState(() => _error = '請先選擇工作空間');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final raw = await ref
          .read(apiClientProvider)
          .getReminders(wsId, includeCompleted: _includeCompleted);
      setState(() {
        _items = raw.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = '載入失敗：$e';
        _loading = false;
      });
    }
  }

  // ─── Bucketing by time ───

  /// 回傳 (overdue, today, upcoming)，每個都按 triggerAt 升序。
  ({List<Map<String, dynamic>> overdue, List<Map<String, dynamic>> today, List<Map<String, dynamic>> upcoming, List<Map<String, dynamic>> completed}) _bucket() {
    final now = DateTime.now();
    final today0 = DateTime(now.year, now.month, now.day);
    final tomorrow0 = today0.add(const Duration(days: 1));
    final overdue = <Map<String, dynamic>>[];
    final today = <Map<String, dynamic>>[];
    final upcoming = <Map<String, dynamic>>[];
    final completed = <Map<String, dynamic>>[];
    for (final r in _items) {
      final status = r['status'] as String? ?? 'active';
      if (status == 'completed') {
        completed.add(r);
        continue;
      }
      final when = DateTime.tryParse(r['nextFireAt'] as String? ?? r['triggerAt'] as String? ?? '')?.toLocal();
      if (when == null) {
        upcoming.add(r);
        continue;
      }
      if (when.isBefore(today0)) {
        overdue.add(r);
      } else if (when.isBefore(tomorrow0)) {
        today.add(r);
      } else {
        upcoming.add(r);
      }
    }
    int cmp(Map<String, dynamic> a, Map<String, dynamic> b) {
      final ta = DateTime.tryParse(a['nextFireAt'] as String? ?? '') ?? DateTime(1970);
      final tb = DateTime.tryParse(b['nextFireAt'] as String? ?? '') ?? DateTime(1970);
      return ta.compareTo(tb);
    }
    overdue.sort(cmp);
    today.sort(cmp);
    upcoming.sort(cmp);
    completed.sort((a, b) => cmp(b, a)); // completed 倒序
    return (overdue: overdue, today: today, upcoming: upcoming, completed: completed);
  }

  // ─── Actions ───

  Future<void> _create() async {
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) return;
    final result = await showDialog<_NewReminderResult>(
      context: context,
      builder: (_) => const _NewReminderDialog(),
    );
    if (result == null) return;
    try {
      await ref.read(apiClientProvider).createReminder(
            workspaceId: wsId,
            title: result.title,
            triggerAt: result.triggerAt,
            notes: result.notes,
            recurrence: result.recurrence,
            recurrenceInterval: result.recurrenceInterval,
          );
      _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
      }
    }
  }

  Future<void> _complete(String id) async {
    try {
      await ref.read(apiClientProvider).completeReminder(id);
      _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失敗：$e')));
      }
    }
  }

  Future<void> _togglePauseResume(Map<String, dynamic> r) async {
    final id = r['id'] as String;
    final paused = (r['status'] as String?) == 'paused';
    try {
      if (paused) {
        await ref.read(apiClientProvider).resumeReminder(id);
      } else {
        await ref.read(apiClientProvider).pauseReminder(id);
      }
      _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失敗：$e')));
      }
    }
  }

  Future<void> _delete(Map<String, dynamic> r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('刪除提醒'),
        content: Text('確定刪除「${r['title']}」？'),
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
    if (ok != true) return;
    try {
      await ref.read(apiClientProvider).deleteReminder(r['id'] as String);
      _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失敗：$e')));
      }
    }
  }

  // ─── UI ───

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('提醒'),
        actions: [
          FilterChip(
            label: const Text('顯示已完成', style: TextStyle(fontSize: 12)),
            selected: _includeCompleted,
            onSelected: (v) {
              setState(() => _includeCompleted = v);
              _fetch();
            },
          ),
          const SizedBox(width: 8),
          IconButton(
            tooltip: '重新載入',
            icon: const Icon(Icons.refresh),
            onPressed: _fetch,
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: Colors.red)))
              : _items.isEmpty
                  ? _empty()
                  : _buildList(),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.add_alert_outlined),
        label: const Text('新增提醒'),
      ),
    );
  }

  Widget _empty() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.notifications_off_outlined, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 12),
          Text('沒有提醒', style: TextStyle(color: Colors.grey.shade600, fontSize: 15)),
          const SizedBox(height: 8),
          TextButton.icon(
            icon: const Icon(Icons.add_alert_outlined),
            label: const Text('建立第一個提醒'),
            onPressed: _create,
          ),
        ],
      ),
    );
  }

  Widget _buildList() {
    final buckets = _bucket();
    return RefreshIndicator(
      onRefresh: _fetch,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
        children: [
          if (buckets.overdue.isNotEmpty) ...[
            _sectionHeader('逾期', buckets.overdue.length, color: Colors.red.shade700),
            for (final r in buckets.overdue) _reminderTile(r, overdue: true),
            const SizedBox(height: 12),
          ],
          if (buckets.today.isNotEmpty) ...[
            _sectionHeader('今天', buckets.today.length, color: Colors.orange.shade700),
            for (final r in buckets.today) _reminderTile(r),
            const SizedBox(height: 12),
          ],
          if (buckets.upcoming.isNotEmpty) ...[
            _sectionHeader('未來', buckets.upcoming.length),
            for (final r in buckets.upcoming) _reminderTile(r),
            const SizedBox(height: 12),
          ],
          if (_includeCompleted && buckets.completed.isNotEmpty) ...[
            _sectionHeader('已完成', buckets.completed.length, color: Colors.grey.shade600),
            for (final r in buckets.completed) _reminderTile(r, completed: true),
          ],
        ],
      ),
    );
  }

  Widget _sectionHeader(String label, int n, {Color? color}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
      child: Row(
        children: [
          Text(label,
              style: TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 13,
                color: color ?? Colors.grey.shade800,
              )),
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              color: (color ?? Colors.grey).withOpacity(0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text('$n',
                style: TextStyle(fontSize: 11, color: color ?? Colors.grey.shade700)),
          ),
        ],
      ),
    );
  }

  Widget _reminderTile(Map<String, dynamic> r, {bool overdue = false, bool completed = false}) {
    final status = r['status'] as String? ?? 'active';
    final paused = status == 'paused';
    final when = DateTime.tryParse(r['nextFireAt'] as String? ?? '')?.toLocal();
    final recurrence = r['recurrence'] as String? ?? 'none';
    final recurInterval = (r['recurrenceInterval'] as num?)?.toInt() ?? 1;
    final title = (r['title'] as String?) ?? '';
    final notes = r['notes'] as String?;

    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ListTile(
        leading: Checkbox(
          value: completed,
          onChanged: completed ? null : (_) => _complete(r['id'] as String),
        ),
        title: Text(
          title,
          style: TextStyle(
            fontWeight: FontWeight.w500,
            decoration: completed ? TextDecoration.lineThrough : null,
            color: completed ? Colors.grey : (overdue ? Colors.red.shade700 : null),
          ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Icon(
                  paused ? Icons.pause_circle_outline : Icons.schedule,
                  size: 14,
                  color: overdue ? Colors.red.shade600 : Colors.grey.shade600,
                ),
                const SizedBox(width: 4),
                Text(
                  when != null ? _formatWhen(when) : '未設定時間',
                  style: TextStyle(
                    fontSize: 12,
                    color: overdue ? Colors.red.shade600 : Colors.grey.shade600,
                  ),
                ),
                if (recurrence != 'none') ...[
                  const SizedBox(width: 8),
                  Icon(Icons.repeat, size: 12, color: Colors.grey.shade600),
                  const SizedBox(width: 2),
                  Text(
                    _formatRecurrence(recurrence, recurInterval),
                    style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                  ),
                ],
                if (paused) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                    decoration: BoxDecoration(
                      color: Colors.orange.shade100,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text('已暫停', style: TextStyle(fontSize: 10, color: Colors.orange.shade800)),
                  ),
                ],
              ],
            ),
            if (notes != null && notes.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(notes,
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis),
              ),
          ],
        ),
        trailing: PopupMenuButton<String>(
          onSelected: (v) {
            switch (v) {
              case 'pause_resume':
                _togglePauseResume(r);
                break;
              case 'complete':
                _complete(r['id'] as String);
                break;
              case 'delete':
                _delete(r);
                break;
            }
          },
          itemBuilder: (_) => [
            if (!completed)
              PopupMenuItem(value: 'pause_resume', child: Text(paused ? '恢復' : '暫停')),
            if (!completed) const PopupMenuItem(value: 'complete', child: Text('完成')),
            const PopupMenuItem(
              value: 'delete',
              child: Text('刪除', style: TextStyle(color: Colors.red)),
            ),
          ],
        ),
      ),
    );
  }

  String _formatWhen(DateTime when) {
    final y = when.year.toString().padLeft(4, '0');
    final m = when.month.toString().padLeft(2, '0');
    final d = when.day.toString().padLeft(2, '0');
    final h = when.hour.toString().padLeft(2, '0');
    final min = when.minute.toString().padLeft(2, '0');
    return '$y-$m-$d $h:$min';
  }

  String _formatRecurrence(String rule, int interval) {
    final unit = switch (rule) {
      'daily' => '日',
      'weekly' => '週',
      'monthly' => '月',
      'yearly' => '年',
      _ => rule,
    };
    return interval == 1 ? '每$unit' : '每 $interval $unit';
  }
}

class _NewReminderResult {
  final String title;
  final String? notes;
  final DateTime triggerAt;
  final String recurrence;
  final int recurrenceInterval;
  _NewReminderResult({
    required this.title,
    required this.triggerAt,
    this.notes,
    required this.recurrence,
    required this.recurrenceInterval,
  });
}

class _NewReminderDialog extends StatefulWidget {
  const _NewReminderDialog();

  @override
  State<_NewReminderDialog> createState() => _NewReminderDialogState();
}

class _NewReminderDialogState extends State<_NewReminderDialog> {
  final _titleCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  late DateTime _when;
  String _recurrence = 'none';
  int _interval = 1;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    // 預設明天 9:00
    final tomorrow = DateTime(now.year, now.month, now.day + 1, 9);
    _when = tomorrow;
  }

  @override
  void dispose() {
    _titleCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDateTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _when,
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 365 * 5)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_when),
    );
    if (time == null) return;
    setState(() {
      _when = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    });
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新增提醒'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _titleCtrl,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: '標題 *',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _notesCtrl,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: '備註（可選）',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            InkWell(
              onTap: _pickDateTime,
              child: InputDecorator(
                decoration: const InputDecoration(
                  labelText: '觸發時間',
                  border: OutlineInputBorder(),
                  prefixIcon: Icon(Icons.schedule, size: 18),
                ),
                child: Text(
                  '${_when.year}-${_when.month.toString().padLeft(2, '0')}-${_when.day.toString().padLeft(2, '0')} '
                  '${_when.hour.toString().padLeft(2, '0')}:${_when.minute.toString().padLeft(2, '0')}',
                ),
              ),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _recurrence,
              decoration: const InputDecoration(
                labelText: '重複',
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'none', child: Text('不重複')),
                DropdownMenuItem(value: 'daily', child: Text('每日')),
                DropdownMenuItem(value: 'weekly', child: Text('每週')),
                DropdownMenuItem(value: 'monthly', child: Text('每月')),
                DropdownMenuItem(value: 'yearly', child: Text('每年')),
              ],
              onChanged: (v) => setState(() => _recurrence = v ?? 'none'),
            ),
            if (_recurrence != 'none') ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  const Text('間隔：'),
                  const SizedBox(width: 8),
                  DropdownButton<int>(
                    value: _interval,
                    items: [1, 2, 3, 4, 6, 12]
                        .map((i) => DropdownMenuItem(value: i, child: Text('$i')))
                        .toList(),
                    onChanged: (v) => setState(() => _interval = v ?? 1),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: () {
            final t = _titleCtrl.text.trim();
            if (t.isEmpty) return;
            Navigator.pop(
              context,
              _NewReminderResult(
                title: t,
                notes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
                triggerAt: _when,
                recurrence: _recurrence,
                recurrenceInterval: _interval,
              ),
            );
          },
          child: const Text('建立'),
        ),
      ],
    );
  }
}
