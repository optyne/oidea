import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:table_calendar/table_calendar.dart';
import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/meeting_provider.dart';

class MeetingHomePage extends ConsumerStatefulWidget {
  const MeetingHomePage({super.key});

  @override
  ConsumerState<MeetingHomePage> createState() => _MeetingHomePageState();
}

class _MeetingHomePageState extends ConsumerState<MeetingHomePage> {
  CalendarFormat _calendarFormat = CalendarFormat.month;
  DateTime _focusedDay = DateTime.now();
  DateTime? _selectedDay;

  @override
  Widget build(BuildContext context) {
    final workspacesAsync = ref.watch(workspacesProvider);
    final workspaceId = ref.watch(currentWorkspaceIdProvider);

    if (workspacesAsync.isLoading) {
      return Scaffold(
        appBar: AppBar(title: const Text('會議')),
        body: const LoadingWidget(),
      );
    }
    final list = workspacesAsync.value ?? [];
    if (list.isNotEmpty && workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('會議')),
        body: const LoadingWidget(),
      );
    }
    if (workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('會議')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('請在頂端建立或選擇工作空間', textAlign: TextAlign.center),
          ),
        ),
      );
    }

    final meetingsAsync = ref.watch(meetingsProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('會議'),
        actions: [
          IconButton(icon: const Icon(Icons.search), onPressed: () {}),
        ],
      ),
      body: Column(
        children: [
          TableCalendar(
            firstDay: DateTime.utc(2024, 1, 1),
            lastDay: DateTime.utc(2027, 12, 31),
            focusedDay: _focusedDay,
            calendarFormat: _calendarFormat,
            selectedDayPredicate: (day) => isSameDay(_selectedDay, day),
            onDaySelected: (selectedDay, focusedDay) {
              setState(() {
                _selectedDay = selectedDay;
                _focusedDay = focusedDay;
              });
            },
            onFormatChanged: (format) => setState(() => _calendarFormat = format),
            onPageChanged: (focusedDay) => _focusedDay = focusedDay,
            calendarStyle: const CalendarStyle(
              todayDecoration: BoxDecoration(color: Color(0xFF4F46E5), shape: BoxShape.circle),
              selectedDecoration: BoxDecoration(color: Color(0xFF7C3AED), shape: BoxShape.circle),
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: meetingsAsync.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(message: e.toString()),
              data: (meetings) {
                final filtered = _selectedDay != null
                    ? meetings.where((m) {
                        final start = DateTime.tryParse(m['startTime'] ?? '');
                        return start != null && isSameDay(start, _selectedDay);
                      }).toList()
                    : meetings;

                if (filtered.isEmpty) {
                  return const EmptyStateWidget(
                    icon: Icons.videocam_outlined,
                    title: '尚無會議',
                    subtitle: '排程第一個會議',
                  );
                }

                return ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: filtered.length,
                  itemBuilder: (context, index) {
                    final meeting = filtered[index] as Map<String, dynamic>;
                    final startTime = DateTime.tryParse(meeting['startTime'] ?? '') ?? DateTime.now();
                    final endTime = DateTime.tryParse(meeting['endTime'] ?? '') ?? DateTime.now();
                    final status = meeting['status'] as String? ?? 'scheduled';

                    return Card(
                      margin: const EdgeInsets.only(bottom: 12),
                      child: InkWell(
                        onTap: () => context.go('/meetings/room/${meeting['id']}'),
                        borderRadius: BorderRadius.circular(12),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Row(
                            children: [
                              Container(
                                width: 4,
                                height: 50,
                                decoration: BoxDecoration(
                                  color: status == 'ongoing' ? Colors.green : (status == 'completed' ? Colors.grey : const Color(0xFF4F46E5)),
                                  borderRadius: BorderRadius.circular(2),
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(meeting['title'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                                    const SizedBox(height: 4),
                                    Text(
                                      '${_formatTime(startTime)} - ${_formatTime(endTime)}',
                                      style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                                    ),
                                    Text(
                                      '${meeting['_count']?['participants'] ?? 0} 位參與者',
                                      style: TextStyle(color: Colors.grey.shade500, fontSize: 12),
                                    ),
                                  ],
                                ),
                              ),
                              if (status == 'ongoing')
                                FilledButton(
                                  onPressed: () => context.go('/meetings/room/${meeting['id']}'),
                                  child: const Text('加入'),
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
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showCreateMeeting(context, workspaceId),
        child: const Icon(Icons.add),
      ),
    );
  }

  void _showCreateMeeting(BuildContext context, String workspaceId) {
    final titleController = TextEditingController();
    final descController = TextEditingController();
    DateTime startTime = DateTime.now().add(const Duration(hours: 1));
    DateTime endTime = startTime.add(const Duration(hours: 1));

    showDialog(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('排程會議'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: titleController,
                  autofocus: true,
                  decoration: const InputDecoration(
                    labelText: '會議標題 *',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: descController,
                  decoration: const InputDecoration(
                    labelText: '描述（選填）',
                    border: OutlineInputBorder(),
                  ),
                  maxLines: 2,
                ),
                const SizedBox(height: 16),
                // Start time
                const Text('開始時間', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                const SizedBox(height: 6),
                OutlinedButton.icon(
                  icon: const Icon(Icons.calendar_today, size: 18),
                  label: Text(_formatDateTime(startTime)),
                  onPressed: () async {
                    final date = await showDatePicker(
                      context: ctx,
                      initialDate: startTime,
                      firstDate: DateTime.now().subtract(const Duration(days: 1)),
                      lastDate: DateTime.now().add(const Duration(days: 365)),
                    );
                    if (date == null) return;
                    final time = await showTimePicker(
                      context: ctx,
                      initialTime: TimeOfDay.fromDateTime(startTime),
                    );
                    if (time == null) return;
                    setSt(() {
                      startTime = DateTime(date.year, date.month, date.day, time.hour, time.minute);
                      if (endTime.isBefore(startTime)) {
                        endTime = startTime.add(const Duration(hours: 1));
                      }
                    });
                  },
                ),
                const SizedBox(height: 12),
                // End time
                const Text('結束時間', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                const SizedBox(height: 6),
                OutlinedButton.icon(
                  icon: const Icon(Icons.access_time, size: 18),
                  label: Text(_formatDateTime(endTime)),
                  onPressed: () async {
                    final date = await showDatePicker(
                      context: ctx,
                      initialDate: endTime,
                      firstDate: startTime,
                      lastDate: startTime.add(const Duration(days: 365)),
                    );
                    if (date == null) return;
                    final time = await showTimePicker(
                      context: ctx,
                      initialTime: TimeOfDay.fromDateTime(endTime),
                    );
                    if (time == null) return;
                    setSt(() => endTime = DateTime(date.year, date.month, date.day, time.hour, time.minute));
                  },
                ),
                const SizedBox(height: 8),
                // Duration hint
                Text(
                  '時長：${_durationLabel(endTime.difference(startTime))}',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
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
                if (endTime.isBefore(startTime) || endTime == startTime) {
                  ScaffoldMessenger.of(ctx).showSnackBar(const SnackBar(content: Text('結束時間必須晚於開始時間')));
                  return;
                }
                Navigator.pop(ctx);
                try {
                  final api = ref.read(apiClientProvider);
                  await api.createMeeting({
                    'workspaceId': workspaceId,
                    'title': title,
                    if (descController.text.trim().isNotEmpty) 'description': descController.text.trim(),
                    'startTime': startTime.toIso8601String(),
                    'endTime': endTime.toIso8601String(),
                  });
                  ref.invalidate(meetingsProvider(workspaceId));
                } catch (e) {
                  if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
                }
              },
              child: const Text('建立'),
            ),
          ],
        ),
      ),
    );
    titleController.dispose();
    descController.dispose();
  }

  String _formatDateTime(DateTime dt) {
    final weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    return '${dt.month}/${dt.day}（${weekdays[dt.weekday - 1]}）'
        ' ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  String _durationLabel(Duration d) {
    if (d.isNegative) return '無效';
    final h = d.inHours;
    final m = d.inMinutes % 60;
    if (h == 0) return '$m 分鐘';
    if (m == 0) return '$h 小時';
    return '$h 小時 $m 分鐘';
  }

  String _formatTime(DateTime dt) => '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
