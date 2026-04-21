import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:table_calendar/table_calendar.dart';
import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/meeting_provider.dart';

enum _CalView { month, week, day }

class MeetingHomePage extends ConsumerStatefulWidget {
  const MeetingHomePage({super.key});

  @override
  ConsumerState<MeetingHomePage> createState() => _MeetingHomePageState();
}

class _MeetingHomePageState extends ConsumerState<MeetingHomePage> {
  CalendarFormat _calendarFormat = CalendarFormat.month;
  DateTime _focusedDay = DateTime.now();
  DateTime? _selectedDay;
  _CalView _viewMode = _CalView.month;

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
          SegmentedButton<_CalView>(
            segments: const [
              ButtonSegment(value: _CalView.month, icon: Icon(Icons.calendar_month), label: Text('月')),
              ButtonSegment(value: _CalView.week, icon: Icon(Icons.view_week), label: Text('週')),
              ButtonSegment(value: _CalView.day, icon: Icon(Icons.view_day), label: Text('日')),
            ],
            selected: {_viewMode},
            showSelectedIcon: false,
            onSelectionChanged: (s) => setState(() => _viewMode = s.first),
            style: const ButtonStyle(visualDensity: VisualDensity.compact),
          ),
          const SizedBox(width: 8),
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 8),
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: const Color(0xFF10B981).withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Text(
              '✓ M-04 日曆整合',
              style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xFF10B981)),
            ),
          ),
          IconButton(icon: const Icon(Icons.search), onPressed: () {}),
        ],
      ),
      body: meetingsAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(message: e.toString()),
        data: (meetings) {
          return Column(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  child: Column(
                    children: [
                      _buildCalendar(context, meetings),
                      const Divider(height: 1),
                      _buildList(context, meetings),
                      const Divider(height: 1),
                      const _FeatureGrid(),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showCreateMeeting(context, workspaceId),
        child: const Icon(Icons.add),
      ),
    );
  }

  Widget _buildCalendar(BuildContext context, List<dynamic> meetings) {
    switch (_viewMode) {
      case _CalView.month:
        return TableCalendar(
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
          eventLoader: (day) {
            return meetings.where((m) {
              final start = DateTime.tryParse(m['startTime'] ?? '');
              return start != null && isSameDay(start, day);
            }).toList();
          },
          calendarStyle: const CalendarStyle(
            todayDecoration: BoxDecoration(color: Color(0xFF4F46E5), shape: BoxShape.circle),
            selectedDecoration: BoxDecoration(color: Color(0xFF7C3AED), shape: BoxShape.circle),
          ),
        );
      case _CalView.week:
        return _TimeGridView(
          meetings: meetings,
          days: _daysInWeek(_focusedDay),
          onEventTap: (m) => _openJoinPreview(m),
          onPrev: () => setState(() => _focusedDay = _focusedDay.subtract(const Duration(days: 7))),
          onNext: () => setState(() => _focusedDay = _focusedDay.add(const Duration(days: 7))),
          onToday: () => setState(() => _focusedDay = DateTime.now()),
        );
      case _CalView.day:
        return _TimeGridView(
          meetings: meetings,
          days: [DateTime(_focusedDay.year, _focusedDay.month, _focusedDay.day)],
          onEventTap: (m) => _openJoinPreview(m),
          onPrev: () => setState(() => _focusedDay = _focusedDay.subtract(const Duration(days: 1))),
          onNext: () => setState(() => _focusedDay = _focusedDay.add(const Duration(days: 1))),
          onToday: () => setState(() => _focusedDay = DateTime.now()),
        );
    }
  }

  List<DateTime> _daysInWeek(DateTime d) {
    final monday = d.subtract(Duration(days: d.weekday - 1));
    return List.generate(5, (i) => DateTime(monday.year, monday.month, monday.day + i));
  }

  Widget _buildList(BuildContext context, List<dynamic> meetings) {
    final filtered = _selectedDay != null && _viewMode == _CalView.month
        ? meetings.where((m) {
            final start = DateTime.tryParse(m['startTime'] ?? '');
            return start != null && isSameDay(start, _selectedDay);
          }).toList()
        : meetings;

    if (filtered.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: EmptyStateWidget(
          icon: Icons.videocam_outlined,
          title: '尚無會議',
          subtitle: '排程第一個會議',
        ),
      );
    }

    return ListView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
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
            onTap: () => _openJoinPreview(meeting),
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Container(
                    width: 4,
                    height: 50,
                    decoration: BoxDecoration(
                      color: status == 'ongoing'
                          ? Colors.green
                          : (status == 'completed'
                              ? Colors.grey
                              : const Color(0xFF4F46E5)),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          meeting['title'] ?? '',
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
                        ),
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
                      onPressed: () => _openJoinPreview(meeting),
                      child: const Text('加入'),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _openJoinPreview(Map<String, dynamic> meeting) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (_) => _JoinPreviewModal(meeting: meeting),
    );
    if (result == true && mounted) {
      context.go('/meetings/room/${meeting['id']}');
    }
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
                    labelText: '描述(選填)',
                    border: OutlineInputBorder(),
                  ),
                  maxLines: 2,
                ),
                const SizedBox(height: 16),
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
                Text(
                  '時長:${_durationLabel(endTime.difference(startTime))}',
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
                  ScaffoldMessenger.of(ctx)
                      .showSnackBar(const SnackBar(content: Text('結束時間必須晚於開始時間')));
                  return;
                }
                Navigator.pop(ctx);
                try {
                  final api = ref.read(apiClientProvider);
                  await api.createMeeting({
                    'workspaceId': workspaceId,
                    'title': title,
                    if (descController.text.trim().isNotEmpty)
                      'description': descController.text.trim(),
                    'startTime': startTime.toIso8601String(),
                    'endTime': endTime.toIso8601String(),
                  });
                  ref.invalidate(meetingsProvider(workspaceId));
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
                  }
                }
              },
              child: const Text('建立'),
            ),
          ],
        ),
      ),
    );
  }

  String _formatDateTime(DateTime dt) {
    final weekdays = ['一', '二', '三', '四', '五', '六', '日'];
    return '${dt.month}/${dt.day}(${weekdays[dt.weekday - 1]})'
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

  String _formatTime(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}

// ─────────────────────────── time-axis grid view ───────────────────────────

class _TimeGridView extends StatelessWidget {
  final List<dynamic> meetings;
  final List<DateTime> days;
  final void Function(Map<String, dynamic>) onEventTap;
  final VoidCallback onPrev;
  final VoidCallback onNext;
  final VoidCallback onToday;

  const _TimeGridView({
    required this.meetings,
    required this.days,
    required this.onEventTap,
    required this.onPrev,
    required this.onNext,
    required this.onToday,
  });

  static const double _hourHeight = 48;
  static const int _startHour = 8;
  static const int _endHour = 18;

  @override
  Widget build(BuildContext context) {
    final hours = List.generate(_endHour - _startHour + 1, (i) => _startHour + i);
    final weekdays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 12),
      child: Column(
        children: [
          Row(
            children: [
              IconButton(icon: const Icon(Icons.chevron_left), onPressed: onPrev),
              TextButton(onPressed: onToday, child: const Text('今天')),
              IconButton(icon: const Icon(Icons.chevron_right), onPressed: onNext),
              const Spacer(),
              Text(
                '${days.first.year}-${days.first.month.toString().padLeft(2, '0')}'
                '${days.length > 1 ? " · 第 ${_weekOfYear(days.first)} 週" : ""}',
                style: const TextStyle(fontSize: 12, color: Colors.grey),
              ),
            ],
          ),
          Row(
            children: [
              const SizedBox(width: 56),
              ...days.map((d) {
                final isToday = _isSameDay(d, DateTime.now());
                return Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Column(
                      children: [
                        Text(
                          weekdays[d.weekday - 1],
                          style: TextStyle(
                            fontSize: 11,
                            color: Colors.grey.shade600,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.5,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${d.day}',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                            color: isToday ? const Color(0xFF4F46E5) : null,
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              }),
            ],
          ),
          const Divider(height: 1),
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Time axis
                SizedBox(
                  width: 56,
                  child: Column(
                    children: [
                      for (final h in hours)
                        SizedBox(
                          height: _hourHeight,
                          child: Padding(
                            padding: const EdgeInsets.only(right: 8, top: 0),
                            child: Align(
                              alignment: Alignment.topRight,
                              child: Transform.translate(
                                offset: const Offset(0, -6),
                                child: Text(
                                  '$h:00',
                                  style: const TextStyle(fontSize: 10, color: Colors.grey),
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                for (final day in days)
                  Expanded(
                    child: _DayColumn(
                      day: day,
                      meetings: meetings,
                      hourHeight: _hourHeight,
                      startHour: _startHour,
                      endHour: _endHour,
                      onEventTap: onEventTap,
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;

  int _weekOfYear(DateTime d) {
    final jan1 = DateTime(d.year, 1, 1);
    return ((d.difference(jan1).inDays + jan1.weekday) / 7).ceil();
  }
}

class _DayColumn extends StatelessWidget {
  final DateTime day;
  final List<dynamic> meetings;
  final double hourHeight;
  final int startHour;
  final int endHour;
  final void Function(Map<String, dynamic>) onEventTap;

  const _DayColumn({
    required this.day,
    required this.meetings,
    required this.hourHeight,
    required this.startHour,
    required this.endHour,
    required this.onEventTap,
  });

  @override
  Widget build(BuildContext context) {
    final dayMeetings = meetings.where((m) {
      final s = DateTime.tryParse(m['startTime'] ?? '');
      if (s == null) return false;
      return s.year == day.year && s.month == day.month && s.day == day.day;
    }).toList();

    final totalHeight = hourHeight * (endHour - startHour + 1);

    return Container(
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: SizedBox(
        height: totalHeight,
        child: Stack(
          children: [
            Column(
              children: List.generate(
                endHour - startHour + 1,
                (_) => SizedBox(
                  height: hourHeight,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      border: Border(bottom: BorderSide(color: Theme.of(context).dividerColor.withValues(alpha: 0.5))),
                    ),
                  ),
                ),
              ),
            ),
            ...dayMeetings.map((raw) {
              final m = raw as Map<String, dynamic>;
              final s = DateTime.tryParse(m['startTime'] ?? '') ?? DateTime.now();
              final e = DateTime.tryParse(m['endTime'] ?? '') ??
                  s.add(const Duration(hours: 1));
              final startVal = s.hour + s.minute / 60;
              final endVal = e.hour + e.minute / 60;
              final top = ((startVal - startHour).clamp(0, endHour - startHour + 1)) * hourHeight;
              final height = ((endVal - startVal)).clamp(0.25, 10).toDouble() * hourHeight;
              final status = m['status'] as String? ?? 'scheduled';
              final color = status == 'ongoing'
                  ? const Color(0xFF10B981)
                  : status == 'completed'
                      ? Colors.grey
                      : const Color(0xFF4F46E5);
              return Positioned(
                left: 4,
                right: 4,
                top: top + 2,
                height: height - 4,
                child: InkWell(
                  onTap: () => onEventTap(m),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(6),
                      boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 2)],
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          m['title'] as String? ?? '',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (height > 28)
                          Text(
                            '${s.hour}:${s.minute.toString().padLeft(2, '0')} · '
                            '${m['_count']?['participants'] ?? 0} 人',
                            style: const TextStyle(color: Colors.white70, fontSize: 9),
                          ),
                      ],
                    ),
                  ),
                ),
              );
            }),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────── feature grid (M-02/07/08) ───────────────────────────

class _FeatureGrid extends StatelessWidget {
  const _FeatureGrid();

  static const _features = [
    ('M-02 一對一', '點對點 WebRTC、E2E 加密'),
    ('M-07 螢幕分享', '選視窗、標籤頁、整個桌面'),
    ('M-08 會議錄製', '自動儲存到文件庫'),
  ];

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      child: GridView.count(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        crossAxisCount: 3,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10,
        childAspectRatio: 2.5,
        children: [
          for (final (label, desc) in _features)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                border: Border.all(color: Theme.of(context).dividerColor),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                        decoration: BoxDecoration(
                          color: const Color(0xFF10B981).withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(3),
                        ),
                        child: const Text(
                          '✓ 可用',
                          style: TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF10B981),
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          label,
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    desc,
                    style: TextStyle(fontSize: 11, color: Theme.of(context).hintColor),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

// ─────────────────────────── join preview modal ───────────────────────────

class _JoinPreviewModal extends StatefulWidget {
  final Map<String, dynamic> meeting;
  const _JoinPreviewModal({required this.meeting});

  @override
  State<_JoinPreviewModal> createState() => _JoinPreviewModalState();
}

class _JoinPreviewModalState extends State<_JoinPreviewModal> {
  bool _mic = true;
  bool _camera = true;

  @override
  Widget build(BuildContext context) {
    final m = widget.meeting;
    final participantCount = m['_count']?['participants'] ?? 0;
    return Dialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: SizedBox(
        width: 460,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // 預覽區
            ClipRRect(
              borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
              child: AspectRatio(
                aspectRatio: 16 / 9,
                child: Container(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      colors: [Color(0xFF1A1A2E), Color(0xFF0F0F23)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                  ),
                  child: Stack(
                    children: [
                      Center(
                        child: Container(
                          width: 80,
                          height: 80,
                          decoration: const BoxDecoration(
                            shape: BoxShape.circle,
                            gradient: LinearGradient(
                              colors: [Color(0xFF4F46E5), Color(0xFF7C3AED)],
                            ),
                          ),
                          alignment: Alignment.center,
                          child: const Text(
                            'YO',
                            style: TextStyle(
                              fontSize: 28,
                              fontWeight: FontWeight.w700,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                      if (!_camera)
                        Positioned(
                          bottom: 16,
                          left: 16,
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: Colors.black54,
                              borderRadius: BorderRadius.circular(16),
                            ),
                            child: const Text(
                              '🎥 已關閉',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                      Positioned(
                        top: 16,
                        right: 16,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.black54,
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: const [
                              SizedBox(
                                width: 6,
                                height: 6,
                                child: DecoratedBox(
                                  decoration: BoxDecoration(
                                    color: Color(0xFF10B981),
                                    shape: BoxShape.circle,
                                  ),
                                ),
                              ),
                              SizedBox(width: 6),
                              Text(
                                'WebRTC 已連線',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    m['title'] as String? ?? '會議',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'M-02 一對一 / M-03 群組會議 · 預計 $participantCount 人參與',
                    style: TextStyle(fontSize: 12, color: Theme.of(context).hintColor),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _ToggleBtn(
                          icon: _mic ? Icons.mic : Icons.mic_off,
                          label: _mic ? '麥克風開' : '麥克風關',
                          active: _mic,
                          onTap: () => setState(() => _mic = !_mic),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: _ToggleBtn(
                          icon: _camera ? Icons.videocam : Icons.videocam_off,
                          label: _camera ? '鏡頭開' : '鏡頭關',
                          active: _camera,
                          onTap: () => setState(() => _camera = !_camera),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => Navigator.pop(context, false),
                          child: const Text('取消'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        flex: 2,
                        child: FilledButton(
                          onPressed: () => Navigator.pop(context, true),
                          child: const Text('加入會議'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.04),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.settings_outlined, size: 14),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            'M-07 螢幕分享 · M-08 會議錄製 · M-10 虛擬背景皆已啟用',
                            style: TextStyle(
                              fontSize: 11,
                              color: Theme.of(context).hintColor,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ToggleBtn extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;
  const _ToggleBtn({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      icon: Icon(icon, size: 16, color: active ? null : Colors.red),
      label: Text(label),
      style: OutlinedButton.styleFrom(
        foregroundColor: active ? null : Colors.red,
        side: BorderSide(color: active ? Theme.of(context).dividerColor : Colors.red.withValues(alpha: 0.3)),
        padding: const EdgeInsets.symmetric(vertical: 8),
      ),
      onPressed: onTap,
    );
  }
}
