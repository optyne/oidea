import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';

/// 包住後台頁面：等 `/company/me` 載入完才決定要不要顯示。
/// 沒有 [anyOf] 其中任何一個權限 → 顯示說明並導回 `/chat`。
class AdminGuard extends ConsumerWidget {
  const AdminGuard({super.key, required this.child, this.anyOf = AdminPerm.anyAdmin});

  final Widget child;
  final List<String> anyOf;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(companyMeProvider);
    return me.when(
      loading: () => const Scaffold(body: LoadingWidget()),
      error: (e, _) => Scaffold(
        appBar: AppBar(title: const Text('後台')),
        body: AppErrorWidget(
          message: adminErrorMessage(e),
          onRetry: () => ref.invalidate(companyMeProvider),
        ),
      ),
      data: (m) {
        if (anyOf.any(m.can)) return child;
        if (GoRouter.maybeOf(context) != null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (context.mounted) context.go('/chat');
          });
        }
        return const Scaffold(body: Center(child: Text('您沒有權限查看此頁面')));
      },
    );
  }
}

/// 簡單的確認對話框。回傳 true = 使用者按了確認。
Future<bool> confirmAction(
  BuildContext context, {
  required String title,
  required String message,
  String confirmLabel = '確認',
  bool destructive = false,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
        FilledButton(
          style: destructive ? FilledButton.styleFrom(backgroundColor: Colors.red) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return ok == true;
}

/// 操作失敗時用對話框顯示完整訊息（例如要列出工作空間清單的長訊息）。
Future<void> showErrorDialog(BuildContext context, Object error, {String title = '操作失敗'}) {
  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: SelectableText(adminErrorMessage(error)),
      actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('知道了'))],
    ),
  );
}

/// `YYYY-MM-DD` 文字欄位，右側有日期選擇器。
class DateTextField extends StatelessWidget {
  const DateTextField({
    super.key,
    required this.controller,
    required this.label,
    this.required = false,
    this.enabled = true,
    this.onChanged,
  });

  final TextEditingController controller;
  final String label;
  final bool required;
  final bool enabled;
  final ValueChanged<String>? onChanged;

  static String? validate(String? value, {required bool required}) {
    final v = (value ?? '').trim();
    if (v.isEmpty) return required ? '必填' : null;
    return isValidDateString(v) ? null : '日期格式須為 YYYY-MM-DD';
  }

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      enabled: enabled,
      onChanged: onChanged,
      keyboardType: TextInputType.datetime,
      decoration: InputDecoration(
        labelText: required ? '$label *' : label,
        hintText: 'YYYY-MM-DD',
        border: const OutlineInputBorder(),
        suffixIcon: IconButton(
          tooltip: '選擇日期',
          icon: const Icon(Icons.calendar_today, size: 18),
          onPressed: !enabled
              ? null
              : () async {
                  final current = DateTime.tryParse(controller.text.trim()) ?? DateTime.now();
                  final picked = await showDatePicker(
                    context: context,
                    initialDate: current,
                    firstDate: DateTime(1970),
                    lastDate: DateTime(2100),
                  );
                  if (picked != null) {
                    controller.text = formatDate(picked);
                    onChanged?.call(controller.text);
                  }
                },
        ),
      ),
      validator: (v) => validate(v, required: required),
    );
  }
}

/// 搜尋並挑選一位員工（指定主管用）。回傳選到的 [EmployeeDto]，取消回 null。
Future<EmployeeDto?> showEmployeePicker(BuildContext context, {String title = '選擇員工'}) {
  return showDialog<EmployeeDto>(
    context: context,
    builder: (_) => _EmployeePickerDialog(title: title),
  );
}

class _EmployeePickerDialog extends ConsumerStatefulWidget {
  const _EmployeePickerDialog({required this.title});
  final String title;

  @override
  ConsumerState<_EmployeePickerDialog> createState() => _EmployeePickerDialogState();
}

class _EmployeePickerDialogState extends ConsumerState<_EmployeePickerDialog> {
  final _keyword = TextEditingController();
  List<EmployeeDto> _results = const [];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void dispose() {
    _keyword.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final json = await ref.read(apiClientProvider).getAdminEmployees(
            q: _keyword.text,
            pageSize: 20,
          );
      if (!mounted) return;
      setState(() {
        _results = EmployeePage.fromJson(json).items.where((e) => !e.isTerminated).toList();
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = adminErrorMessage(e);
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 420,
        height: 360,
        child: Column(
          children: [
            TextField(
              controller: _keyword,
              autofocus: true,
              decoration: InputDecoration(
                labelText: '搜尋編號、姓名或 Email',
                border: const OutlineInputBorder(),
                isDense: true,
                suffixIcon: IconButton(
                  tooltip: '搜尋',
                  icon: const Icon(Icons.search),
                  onPressed: _search,
                ),
              ),
              onSubmitted: (_) => _search(),
            ),
            const SizedBox(height: OideaSpace.space2),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                      ? Center(child: Text(_error!, style: const TextStyle(color: Colors.red)))
                      : _results.isEmpty
                          ? const Center(child: Text('找不到符合的在職員工'))
                          : ListView(
                              children: [
                                for (final e in _results)
                                  ListTile(
                                    dense: true,
                                    title: Text(e.fullName),
                                    subtitle: Text('${e.employeeNo}　${e.departmentName ?? ''}'),
                                    onTap: () => Navigator.pop(context, e),
                                  ),
                              ],
                            ),
            ),
          ],
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消'))],
    );
  }
}
