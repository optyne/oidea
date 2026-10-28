import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../erp/models/leave_models.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';

/// 員工的特休：目前與上一個期間（已給、調整、已用、剩餘）、調整紀錄，以及「調整」按鈕。
/// 只給有 `leave.policy.manage` 的人用（呼叫端負責判斷；後端也會擋）。
Future<void> showEmployeeLeaveBalanceDialog(BuildContext context, EmployeeDto employee) {
  return showDialog<void>(
    context: context,
    builder: (_) => EmployeeLeaveBalanceDialog(employee: employee),
  );
}

class EmployeeLeaveBalanceDialog extends ConsumerWidget {
  const EmployeeLeaveBalanceDialog({super.key, required this.employee});

  final EmployeeDto employee;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(employeeLeaveBalanceProvider(employee.id));
    final data = async.valueOrNull;

    return AlertDialog(
      title: Text('特休：${employee.fullName}'),
      content: SizedBox(
        width: 520,
        child: async.when(
          loading: () => const SizedBox(height: 120, child: Center(child: CircularProgressIndicator())),
          error: (e, _) => Text(adminErrorMessage(e), style: const TextStyle(color: Colors.red)),
          data: (b) => SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (b.current == null && b.previous == null)
                  const Text('到職未滿 6 個月（或尚未設定到職日），還沒有特休。')
                else ...[
                  if (b.current != null) _PeriodBlock(title: '目前期間', balance: b.current!),
                  if (b.previous != null) ...[
                    const SizedBox(height: OideaSpace.space3),
                    _PeriodBlock(title: '上一期間', balance: b.previous!),
                  ],
                ],
                const SizedBox(height: OideaSpace.space4),
                const Text('調整紀錄', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: OideaSpace.space1),
                if (b.adjustments.isEmpty)
                  const Text('沒有調整紀錄')
                else
                  for (final a in b.adjustments) _AdjustmentRow(adjustment: a),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('關閉')),
        FilledButton(
          onPressed: data == null || data.adjustablePeriodStarts.isEmpty
              ? null
              : () async {
                  final saved = await showDialog<bool>(
                    context: context,
                    builder: (_) => LeaveAdjustmentDialog(employee: employee, balance: data),
                  );
                  if (saved == true) ref.invalidate(employeeLeaveBalanceProvider(employee.id));
                },
          child: const Text('調整'),
        ),
      ],
    );
  }
}

class _PeriodBlock extends StatelessWidget {
  const _PeriodBlock({required this.title, required this.balance});

  final String title;
  final AnnualBalance balance;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(OideaSpace.space3),
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).dividerColor),
        borderRadius: BorderRadius.circular(OideaRadius.sm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$title　${balance.periodLabel}', style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: OideaSpace.space1),
          Text(
            '已給 ${formatDays(balance.entitled)}　調整 ${formatDays(balance.adjusted)}　已用 ${formatDays(balance.used)}',
          ),
          Text('剩餘 ${formatDays(balance.remaining)}', style: const TextStyle(fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _AdjustmentRow extends StatelessWidget {
  const _AdjustmentRow({required this.adjustment});
  final LeaveAdjustment adjustment;

  @override
  Widget build(BuildContext context) {
    final a = adjustment;
    final created = (a.createdAt ?? '').length >= 10 ? a.createdAt!.substring(0, 10) : '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: OideaSpace.space1),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 72,
            child: Text(
              formatSignedDays(a.days),
              style: TextStyle(fontWeight: FontWeight.w600, color: a.days < 0 ? Colors.red : Colors.green),
            ),
          ),
          Expanded(
            child: Text(
              '${a.reason}\n期間 ${a.periodStart.replaceAll('-', '/')} 起${created.isEmpty ? '' : '　登錄於 $created'}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

/// 加一筆特休調整：選期間、±0.5 天為單位、填原因。成功回傳 true。
class LeaveAdjustmentDialog extends ConsumerStatefulWidget {
  const LeaveAdjustmentDialog({super.key, required this.employee, required this.balance});

  final EmployeeDto employee;
  final EmployeeLeaveBalance balance;

  @override
  ConsumerState<LeaveAdjustmentDialog> createState() => _LeaveAdjustmentDialogState();
}

class _LeaveAdjustmentDialogState extends ConsumerState<LeaveAdjustmentDialog> {
  late final ApiClient _api;
  final _reason = TextEditingController();
  late String _periodStart;
  double _days = 1;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _api = ref.read(apiClientProvider);
    _periodStart = widget.balance.adjustablePeriodStarts.first;
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  bool get _valid => _days != 0 && _reason.text.trim().isNotEmpty;

  void _step(double delta) {
    var next = _days + delta;
    if (next == 0) next += delta; // 0 不是合法的調整，直接跳過
    if (next.abs() > 365) return;
    setState(() => _days = next);
  }

  String _periodLabel(String start) {
    final tag = start == widget.balance.current?.periodStart ? '目前期間' : '上一期間';
    return '$tag（${start.replaceAll('-', '/')} 起）';
  }

  Future<void> _submit() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await _api.addLeaveAdjustment(
        widget.employee.id,
        periodStart: _periodStart,
        days: _days,
        reason: _reason.text.trim(),
      );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = adminErrorMessage(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final periods = widget.balance.adjustablePeriodStarts;
    return AlertDialog(
      title: Text('調整特休：${widget.employee.fullName}'),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DropdownButtonFormField<String>(
                value: _periodStart,
                decoration: const InputDecoration(labelText: '期間', border: OutlineInputBorder()),
                items: [for (final p in periods) DropdownMenuItem(value: p, child: Text(_periodLabel(p)))],
                onChanged: (v) => setState(() => _periodStart = v ?? _periodStart),
              ),
              const SizedBox(height: OideaSpace.space3),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  IconButton.outlined(
                    tooltip: '減 0.5 天',
                    icon: const Icon(Icons.remove),
                    onPressed: _saving ? null : () => _step(-0.5),
                  ),
                  SizedBox(
                    width: 120,
                    child: Text(
                      formatSignedDays(_days),
                      key: const Key('adjust-days'),
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: OideaFontSize.size16, fontWeight: FontWeight.w600),
                    ),
                  ),
                  IconButton.outlined(
                    tooltip: '加 0.5 天',
                    icon: const Icon(Icons.add),
                    onPressed: _saving ? null : () => _step(0.5),
                  ),
                ],
              ),
              const SizedBox(height: OideaSpace.space3),
              TextField(
                controller: _reason,
                maxLength: 200,
                maxLines: 2,
                decoration: const InputDecoration(labelText: '原因', border: OutlineInputBorder()),
                onChanged: (_) => setState(() {}),
              ),
              if (_error != null) Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: _saving ? null : () => Navigator.pop(context, false), child: const Text('取消')),
        FilledButton(onPressed: _valid && !_saving ? _submit : null, child: const Text('送出')),
      ],
    );
  }
}
