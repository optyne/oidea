import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../admin/admin_errors.dart';
import '../../models/leave_models.dart';

final DateFormat _apiDate = DateFormat('yyyy-MM-dd');
final DateFormat _showDate = DateFormat('yyyy/MM/dd');

/// 申請請假。送出成功回傳 true；取消回傳 null／false。
///
/// 類別、日期、半天一變動就（debounce 後）呼叫 `GET /attendance/leaves/preview`，
/// 顯示「共 N 天」；特休另外顯示剩餘天數，超過剩餘時警告。送出失敗的原因（例如重疊）直接顯示在對話框裡。
Future<bool?> showLeaveRequestDialog(BuildContext context, {required String workspaceId}) {
  return showDialog<bool>(
    context: context,
    builder: (_) => LeaveRequestDialog(workspaceId: workspaceId),
  );
}

class LeaveRequestDialog extends ConsumerStatefulWidget {
  const LeaveRequestDialog({
    super.key,
    required this.workspaceId,
    this.debounce = const Duration(milliseconds: 400),
  });

  final String workspaceId;
  final Duration debounce;

  @override
  ConsumerState<LeaveRequestDialog> createState() => _LeaveRequestDialogState();
}

class _LeaveRequestDialogState extends ConsumerState<LeaveRequestDialog> {
  // ref.read 不能在 dispose 裡用，所以 initState 先存起來。
  late final ApiClient _api;
  final _reason = TextEditingController();
  Timer? _timer;
  int _seq = 0;

  String _type = 'personal';
  late DateTime _start;
  late DateTime _end;
  String _startPart = 'full'; // full | pm
  String _endPart = 'full'; // full | am

  bool _loading = false;
  LeavePreview? _preview;
  String? _previewError;

  bool _submitting = false;
  String? _submitError;

  bool get _sameDay => _start == _end;

  @override
  void initState() {
    super.initState();
    _api = ref.read(apiClientProvider);
    final now = DateTime.now();
    _start = DateTime(now.year, now.month, now.day);
    _end = _start;
    _loading = true;
    _runPreview(++_seq);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _reason.dispose();
    super.dispose();
  }

  /// 任何影響天數的欄位變動後呼叫：先清掉舊結果的顯示，debounce 後再問後端。
  void _changed(VoidCallback update) {
    setState(() {
      update();
      _loading = true;
      _previewError = null;
      _submitError = null;
    });
    _timer?.cancel();
    final seq = ++_seq;
    _timer = Timer(widget.debounce, () => _runPreview(seq));
  }

  Future<void> _runPreview(int seq) async {
    try {
      final json = await _api.previewLeave(
        workspaceId: widget.workspaceId,
        type: _type,
        startDate: _apiDate.format(_start),
        endDate: _apiDate.format(_end),
        startPart: _startPart,
        endPart: _endPart,
      );
      if (!mounted || seq != _seq) return;
      setState(() {
        _loading = false;
        _preview = LeavePreview.fromJson(json);
        _previewError = null;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _loading = false;
        _preview = null;
        _previewError = adminErrorMessage(e);
      });
    }
  }

  Future<void> _pickStart() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _start,
      firstDate: DateTime.now().subtract(const Duration(days: 30)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (d == null) return;
    _changed(() {
      final wasSame = _sameDay;
      _start = d;
      if (_end.isBefore(_start)) _end = _start;
      if (wasSame != _sameDay) _resetParts();
    });
  }

  Future<void> _pickEnd() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _end,
      firstDate: _start,
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (d == null) return;
    _changed(() {
      final wasSame = _sameDay;
      _end = d;
      if (wasSame != _sameDay) _resetParts();
    });
  }

  // 單日 ↔ 多日的選項意義不同（上午／下午 vs 起日下午起／迄日上午止），切換時回到全天。
  void _resetParts() {
    _startPart = 'full';
    _endPart = 'full';
  }

  String get _singleValue => _startPart == 'pm' ? 'pm' : (_endPart == 'am' ? 'am' : 'full');

  void _setSingle(String v) => _changed(() {
        _startPart = v == 'pm' ? 'pm' : 'full';
        _endPart = v == 'am' ? 'am' : 'full';
      });

  Future<void> _submit() async {
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    try {
      final reason = _reason.text.trim();
      await _api.createLeave({
        'workspaceId': widget.workspaceId,
        'type': _type,
        'startDate': _apiDate.format(_start),
        'endDate': _apiDate.format(_end),
        'startPart': _startPart,
        'endPart': _endPart,
        if (reason.isNotEmpty) 'reason': reason,
      });
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _submitError = adminErrorMessage(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final canSubmit = !_submitting && _previewError == null;
    return AlertDialog(
      title: const Text('申請請假'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DropdownButtonFormField<String>(
                value: _type,
                decoration: const InputDecoration(labelText: '類別', border: OutlineInputBorder()),
                items: const [
                  DropdownMenuItem(value: 'annual', child: Text('特休')),
                  DropdownMenuItem(value: 'sick', child: Text('病假')),
                  DropdownMenuItem(value: 'personal', child: Text('事假')),
                  DropdownMenuItem(value: 'unpaid', child: Text('無薪假')),
                  DropdownMenuItem(value: 'other', child: Text('其他')),
                ],
                onChanged: (v) => _changed(() => _type = v ?? 'personal'),
              ),
              const SizedBox(height: OideaSpace.space3),
              OutlinedButton(
                onPressed: _pickStart,
                child: Text('起：${_showDate.format(_start)}'),
              ),
              const SizedBox(height: OideaSpace.space2),
              OutlinedButton(
                onPressed: _pickEnd,
                child: Text('迄：${_showDate.format(_end)}'),
              ),
              const SizedBox(height: OideaSpace.space3),
              if (_sameDay)
                _PartRow(
                  label: '時段',
                  value: _singleValue,
                  options: const {'full': '全天', 'am': '上午', 'pm': '下午'},
                  onChanged: _setSingle,
                )
              else ...[
                _PartRow(
                  label: '起日',
                  value: _startPart,
                  options: const {'full': '全天', 'pm': '下午起'},
                  onChanged: (v) => _changed(() => _startPart = v),
                ),
                const SizedBox(height: OideaSpace.space2),
                _PartRow(
                  label: '迄日',
                  value: _endPart,
                  options: const {'full': '全天', 'am': '上午止'},
                  onChanged: (v) => _changed(() => _endPart = v),
                ),
              ],
              const SizedBox(height: OideaSpace.space3),
              _PreviewBox(
                loading: _loading,
                preview: _preview,
                error: _previewError,
                isAnnual: _type == 'annual',
              ),
              const SizedBox(height: OideaSpace.space3),
              TextField(
                controller: _reason,
                maxLines: 3,
                decoration: const InputDecoration(labelText: '事由（選填）', border: OutlineInputBorder()),
              ),
              if (_submitError != null) ...[
                const SizedBox(height: OideaSpace.space3),
                Text(_submitError!, style: const TextStyle(color: Colors.red)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _submitting ? null : () => Navigator.pop(context, false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: canSubmit ? _submit : null,
          child: Text(_submitting ? '送出中…' : '送出'),
        ),
      ],
    );
  }
}

class _PartRow extends StatelessWidget {
  const _PartRow({required this.label, required this.value, required this.options, required this.onChanged});

  final String label;
  final String value;
  final Map<String, String> options;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        SizedBox(width: 44, child: Text(label)),
        Expanded(
          child: SegmentedButton<String>(
            showSelectedIcon: false,
            segments: [
              for (final e in options.entries) ButtonSegment<String>(value: e.key, label: Text(e.value)),
            ],
            selected: {value},
            onSelectionChanged: (s) => onChanged(s.first),
          ),
        ),
      ],
    );
  }
}

class _PreviewBox extends StatelessWidget {
  const _PreviewBox({required this.loading, required this.preview, required this.error, required this.isAnnual});

  final bool loading;
  final LeavePreview? preview;
  final String? error;
  final bool isAnnual;

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    if (error != null) {
      return Text(error!, style: const TextStyle(color: Colors.red));
    }
    final p = preview;
    if (loading || p == null) {
      return Text('計算中…', style: small);
    }
    final annual = p.annual;
    final over = isAnnual && annual != null && p.days > annual.remaining;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('共 ${formatDays(p.days)}', style: const TextStyle(fontWeight: FontWeight.w600)),
        if (isAnnual && annual != null) ...[
          const SizedBox(height: OideaSpace.space1),
          if (annual.hasPeriod) ...[
            Text('特休剩餘 ${formatDays(annual.remaining)}'),
            Text(
              '期間 ${annual.periodLabel}：已給 ${formatDayCount(annual.entitled)}'
              '、調整 ${formatDayCount(annual.adjusted)}、已用 ${formatDayCount(annual.used)}',
              style: small,
            ),
          ] else
            const Text('到職未滿 6 個月，尚無特休'),
          if (over)
            Padding(
              padding: const EdgeInsets.only(top: OideaSpace.space1),
              child: Text(
                '申請 ${formatDays(p.days)}，超過剩餘的 ${formatDays(annual.remaining)}',
                style: const TextStyle(color: Colors.deepOrange, fontWeight: FontWeight.w600),
              ),
            ),
        ],
      ],
    );
  }
}
