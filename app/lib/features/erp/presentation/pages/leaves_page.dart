import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/erp_providers.dart';

class LeavesPage extends ConsumerStatefulWidget {
  const LeavesPage({super.key});

  @override
  ConsumerState<LeavesPage> createState() => _LeavesPageState();
}

class _LeavesPageState extends ConsumerState<LeavesPage> {
  @override
  Widget build(BuildContext context) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      return const Scaffold(body: Center(child: Text('請先選擇工作空間')));
    }
    final listAsync = ref.watch(leavesProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(title: const Text('請假')),
      body: listAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(message: e.toString()),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyStateWidget(
              icon: Icons.event_busy,
              title: '尚無請假紀錄',
              subtitle: '點下方按鈕提交申請',
            );
          }
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(leavesProvider(workspaceId));
            },
            child: ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (ctx, i) => _LeaveRow(
                leave: list[i] as Map<String, dynamic>,
                onChanged: () => ref.invalidate(leavesProvider(workspaceId)),
              ),
            ),
          );
        },
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _showCreateDialog(context, workspaceId),
        icon: const Icon(Icons.add),
        label: const Text('申請請假'),
      ),
    );
  }

  Future<void> _showCreateDialog(BuildContext context, String workspaceId) async {
    String type = 'personal';
    DateTime start = DateTime.now();
    DateTime end = DateTime.now();
    final reasonCtl = TextEditingController();

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('申請請假'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DropdownButtonFormField<String>(
                  value: type,
                  decoration: const InputDecoration(labelText: '類別', border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(value: 'annual', child: Text('特休')),
                    DropdownMenuItem(value: 'sick', child: Text('病假')),
                    DropdownMenuItem(value: 'personal', child: Text('事假')),
                    DropdownMenuItem(value: 'unpaid', child: Text('無薪假')),
                    DropdownMenuItem(value: 'other', child: Text('其他')),
                  ],
                  onChanged: (v) => setSt(() => type = v ?? 'personal'),
                ),
                const SizedBox(height: 12),
                OutlinedButton(
                  onPressed: () async {
                    final d = await showDatePicker(
                      context: ctx,
                      initialDate: start,
                      firstDate: DateTime.now().subtract(const Duration(days: 30)),
                      lastDate: DateTime.now().add(const Duration(days: 365)),
                    );
                    if (d != null) setSt(() => start = d);
                  },
                  child: Text('起：${DateFormat('yyyy/MM/dd').format(start)}'),
                ),
                const SizedBox(height: 8),
                OutlinedButton(
                  onPressed: () async {
                    final d = await showDatePicker(
                      context: ctx,
                      initialDate: end,
                      firstDate: start,
                      lastDate: DateTime.now().add(const Duration(days: 365)),
                    );
                    if (d != null) setSt(() => end = d);
                  },
                  child: Text('迄：${DateFormat('yyyy/MM/dd').format(end)}'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: reasonCtl,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: '事由（選填）', border: OutlineInputBorder()),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('送出')),
          ],
        ),
      ),
    );
    final reason = reasonCtl.text.trim();
    reasonCtl.dispose();
    if (ok != true) return;

    try {
      await ref.read(apiClientProvider).createLeave({
        'workspaceId': workspaceId,
        'type': type,
        'startDate': DateFormat('yyyy-MM-dd').format(start),
        'endDate': DateFormat('yyyy-MM-dd').format(end),
        if (reason.isNotEmpty) 'reason': reason,
      });
      ref.invalidate(leavesProvider(workspaceId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('送出失敗：$e')));
      }
    }
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

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final requester = leave['requester'] as Map<String, dynamic>?;
    final startDate = DateTime.tryParse(leave['startDate']?.toString() ?? '');
    final endDate = DateTime.tryParse(leave['endDate']?.toString() ?? '');
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
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(
              color: _statusColor(status).withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              _statusLabel(status),
              style: TextStyle(
                color: _statusColor(status),
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
      subtitle: Text(
        '${startDate != null ? DateFormat('yyyy/MM/dd').format(startDate) : ''} → '
        '${endDate != null ? DateFormat('yyyy/MM/dd').format(endDate) : ''}'
        '${(leave['reason'] as String?)?.isNotEmpty == true ? '　${leave['reason']}' : ''}',
      ),
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
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失敗：$e')));
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
