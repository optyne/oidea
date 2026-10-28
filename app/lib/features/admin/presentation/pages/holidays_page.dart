import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../admin_errors.dart';
import '../../holiday_parser.dart';
import '../../providers/admin_providers.dart';
import '../widgets/admin_widgets.dart';

/// 國定假日後台（`leave.policy.manage`）：選年份、看那一年的假日、貼上清單整年取代。
/// 請假天數會排除這裡的日期（週六日本來就不算）。
class HolidaysPage extends ConsumerStatefulWidget {
  const HolidaysPage({super.key});

  @override
  ConsumerState<HolidaysPage> createState() => _HolidaysPageState();
}

class _HolidaysPageState extends ConsumerState<HolidaysPage> {
  late int _year = DateTime.now().year;

  List<int> get _years {
    final y = DateTime.now().year;
    return {for (var i = y - 2; i <= y + 2; i++) i, _year}.toList()..sort();
  }

  void _toast(String msg) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));

  Future<void> _replace(List<Map<String, dynamic>> items, String okMessage) async {
    final year = _year;
    try {
      await ref.read(apiClientProvider).replaceAdminHolidays(year, items);
      if (!mounted) return;
      ref.invalidate(holidaysProvider(year));
      _toast(okMessage);
    } catch (e) {
      if (!mounted) return;
      await showErrorDialog(context, e);
    }
  }

  Future<void> _paste(int existingCount) async {
    final items = await showHolidayPasteDialog(context, year: _year, existingCount: existingCount);
    if (items == null || !mounted) return;
    await _replace(
      [for (final i in items) {'date': i.date, 'name': i.name}],
      '已更新 $_year 年的假日（${items.length} 筆）',
    );
  }

  Future<void> _clear() async {
    final ok = await confirmAction(
      context,
      title: '清空 $_year 年的假日',
      message: '會刪除 $_year 年全部的假日。之後申請的假單會把這些日期當一般工作日計算（已送出的假單天數不變）。',
      confirmLabel: '清空',
      destructive: true,
    );
    if (!ok || !mounted) return;
    await _replace(const [], '已清空 $_year 年的假日');
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(holidaysProvider(_year));
    final count = async.valueOrNull?.items.length ?? 0;

    return Scaffold(
      appBar: AppBar(
        title: const Text('國定假日'),
        actions: [
          IconButton(
            tooltip: '重新整理',
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(holidaysProvider(_year)),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: async.hasValue ? () => _paste(count) : null,
        icon: const Icon(Icons.content_paste),
        label: const Text('貼上清單'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(OideaSpace.space3),
            child: Row(
              children: [
                const Text('年份　'),
                DropdownButton<int>(
                  value: _year,
                  items: [for (final y in _years) DropdownMenuItem(value: y, child: Text('$y'))],
                  onChanged: (y) => setState(() => _year = y ?? _year),
                ),
                const Spacer(),
                if (count > 0) TextButton(onPressed: _clear, child: const Text('清空這一年')),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: async.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(
                message: adminErrorMessage(e),
                onRetry: () => ref.invalidate(holidaysProvider(_year)),
              ),
              data: (data) {
                if (data.items.isEmpty) {
                  return EmptyStateWidget(
                    icon: Icons.event_available_outlined,
                    title: '$_year 年還沒有設定假日',
                    subtitle: '點「貼上清單」，每行一個：2026-10-10 國慶日',
                  );
                }
                return ListView.separated(
                  itemCount: data.items.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (_, i) {
                    final h = data.items[i];
                    return ListTile(
                      dense: true,
                      title: Text(h.name),
                      trailing: Text(h.date),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// 貼上假日清單。解析後逐行預覽（有問題的行標紅），沒有任何問題才能送出。
/// 回傳要送出的清單；取消回 null。
Future<List<({String date, String name})>?> showHolidayPasteDialog(
  BuildContext context, {
  required int year,
  int existingCount = 0,
}) {
  return showDialog<List<({String date, String name})>>(
    context: context,
    builder: (_) => HolidayPasteDialog(year: year, existingCount: existingCount),
  );
}

class HolidayPasteDialog extends StatefulWidget {
  const HolidayPasteDialog({super.key, required this.year, this.existingCount = 0});

  final int year;
  final int existingCount;

  @override
  State<HolidayPasteDialog> createState() => _HolidayPasteDialogState();
}

class _HolidayPasteDialogState extends State<HolidayPasteDialog> {
  final _text = TextEditingController();
  late HolidayParseResult _result = parseHolidayList('', year: widget.year);

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = _result;
    final badCount = r.lines.where((l) => !l.ok).length;
    final small = Theme.of(context).textTheme.bodySmall;

    return AlertDialog(
      title: Text('貼上 ${widget.year} 年假日'),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '每行一個，格式「日期 名稱」，例如 ${widget.year}-10-10 國慶日。'
                '日期可寫 YYYY-MM-DD 或 YYYY/MM/DD，和名稱之間用空白、Tab 或逗號隔開。',
                style: small,
              ),
              const SizedBox(height: OideaSpace.space3),
              TextField(
                controller: _text,
                minLines: 6,
                maxLines: 10,
                autofocus: true,
                decoration: const InputDecoration(border: OutlineInputBorder(), hintText: '貼上清單…'),
                onChanged: (v) => setState(() => _result = parseHolidayList(v, year: widget.year)),
              ),
              const SizedBox(height: OideaSpace.space3),
              if (r.lines.isNotEmpty) ...[
                Text(
                  '${r.items.length} 筆可用${badCount > 0 ? '、$badCount 行有問題' : ''}',
                  style: TextStyle(fontWeight: FontWeight.w600, color: badCount > 0 ? Colors.red : null),
                ),
                if (r.overallError != null)
                  Text(r.overallError!, style: const TextStyle(color: Colors.red)),
                const SizedBox(height: OideaSpace.space2),
                for (final l in r.lines) _LineRow(line: l),
              ],
              if (widget.existingCount > 0) ...[
                const SizedBox(height: OideaSpace.space3),
                Text(
                  '送出後會取代 ${widget.year} 年現有的 ${widget.existingCount} 筆假日。',
                  style: const TextStyle(color: Colors.deepOrange),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: r.canSubmit ? () => Navigator.pop(context, r.items) : null,
          child: Text('取代 ${widget.year} 年（${r.items.length} 筆）'),
        ),
      ],
    );
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({required this.line});
  final ParsedHolidayLine line;

  @override
  Widget build(BuildContext context) {
    final bad = !line.ok;
    return Container(
      margin: const EdgeInsets.only(bottom: OideaSpace.space1),
      padding: const EdgeInsets.symmetric(horizontal: OideaSpace.space2, vertical: OideaSpace.space1),
      decoration: BoxDecoration(
        color: bad ? Colors.red.withValues(alpha: 0.08) : null,
        borderRadius: BorderRadius.circular(OideaRadius.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(bad ? Icons.error_outline : Icons.check_circle_outline, size: 16, color: bad ? Colors.red : Colors.green),
          const SizedBox(width: OideaSpace.space2),
          Expanded(
            child: bad
                ? Text('第 ${line.lineNo} 行：${line.raw.trim()}　→　${line.error}', style: const TextStyle(color: Colors.red))
                : Text('${line.date}　${line.name}'),
          ),
        ],
      ),
    );
  }
}
