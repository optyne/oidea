import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../providers/notes_providers.dart';

class DatabaseView extends ConsumerWidget {
  final String pageId;
  final Map<String, dynamic> database;
  final List<dynamic> properties;

  const DatabaseView({
    super.key,
    required this.pageId,
    required this.database,
    required this.properties,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final databaseId = database['id'] as String;
    final rowsAsync = ref.watch(databaseRowsProvider(databaseId));
    final template = database['template'] as String?;
    final isFinanceLog = template == 'finance_log';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (isFinanceLog) _FinanceSummaryStrip(databaseId: databaseId),
        Expanded(
          child: rowsAsync.when(
            loading: () => const LoadingWidget(),
            error: (e, _) => AppErrorWidget(message: e.toString()),
            data: (rows) => _TableView(
              databaseId: databaseId,
              properties: properties,
              rows: rows,
              isFinanceLog: isFinanceLog,
              onChanged: () => ref.invalidate(databaseRowsProvider(databaseId)),
            ),
          ),
        ),
      ],
    );
  }
}

class _FinanceSummaryStrip extends ConsumerWidget {
  final String databaseId;
  const _FinanceSummaryStrip({required this.databaseId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = DateTime.now();
    final ym = DateFormat('yyyy-MM').format(now);
    final key = FinanceSummaryKey(databaseId, ym);
    final async = ref.watch(financeSummaryProvider(key));

    return async.when(
      loading: () => const SizedBox(height: 70),
      error: (_, __) => const SizedBox.shrink(),
      data: (s) {
        final income = (s['totalIncome'] as num?)?.toDouble() ?? 0;
        final expense = (s['totalExpense'] as num?)?.toDouble() ?? 0;
        final net = (s['net'] as num?)?.toDouble() ?? 0;
        final byCategory = (s['byCategory'] as Map?)?.cast<String, dynamic>() ?? {};
        final topCategories = byCategory.entries.toList()
          ..sort((a, b) => ((b.value as num).compareTo(a.value as num)));

        Widget tile(String label, double v, Color c) => Expanded(
              child: Container(
                margin: const EdgeInsets.all(4),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: c.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(color: c, fontSize: 12, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      NumberFormat.currency(symbol: 'NT\$', decimalDigits: 0).format(v),
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
            );

        return Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
          child: Column(
            children: [
              Row(
                children: [
                  Text(
                    '$ym 月總覽',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                  ),
                  const Spacer(),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  tile('收入', income, Colors.green),
                  tile('支出', expense, Colors.red),
                  tile('淨額', net, Colors.blue),
                ],
              ),
              if (topCategories.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.all(4),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: topCategories.take(6).map((e) {
                      return Chip(
                        label: Text(
                          '${e.key}  ${NumberFormat('#,##0').format(e.value as num)}',
                          style: const TextStyle(fontSize: 11),
                        ),
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      );
                    }).toList(),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _TableView extends ConsumerStatefulWidget {
  final String databaseId;
  final List<dynamic> properties;
  final List<dynamic> rows;
  final bool isFinanceLog;
  final VoidCallback onChanged;

  const _TableView({
    required this.databaseId,
    required this.properties,
    required this.rows,
    required this.isFinanceLog,
    required this.onChanged,
  });

  @override
  ConsumerState<_TableView> createState() => _TableViewState();
}

class _TableViewState extends ConsumerState<_TableView> {
  Future<void> _showRowDialog({Map<String, dynamic>? row}) async {
    final controllers = <String, TextEditingController>{};
    final values = <String, dynamic>{};
    for (final p in widget.properties) {
      final prop = p as Map<String, dynamic>;
      final key = prop['key'] as String;
      final init = row == null ? '' : (row['values']?[key]?.toString() ?? '');
      controllers[key] = TextEditingController(text: init);
      values[key] = row?['values']?[key];
    }

    // 記帳範本下，日期預設今天
    if (widget.isFinanceLog && row == null) {
      controllers['date']?.text = DateFormat('yyyy-MM-dd').format(DateTime.now());
    }

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSt) => AlertDialog(
          title: Text(row == null ? '新增一列' : '編輯'),
          content: SizedBox(
            width: 400,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: widget.properties.map<Widget>((p) {
                  final prop = p as Map<String, dynamic>;
                  final key = prop['key'] as String;
                  final name = prop['name'] as String? ?? key;
                  final type = prop['type'] as String? ?? 'text';
                  final cfg = (prop['config'] as Map?)?.cast<String, dynamic>() ?? {};

                  if (type == 'select') {
                    final options = (cfg['options'] as List?)?.cast<dynamic>() ?? [];
                    final currentId = values[key] as String?;
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: DropdownButtonFormField<String?>(
                        value: options.any((o) => (o as Map)['id'] == currentId)
                            ? currentId
                            : null,
                        decoration: InputDecoration(labelText: name, border: const OutlineInputBorder()),
                        items: [
                          const DropdownMenuItem<String?>(value: null, child: Text('—')),
                          ...options.map((o) {
                            final m = o as Map<String, dynamic>;
                            return DropdownMenuItem<String?>(
                              value: m['id'] as String,
                              child: Text(m['label'] as String? ?? ''),
                            );
                          }),
                        ],
                        onChanged: (v) => setSt(() => values[key] = v),
                      ),
                    );
                  }
                  if (type == 'checkbox') {
                    return CheckboxListTile(
                      title: Text(name),
                      value: values[key] == true,
                      onChanged: (v) => setSt(() => values[key] = v ?? false),
                    );
                  }
                  if (type == 'date') {
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: OutlinedButton(
                        onPressed: () async {
                          final raw = controllers[key]!.text;
                          final picked = await showDatePicker(
                            context: ctx,
                            initialDate: DateTime.tryParse(raw) ?? DateTime.now(),
                            firstDate: DateTime(2000),
                            lastDate: DateTime(2100),
                          );
                          if (picked != null) {
                            setSt(() => controllers[key]!.text =
                                DateFormat('yyyy-MM-dd').format(picked));
                          }
                        },
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            '$name：${controllers[key]!.text.isEmpty ? '—' : controllers[key]!.text}',
                          ),
                        ),
                      ),
                    );
                  }
                  // text / number / currency / url / person（以 text 呈現）
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: TextField(
                      controller: controllers[key],
                      keyboardType: (type == 'number' || type == 'currency')
                          ? const TextInputType.numberWithOptions(decimal: true)
                          : TextInputType.text,
                      decoration: InputDecoration(labelText: name, border: const OutlineInputBorder()),
                    ),
                  );
                }).toList(),
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('儲存')),
          ],
        ),
      ),
    );

    final payload = <String, dynamic>{};
    for (final p in widget.properties) {
      final prop = p as Map<String, dynamic>;
      final key = prop['key'] as String;
      final type = prop['type'] as String? ?? 'text';
      if (type == 'select' || type == 'checkbox') {
        payload[key] = values[key];
      } else if (type == 'number' || type == 'currency') {
        payload[key] = double.tryParse(controllers[key]!.text.trim());
      } else {
        final txt = controllers[key]!.text.trim();
        payload[key] = txt.isEmpty ? null : txt;
      }
    }
    for (final c in controllers.values) {
      c.dispose();
    }
    if (ok != true) return;

    try {
      final api = ref.read(apiClientProvider);
      if (row == null) {
        await api.createDatabaseRow(widget.databaseId, payload);
      } else {
        await api.updateDatabaseRow(row['id'] as String, payload);
      }
      widget.onChanged();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('儲存失敗：$e')));
      }
    }
  }

  String _displayValue(Map<String, dynamic> prop, dynamic raw) {
    if (raw == null) return '';
    final type = prop['type'] as String? ?? 'text';
    final cfg = (prop['config'] as Map?)?.cast<String, dynamic>() ?? {};
    if (type == 'select') {
      final options = (cfg['options'] as List?)?.cast<dynamic>() ?? [];
      final opt = options.firstWhere(
        (o) => (o as Map)['id'] == raw,
        orElse: () => null,
      );
      if (opt == null) return raw.toString();
      return (opt as Map)['label'] as String? ?? raw.toString();
    }
    if (type == 'checkbox') return raw == true ? '☑' : '☐';
    if (type == 'currency') {
      final n = num.tryParse(raw.toString());
      if (n == null) return raw.toString();
      final code = (cfg['code'] as String?) ?? 'TWD';
      return '$code ${NumberFormat('#,##0.##').format(n)}';
    }
    return raw.toString();
  }

  @override
  Widget build(BuildContext context) {
    final columns = widget.properties;

    return Column(
      children: [
        Expanded(
          child: widget.rows.isEmpty
              ? const EmptyStateWidget(
                  icon: Icons.table_rows,
                  title: '尚無資料',
                  subtitle: '點下方按鈕新增一列',
                )
              : SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: DataTable(
                    showCheckboxColumn: false,
                    columns: [
                      ...columns.map(
                        (p) => DataColumn(
                          label: Text(
                            (p as Map<String, dynamic>)['name'] as String? ?? '',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                        ),
                      ),
                      const DataColumn(label: Text('')),
                    ],
                    rows: widget.rows.map<DataRow>((r) {
                      final row = r as Map<String, dynamic>;
                      final values = (row['values'] as Map?)?.cast<String, dynamic>() ?? {};
                      return DataRow(
                        onSelectChanged: (_) => _showRowDialog(row: row),
                        cells: [
                          ...columns.map(
                            (p) => DataCell(
                              Text(_displayValue(p as Map<String, dynamic>, values[p['key']])),
                            ),
                          ),
                          DataCell(
                            IconButton(
                              icon: const Icon(Icons.delete_outline, size: 18),
                              onPressed: () async {
                                try {
                                  await ref.read(apiClientProvider)
                                      .deleteDatabaseRow(row['id'] as String);
                                  widget.onChanged();
                                } catch (e) {
                                  if (mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(content: Text('刪除失敗：$e')),
                                    );
                                  }
                                }
                              },
                            ),
                          ),
                        ],
                      );
                    }).toList(),
                  ),
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('新增一列'),
              onPressed: () => _showRowDialog(),
            ),
          ),
        ),
      ],
    );
  }
}
