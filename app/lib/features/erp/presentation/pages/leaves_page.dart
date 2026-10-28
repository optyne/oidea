import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../admin/admin_errors.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../models/leave_models.dart';
import '../../providers/erp_providers.dart';
import '../../../../core/theme/app_theme.dart';
import '../widgets/leave_request_dialog.dart';

class LeavesPage extends ConsumerStatefulWidget {
  const LeavesPage({super.key});

  @override
  ConsumerState<LeavesPage> createState() => _LeavesPageState();
}

class _LeavesPageState extends ConsumerState<LeavesPage> {
  /// 假單有變動（新增、核准、退回、取消）：清單與我的特休餘額都要重抓。
  void _refresh(String workspaceId) {
    ref.invalidate(leavesProvider(workspaceId));
    ref.invalidate(myLeaveBalanceProvider(workspaceId));
  }

  @override
  Widget build(BuildContext context) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      return const Scaffold(body: Center(child: Text('請先選擇工作空間')));
    }
    final listAsync = ref.watch(leavesProvider(workspaceId));
    // 抓不到或沒有（公司工作空間以外、未滿 6 個月）就不顯示。
    final balance = ref.watch(myLeaveBalanceProvider(workspaceId)).valueOrNull;

    return Scaffold(
      appBar: AppBar(title: const Text('請假')),
      body: Column(
        children: [
          if (balance != null && balance.hasPeriod) _BalanceBanner(balance: balance),
          Expanded(
            child: listAsync.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(message: adminErrorMessage(e)),
              data: (list) {
                if (list.isEmpty) {
                  return const EmptyStateWidget(
                    icon: Icons.event_busy,
                    title: '尚無請假紀錄',
                    subtitle: '點下方按鈕提交申請',
                  );
                }
                return RefreshIndicator(
                  onRefresh: () async => _refresh(workspaceId),
                  child: ListView.separated(
                    itemCount: list.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (ctx, i) => _LeaveRow(
                      leave: list[i] as Map<String, dynamic>,
                      onChanged: () => _refresh(workspaceId),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showCreateDialog(context, workspaceId),
        icon: const Icon(Icons.add),
        label: const Text('申請請假'),
      ),
    );
  }

  Future<void> _showCreateDialog(BuildContext context, String workspaceId) async {
    final created = await showLeaveRequestDialog(context, workspaceId: workspaceId);
    if (created == true && mounted) _refresh(workspaceId);
  }
}

/// 頁面最上方：我目前這個週年期間的特休。
class _BalanceBanner extends StatelessWidget {
  const _BalanceBanner({required this.balance});
  final AnnualBalance balance;

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    return Card(
      margin: const EdgeInsets.fromLTRB(OideaSpace.space3, OideaSpace.space3, OideaSpace.space3, 0),
      child: Padding(
        padding: const EdgeInsets.all(OideaSpace.space3),
        child: Row(
          children: [
            const Icon(Icons.beach_access_outlined),
            const SizedBox(width: OideaSpace.space3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '特休剩餘 ${formatDays(balance.remaining)}',
                    key: const Key('annual-balance-remaining'),
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  Text(
                    '${balance.periodLabel}　已給 ${formatDayCount(balance.entitled)}'
                    '、調整 ${formatDayCount(balance.adjusted)}、已用 ${formatDayCount(balance.used)}',
                    style: small,
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

class _LeaveRow extends ConsumerWidget {
  final Map<String, dynamic> leave;
  final VoidCallback onChanged;
  const _LeaveRow({required this.leave, required this.onChanged});

  String _typeLabel(String? t) =>
      const {'annual': '特休', 'sick': '病假', 'personal': '事假', 'unpaid': '無薪假', 'other': '其他'}[t] ?? '—';

  Color _statusColor(String? s) {
    switch (s) {
      case 'approved':
        return Colors.green;
      case 'rejected':
        return Colors.red;
      case 'cancelled':
        return Colors.grey;
      case 'pending':
      default:
        return Colors.orange;
    }
  }

  String _statusLabel(String? s) =>
      const {'approved': '已核准', 'rejected': '已退回', 'cancelled': '已取消', 'pending': '待審核'}[s] ?? '—';

  /// 「2026/11/02 → 2026/11/04　下午起…」的第二行；有天數與半天標示時一併帶上。
  String _subtitle() {
    final startDate = DateTime.tryParse(leave['startDate']?.toString() ?? '');
    final endDate = DateTime.tryParse(leave['endDate']?.toString() ?? '');
    final fmt = DateFormat('yyyy/MM/dd');
    final sameDay = startDate != null &&
        endDate != null &&
        startDate.year == endDate.year &&
        startDate.month == endDate.month &&
        startDate.day == endDate.day;
    final note = leavePartsNote(
      sameDay: sameDay,
      startPart: leave['startPart']?.toString() ?? 'full',
      endPart: leave['endPart']?.toString() ?? 'full',
    );
    final days = leave['days'];
    final from = startDate != null ? fmt.format(startDate) : '';
    final to = endDate != null ? fmt.format(endDate) : '';
    final range = sameDay ? from : '$from → $to';
    final reason = (leave['reason'] as String?)?.isNotEmpty == true ? '　${leave['reason']}' : '';
    return '$range'
        '${note.isNotEmpty ? '（$note）' : ''}'
        '${days is num ? '　${formatDays(days)}' : ''}'
        '$reason';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final requester = leave['requester'] as Map<String, dynamic>?;
    final status = leave['status'] as String?;
    final api = ref.read(apiClientProvider);

    return ListTile(
      title: Row(
        children: [
          Expanded(
            child: Text(
              '${requester?['displayName'] ?? ''} · ${_typeLabel(leave['type'] as String?)}',
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: OideaSpace.space15, vertical: OideaSpace.space05),
            decoration: BoxDecoration(
              color: _statusColor(status).withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(OideaRadius.sm),
            ),
            child: Text(
              _statusLabel(status),
              style: TextStyle(
                color: _statusColor(status),
                fontSize: OideaFontSize.size11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
      subtitle: Text(_subtitle()),
      trailing: status == 'pending'
          ? PopupMenuButton<String>(
              onSelected: (v) async {
                final id = leave['id'] as String;
                try {
                  if (v == 'approve') {
                    await api.approveLeave(id);
                  } else if (v == 'reject') {
                    final reasonCtl = TextEditingController();
                    final ok = await showDialog<bool>(
                      context: context,
                      builder: (dctx) => AlertDialog(
                        title: const Text('退回原因'),
                        content: TextField(controller: reasonCtl, autofocus: true),
                        actions: [
                          TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('取消')),
                          FilledButton(onPressed: () => Navigator.pop(dctx, true), child: const Text('退回')),
                        ],
                      ),
                    );
                    final reason = reasonCtl.text.trim();
                    reasonCtl.dispose();
                    if (ok != true) return;
                    await api.rejectLeave(id, reason: reason);
                  } else if (v == 'cancel') {
                    await api.cancelLeave(id);
                  }
                  onChanged();
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失敗：${adminErrorMessage(e)}')));
                  }
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'approve', child: Text('核准')),
                PopupMenuItem(value: 'reject', child: Text('退回')),
                PopupMenuItem(value: 'cancel', child: Text('取消申請')),
              ],
            )
          : null,
    );
  }
}
