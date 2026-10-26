import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import 'admin_widgets.dart';

/// 離職確認：一定要輸入合法的離職日（`YYYY-MM-DD`）才能按確認。
/// 回傳離職日字串；取消回 null。
Future<String?> showTerminateDialog(BuildContext context, EmployeeDto employee) {
  return showDialog<String>(
    context: context,
    builder: (_) => _TerminateDialog(employee: employee),
  );
}

class _TerminateDialog extends StatefulWidget {
  const _TerminateDialog({required this.employee});
  final EmployeeDto employee;

  @override
  State<_TerminateDialog> createState() => _TerminateDialogState();
}

class _TerminateDialogState extends State<_TerminateDialog> {
  final _date = TextEditingController();

  @override
  void dispose() {
    _date.dispose();
    super.dispose();
  }

  bool get _valid => isValidDateString(_date.text.trim());

  @override
  Widget build(BuildContext context) {
    final e = widget.employee;
    return AlertDialog(
      title: Text('辦理離職：${e.fullName}'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              e.isBound
                  ? '離職後會立即停用此人的登入帳號、登出所有裝置、撤銷他建立的 Bot，並移出所有工作空間。員工資料會保留。'
                  : '此人尚未登入過系統，只會把員工資料標為已離職。',
              style: const TextStyle(fontSize: OideaFontSize.size13),
            ),
            const SizedBox(height: OideaSpace.space4),
            DateTextField(
              controller: _date,
              label: '離職日',
              required: true,
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          style: FilledButton.styleFrom(backgroundColor: Colors.red),
          onPressed: _valid ? () => Navigator.pop(context, _date.text.trim()) : null,
          child: const Text('確認離職'),
        ),
      ],
    );
  }
}

/// CSV 匯入：貼上或選檔 → 預覽（dry-run）→ 確認後正式匯入。成功匯入回傳 true。
Future<bool?> showEmployeeImportDialog(BuildContext context) {
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const EmployeeImportDialog(),
  );
}

class EmployeeImportDialog extends ConsumerStatefulWidget {
  const EmployeeImportDialog({super.key});

  @override
  ConsumerState<EmployeeImportDialog> createState() => _EmployeeImportDialogState();
}

class _EmployeeImportDialogState extends ConsumerState<EmployeeImportDialog> {
  /// 後端限制 1 MB。
  static const _maxBytes = 1024 * 1024;

  final _csv = TextEditingController();
  ImportResult? _preview;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _csv.dispose();
    super.dispose();
  }

  Future<void> _pickFile() async {
    try {
      final res = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: const ['csv', 'txt'],
        withData: true,
      );
      final bytes = res?.files.single.bytes;
      if (bytes == null) return;
      var text = utf8.decode(bytes, allowMalformed: true);
      if (text.startsWith('﻿')) text = text.substring(1);
      if (!mounted) return;
      setState(() {
        _csv.text = text;
        _preview = null;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '讀取檔案失敗，請改用貼上內容');
    }
  }

  bool get _tooLarge => utf8.encode(_csv.text).length > _maxBytes;

  Future<void> _run({required bool dryRun}) async {
    final text = _csv.text;
    if (text.trim().isEmpty) {
      setState(() => _error = '請先貼上或選擇 CSV 內容');
      return;
    }
    if (_tooLarge) {
      setState(() => _error = '內容超過 1 MB，請分批匯入');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final json = await ref.read(apiClientProvider).importEmployees(text, dryRun: dryRun);
      if (!mounted) return;
      final result = ImportResult.fromJson(json);
      if (dryRun) {
        setState(() {
          _preview = result;
          _busy = false;
        });
      } else {
        Navigator.of(context).pop(true);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = adminErrorMessage(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final preview = _preview;
    final canImport = preview != null &&
        preview.errors.isEmpty &&
        (preview.created + preview.updated) > 0 &&
        !_busy;

    return AlertDialog(
      title: const Text('匯入員工 CSV'),
      content: SizedBox(
        width: 560,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                '第一行為欄位名稱。必要欄位：employeeNo, email, fullName, hireDate（YYYY-MM-DD）；'
                '選填：departmentName, jobTitle。先按「預覽」確認結果，沒問題再正式匯入。',
                style: TextStyle(fontSize: OideaFontSize.size12, color: Colors.black54),
              ),
              const SizedBox(height: OideaSpace.space2),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  onPressed: _busy ? null : _pickFile,
                  icon: const Icon(Icons.upload_file, size: 18),
                  label: const Text('選擇 CSV 檔'),
                ),
              ),
              TextField(
                controller: _csv,
                enabled: !_busy,
                minLines: 6,
                maxLines: 10,
                style: const TextStyle(fontFamily: 'monospace', fontSize: OideaFontSize.size12),
                decoration: const InputDecoration(
                  labelText: '或貼上 CSV 內容',
                  alignLabelWithHint: true,
                  border: OutlineInputBorder(),
                ),
                // 內容一改，之前的預覽就不算數了。
                onChanged: (_) => setState(() {
                  _preview = null;
                  _error = null;
                }),
              ),
              if (preview != null) ...[
                const SizedBox(height: OideaSpace.space3),
                _PreviewSummary(result: preview),
              ],
              if (_error != null) ...[
                const SizedBox(height: OideaSpace.space3),
                Text(_error!, style: const TextStyle(color: Colors.red, fontSize: OideaFontSize.size12)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        OutlinedButton(
          onPressed: _busy ? null : () => _run(dryRun: true),
          child: const Text('預覽'),
        ),
        FilledButton(
          onPressed: canImport ? () => _run(dryRun: false) : null,
          child: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('正式匯入'),
        ),
      ],
    );
  }
}

class _PreviewSummary extends StatelessWidget {
  const _PreviewSummary({required this.result});
  final ImportResult result;

  @override
  Widget build(BuildContext context) {
    final hasErrors = result.errors.isNotEmpty;
    return Container(
      padding: const EdgeInsets.all(OideaSpace.space3),
      decoration: BoxDecoration(
        color: hasErrors ? const Color(0xFFFFF4F4) : const Color(0xFFF2F8F2),
        borderRadius: BorderRadius.circular(OideaRadius.md),
        border: Border.all(color: hasErrors ? Colors.red.shade200 : Colors.green.shade200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('預覽結果（尚未寫入）', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: OideaSpace.space1),
          Text('新增 ${result.created} 位　更新 ${result.updated} 位　無變動 ${result.unchanged} 位　錯誤 ${result.errors.length} 行'),
          if (hasErrors) ...[
            const SizedBox(height: OideaSpace.space2),
            const Text('請修正下列錯誤後重新預覽，才能正式匯入：', style: TextStyle(color: Colors.red)),
            for (final e in result.errors.take(50)) Text('第 ${e.line} 行：${e.message}'),
            if (result.errors.length > 50) Text('…還有 ${result.errors.length - 50} 行錯誤'),
          ] else if (result.created + result.updated == 0)
            const Padding(
              padding: EdgeInsets.only(top: OideaSpace.space1),
              child: Text('沒有需要新增或更新的資料。'),
            ),
        ],
      ),
    );
  }
}
