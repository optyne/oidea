import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/erp_providers.dart';

class AttendancePage extends ConsumerStatefulWidget {
  const AttendancePage({super.key});

  @override
  ConsumerState<AttendancePage> createState() => _AttendancePageState();
}

class _AttendancePageState extends ConsumerState<AttendancePage> {
  bool _busy = false;

  Future<void> _action(String kind, String workspaceId) async {
    final noteController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(kind == 'in' ? '上班打卡' : '下班打卡'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              DateFormat('yyyy/MM/dd HH:mm').format(DateTime.now()),
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 18),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: noteController,
              decoration: const InputDecoration(
                labelText: '備註（選填）',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(kind == 'in' ? '上班打卡' : '下班打卡'),
          ),
        ],
      ),
    );
    final note = noteController.text.trim();
    noteController.dispose();
    if (confirmed != true) return;

    setState(() => _busy = true);
    try {
      final api = ref.read(apiClientProvider);
      if (kind == 'in') {
        await api.checkIn(workspaceId, note: note.isEmpty ? null : note);
      } else {
        await api.checkOut(workspaceId, note: note.isEmpty ? null : note);
      }
      if (mounted) {
        ref.invalidate(todayAttendanceProvider(workspaceId));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('打卡失敗：$e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      return const Scaffold(body: Center(child: Text('請先選擇工作空間')));
    }

    final todayAsync = ref.watch(todayAttendanceProvider(workspaceId));
    final now = DateTime.now();
    final monthStart = DateTime(now.year, now.month, 1);
    final rangeKey = AttendanceRangeKey(
      workspaceId,
      DateFormat('yyyy-MM-dd').format(monthStart),
      DateFormat('yyyy-MM-dd').format(now),
    );
    final monthAsync = ref.watch(myAttendanceProvider(rangeKey));

    return Scaffold(
      appBar: AppBar(title: const Text('打卡')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(todayAttendanceProvider(workspaceId));
          ref.invalidate(myAttendanceProvider(rangeKey));
        },
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _TodayCard(
              today: todayAsync.valueOrNull,
              busy: _busy,
              onCheckIn: () => _action('in', workspaceId),
              onCheckOut: () => _action('out', workspaceId),
            ),
            const SizedBox(height: 16),
            Text(
              '本月出勤',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            monthAsync.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(message: e.toString()),
              data: (list) {
                if (list.isEmpty) {
                  return const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: Text('本月尚無打卡紀錄', style: TextStyle(color: Colors.grey))),
                  );
                }
                return Column(
                  children: list.map((e) => _AttendanceRow(record: e as Map<String, dynamic>)).toList(),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _TodayCard extends StatelessWidget {
  final Map<String, dynamic>? today;
  final bool busy;
  final VoidCallback onCheckIn;
  final VoidCallback onCheckOut;

  const _TodayCard({
    required this.today,
    required this.busy,
    required this.onCheckIn,
    required this.onCheckOut,
  });

  String _fmt(dynamic iso) {
    if (iso == null) return '—';
    final dt = DateTime.tryParse(iso.toString())?.toLocal();
    return dt == null ? '—' : DateFormat('HH:mm').format(dt);
  }

  @override
  Widget build(BuildContext context) {
    final checkedIn = today?['checkInAt'] != null;
    final checkedOut = today?['checkOutAt'] != null;
    final workMinutes = today?['workMinutes'] as int? ?? 0;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              DateFormat('yyyy/MM/dd EEE').format(DateTime.now()),
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14, color: Colors.grey),
            ),
            const SizedBox(height: 8),
            Text(
              DateFormat('HH:mm').format(DateTime.now()),
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 42, fontWeight: FontWeight.w300),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: _StatTile(label: '上班', time: _fmt(today?['checkInAt'])),
                ),
                Expanded(
                  child: _StatTile(label: '下班', time: _fmt(today?['checkOutAt'])),
                ),
                Expanded(
                  child: _StatTile(
                    label: '工時',
                    time: workMinutes > 0
                        ? '${(workMinutes / 60).floor()}h ${workMinutes % 60}m'
                        : '—',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: (busy || checkedIn) ? null : onCheckIn,
                    icon: const Icon(Icons.login),
                    label: Text(checkedIn ? '已上班' : '上班打卡'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.tonalIcon(
                    onPressed: (busy || !checkedIn || checkedOut) ? null : onCheckOut,
                    icon: const Icon(Icons.logout),
                    label: Text(checkedOut ? '已下班' : '下班打卡'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  final String label;
  final String time;
  const _StatTile({required this.label, required this.time});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(label, style: const TextStyle(color: Colors.grey, fontSize: 12)),
        const SizedBox(height: 4),
        Text(time, style: const TextStyle(fontWeight: FontWeight.w600)),
      ],
    );
  }
}

class _AttendanceRow extends StatelessWidget {
  final Map<String, dynamic> record;
  const _AttendanceRow({required this.record});

  @override
  Widget build(BuildContext context) {
    final date = DateTime.tryParse(record['date']?.toString() ?? '');
    final inAt = DateTime.tryParse(record['checkInAt']?.toString() ?? '')?.toLocal();
    final outAt = DateTime.tryParse(record['checkOutAt']?.toString() ?? '')?.toLocal();
    final minutes = record['workMinutes'] as int? ?? 0;

    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        radius: 18,
        backgroundColor: Colors.indigo.shade50,
        child: Text(
          date != null ? '${date.day}' : '?',
          style: const TextStyle(color: Colors.indigo, fontWeight: FontWeight.w600),
        ),
      ),
      title: Text(
        date != null ? DateFormat('yyyy/MM/dd').format(date) : '',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        '${inAt != null ? DateFormat('HH:mm').format(inAt) : '—'}'
        ' → ${outAt != null ? DateFormat('HH:mm').format(outAt) : '—'}',
      ),
      trailing: Text(
        minutes > 0 ? '${(minutes / 60).toStringAsFixed(1)}h' : '—',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
    );
  }
}
