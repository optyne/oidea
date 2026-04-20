import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/erp_providers.dart';

class ExpensesPage extends ConsumerStatefulWidget {
  const ExpensesPage({super.key});

  @override
  ConsumerState<ExpensesPage> createState() => _ExpensesPageState();
}

class _ExpensesPageState extends ConsumerState<ExpensesPage> {
  String? _statusFilter;

  @override
  Widget build(BuildContext context) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      return const Scaffold(body: Center(child: Text('請先選擇工作空間')));
    }

    final listAsync = ref.watch(expensesProvider(ExpenseListKey(workspaceId, _statusFilter)));
    final statsAsync = ref.watch(expenseStatsProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('費用報銷'),
        actions: [
          PopupMenuButton<String?>(
            icon: const Icon(Icons.filter_list),
            onSelected: (v) => setState(() => _statusFilter = v),
            itemBuilder: (ctx) => const [
              PopupMenuItem(value: null, child: Text('全部')),
              PopupMenuItem(value: 'pending', child: Text('待審核')),
              PopupMenuItem(value: 'approved', child: Text('已核准')),
              PopupMenuItem(value: 'paid', child: Text('已付款')),
              PopupMenuItem(value: 'rejected', child: Text('已退回')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          statsAsync.when(
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
            data: (s) => _StatsStrip(stats: s),
          ),
          Expanded(
            child: listAsync.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(message: e.toString()),
              data: (list) {
                if (list.isEmpty) {
                  return const EmptyStateWidget(
                    icon: Icons.receipt_long,
                    title: '尚無報銷紀錄',
                    subtitle: '點下方按鈕新建一筆',
                  );
                }
                return RefreshIndicator(
                  onRefresh: () async {
                    ref.invalidate(expensesProvider(ExpenseListKey(workspaceId, _statusFilter)));
                    ref.invalidate(expenseStatsProvider(workspaceId));
                  },
                  child: ListView.separated(
                    itemCount: list.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (ctx, i) => _ExpenseRow(
                      expense: list[i] as Map<String, dynamic>,
                      onChanged: () {
                        ref.invalidate(expensesProvider(ExpenseListKey(workspaceId, _statusFilter)));
                        ref.invalidate(expenseStatsProvider(workspaceId));
                      },
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
        label: const Text('新建報銷'),
      ),
    );
  }

  Future<void> _showCreateDialog(BuildContext context, String workspaceId) async {
    final titleController = TextEditingController();
    final amountController = TextEditingController();
    final descController = TextEditingController();
    String category = 'other';

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: const Text('新建報銷'),
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
                  controller: amountController,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: '金額 (TWD)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  value: category,
                  decoration: const InputDecoration(labelText: '類別', border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(value: 'travel', child: Text('差旅')),
                    DropdownMenuItem(value: 'meal', child: Text('餐費')),
                    DropdownMenuItem(value: 'transport', child: Text('交通')),
                    DropdownMenuItem(value: 'office', child: Text('辦公用品')),
                    DropdownMenuItem(value: 'other', child: Text('其他')),
                  ],
                  onChanged: (v) => setSt(() => category = v ?? 'other'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: descController,
                  maxLines: 3,
                  decoration: const InputDecoration(labelText: '說明（選填）', border: OutlineInputBorder()),
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
    final title = titleController.text.trim();
    final amount = double.tryParse(amountController.text.trim());
    final desc = descController.text.trim();
    titleController.dispose();
    amountController.dispose();
    descController.dispose();

    if (ok != true || title.isEmpty || amount == null) return;

    try {
      await ref.read(apiClientProvider).createExpense({
        'workspaceId': workspaceId,
        'title': title,
        'amount': amount,
        'currency': 'TWD',
        'category': category,
        if (desc.isNotEmpty) 'description': desc,
      });
      ref.invalidate(expensesProvider(ExpenseListKey(workspaceId, _statusFilter)));
      ref.invalidate(expenseStatsProvider(workspaceId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('送出失敗：$e')));
      }
    }
  }
}

class _StatsStrip extends StatelessWidget {
  final Map<String, dynamic> stats;
  const _StatsStrip({required this.stats});

  String _fmtAmount(dynamic v) {
    final n = v is num ? v : num.tryParse(v?.toString() ?? '') ?? 0;
    return NumberFormat('#,##0').format(n);
  }

  @override
  Widget build(BuildContext context) {
    Widget tile(String label, Map<String, dynamic>? d, Color color) {
      final count = d?['count'] ?? 0;
      final amount = d?['amount'];
      return Expanded(
        child: Container(
          margin: const EdgeInsets.all(4),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text('$count 筆', style: const TextStyle(fontSize: 13)),
              if (amount != null)
                Text('NT\$ ${_fmtAmount(amount)}', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
      child: Row(
        children: [
          tile('待審核', stats['pending'] as Map<String, dynamic>?, Colors.orange),
          tile('已核准', stats['approved'] as Map<String, dynamic>?, Colors.blue),
          tile('已付款', stats['paid'] as Map<String, dynamic>?, Colors.green),
        ],
      ),
    );
  }
}

class _ExpenseRow extends ConsumerWidget {
  final Map<String, dynamic> expense;
  final VoidCallback onChanged;

  const _ExpenseRow({required this.expense, required this.onChanged});

  Color _statusColor(String? s) {
    switch (s) {
      case 'approved':
        return Colors.blue;
      case 'paid':
        return Colors.green;
      case 'rejected':
        return Colors.red;
      case 'pending':
      default:
        return Colors.orange;
    }
  }

  String _statusLabel(String? s) {
    switch (s) {
      case 'approved':
        return '已核准';
      case 'paid':
        return '已付款';
      case 'rejected':
        return '已退回';
      case 'pending':
      default:
        return '待審核';
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = expense['status'] as String?;
    final submitter = expense['submitter'] as Map<String, dynamic>?;
    final amount = expense['amount'];
    final amountNum = amount is num ? amount : num.tryParse(amount?.toString() ?? '') ?? 0;
    final createdAt = DateTime.tryParse(expense['createdAt']?.toString() ?? '')?.toLocal();

    return ListTile(
      onTap: () => _showDetail(context, ref, expense),
      title: Row(
        children: [
          Expanded(child: Text(expense['title'] as String? ?? '')),
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
        '${submitter?['displayName'] ?? ''}'
        ' · ${createdAt != null ? DateFormat('MM/dd HH:mm').format(createdAt) : ''}',
        style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
      ),
      trailing: Text(
        'NT\$ ${NumberFormat('#,##0').format(amountNum)}',
        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
      ),
    );
  }

  Future<void> _showDetail(BuildContext context, WidgetRef ref, Map<String, dynamic> e) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _ExpenseDetailSheet(expense: e, onChanged: onChanged),
    );
  }
}

class _ExpenseDetailSheet extends ConsumerWidget {
  final Map<String, dynamic> expense;
  final VoidCallback onChanged;

  const _ExpenseDetailSheet({required this.expense, required this.onChanged});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = expense['status'] as String? ?? 'pending';
    final submitter = expense['submitter'] as Map<String, dynamic>?;
    final amount = expense['amount'];
    final amountNum = amount is num ? amount : num.tryParse(amount?.toString() ?? '') ?? 0;
    final approvals = (expense['approvals'] as List<dynamic>?) ?? [];

    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      expand: false,
      builder: (ctx, scrollController) => ListView(
        controller: scrollController,
        padding: const EdgeInsets.all(16),
        children: [
          Text(expense['title'] as String? ?? '',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text('NT\$ ${NumberFormat('#,##0.##').format(amountNum)}',
              style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w300)),
          const SizedBox(height: 4),
          Text(
            '由 ${submitter?['displayName'] ?? ''} 提出 · 狀態：$status',
            style: TextStyle(color: Colors.grey.shade600),
          ),
          if ((expense['description'] as String?)?.isNotEmpty ?? false) ...[
            const SizedBox(height: 16),
            Text(expense['description'] as String, style: const TextStyle(fontSize: 14)),
          ],
          if (expense['rejectReason'] != null) ...[
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Colors.red.shade50,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text('退回原因：${expense['rejectReason']}',
                  style: const TextStyle(color: Colors.red)),
            ),
          ],
          if (approvals.isNotEmpty) ...[
            const SizedBox(height: 16),
            const Text('審批記錄', style: TextStyle(fontWeight: FontWeight.w600)),
            ...approvals.map((a) {
              final m = a as Map<String, dynamic>;
              final approver = m['approver'] as Map<String, dynamic>?;
              return ListTile(
                dense: true,
                leading: Icon(
                  m['decision'] == 'approved' ? Icons.check_circle : Icons.cancel,
                  color: m['decision'] == 'approved' ? Colors.green : Colors.red,
                ),
                title: Text(approver?['displayName'] ?? ''),
                subtitle: Text(m['comment'] as String? ?? '—'),
              );
            }),
          ],
          const SizedBox(height: 24),
          _ActionButtons(expense: expense, status: status, onChanged: onChanged),
        ],
      ),
    );
  }
}

class _ActionButtons extends ConsumerWidget {
  final Map<String, dynamic> expense;
  final String status;
  final VoidCallback onChanged;

  const _ActionButtons({required this.expense, required this.status, required this.onChanged});

  Future<void> _confirm(
    BuildContext context,
    WidgetRef ref,
    Future<void> Function() op,
    String successMsg,
  ) async {
    try {
      await op();
      onChanged();
      if (context.mounted) {
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(successMsg)));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失敗：$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = expense['id'] as String;
    final api = ref.read(apiClientProvider);

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        if (status == 'pending') ...[
          FilledButton.icon(
            icon: const Icon(Icons.check),
            label: const Text('核准'),
            onPressed: () => _confirm(context, ref, () => api.approveExpense(id), '已核准'),
          ),
          OutlinedButton.icon(
            icon: const Icon(Icons.close),
            label: const Text('退回'),
            onPressed: () async {
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
              if (ok == true && reason.isNotEmpty) {
                await _confirm(context, ref, () => api.rejectExpense(id, reason), '已退回');
              }
            },
          ),
        ],
        if (status == 'approved')
          FilledButton.icon(
            icon: const Icon(Icons.payments),
            label: const Text('標記已付款'),
            onPressed: () => _confirm(context, ref, () => api.markExpensePaid(id), '已標記為付款'),
          ),
        if (status == 'pending')
          TextButton.icon(
            icon: const Icon(Icons.undo, color: Colors.red),
            label: const Text('取消報銷', style: TextStyle(color: Colors.red)),
            onPressed: () => _confirm(context, ref, () => api.cancelExpense(id), '已取消'),
          ),
      ],
    );
  }
}
