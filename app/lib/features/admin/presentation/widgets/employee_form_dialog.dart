import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';
import 'admin_widgets.dart';

/// 新增（[employee] 為 null）或編輯員工。儲存成功回傳 true。
Future<bool?> showEmployeeFormDialog(BuildContext context, {EmployeeDto? employee}) {
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => EmployeeFormDialog(employee: employee),
  );
}

class EmployeeFormDialog extends ConsumerStatefulWidget {
  const EmployeeFormDialog({super.key, this.employee});
  final EmployeeDto? employee;

  @override
  ConsumerState<EmployeeFormDialog> createState() => _EmployeeFormDialogState();
}

class _EmployeeFormDialogState extends ConsumerState<EmployeeFormDialog> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _no;
  late final TextEditingController _name;
  late final TextEditingController _email;
  late final TextEditingController _hire;
  late final TextEditingController _title;
  late final TextEditingController _phone;
  late String _type;
  late String _status;
  String? _departmentId;
  String? _managerId;
  String? _managerName;
  bool _busy = false;
  String? _error;

  EmployeeDto? get _e => widget.employee;
  bool get _isEdit => _e != null;

  @override
  void initState() {
    super.initState();
    final e = _e;
    _no = TextEditingController(text: e?.employeeNo ?? '');
    _name = TextEditingController(text: e?.fullName ?? '');
    _email = TextEditingController(text: e?.email ?? '');
    _hire = TextEditingController(text: e?.hireDate ?? '');
    _title = TextEditingController(text: e?.jobTitle ?? '');
    _phone = TextEditingController(text: e?.phone ?? '');
    _type = e?.employmentType ?? 'full_time';
    _status = e?.employmentStatus == 'on_leave' ? 'on_leave' : 'active';
    _departmentId = e?.departmentId;
    _managerId = e?.managerProfileId;
    _managerName = e?.managerName;
  }

  @override
  void dispose() {
    _no.dispose();
    _name.dispose();
    _email.dispose();
    _hire.dispose();
    _title.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _pickManager() async {
    final picked = await showEmployeePicker(context, title: '選擇直屬主管');
    if (picked == null || !mounted) return;
    setState(() {
      _managerId = picked.id;
      _managerName = picked.fullName;
    });
  }

  /// 新增送完整欄位；編輯只送有變動的欄位（已綁定的員工不能改 Email，沒改就不送）。
  Map<String, dynamic> _buildBody() {
    final e = _e;
    final no = _no.text.trim();
    final name = _name.text.trim();
    final email = _email.text.trim().toLowerCase();
    final hire = _hire.text.trim();
    final title = _title.text.trim();
    final phone = _phone.text.trim();

    if (e == null) {
      // 新增：必填欄位一定送，選填欄位沒填就不送。
      return {
        'employeeNo': no,
        'email': email,
        'fullName': name,
        'hireDate': hire,
        'employmentType': _type,
        if (_departmentId != null) 'departmentId': _departmentId,
        if (title.isNotEmpty) 'jobTitle': title,
        if (_managerId != null) 'managerProfileId': _managerId,
        if (phone.isNotEmpty) 'phone': phone,
      };
    }

    // 編輯：只送有變動的欄位；清掉部門／主管時送 null。
    final body = <String, dynamic>{};
    if (no != e.employeeNo) body['employeeNo'] = no;
    if (name != e.fullName) body['fullName'] = name;
    if (email != e.email.toLowerCase()) body['email'] = email;
    if (hire != (e.hireDate ?? '')) body['hireDate'] = hire;
    if (_departmentId != e.departmentId) body['departmentId'] = _departmentId;
    if (title != e.jobTitle) body['jobTitle'] = title;
    if (_managerId != e.managerProfileId) body['managerProfileId'] = _managerId;
    if (_type != e.employmentType) body['employmentType'] = _type;
    if (phone != e.phone) body['phone'] = phone;
    if (!e.isTerminated && _status != e.employmentStatus) body['employmentStatus'] = _status;
    return body;
  }

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final body = _buildBody();
    if (_isEdit && body.isEmpty) {
      Navigator.of(context).pop(false);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      if (_isEdit) {
        await api.updateAdminEmployee(_e!.id, body);
      } else {
        await api.createAdminEmployee(body);
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = adminErrorMessage(err);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final departments = ref.watch(departmentsProvider(false)).valueOrNull ?? const <DepartmentDto>[];
    // 員工目前掛在已封存的部門時，清單裡找不到它；補一個選項避免 Dropdown 報錯。
    final deptItems = [
      const DropdownMenuItem<String?>(value: null, child: Text('（未指定）')),
      for (final d in departments) DropdownMenuItem<String?>(value: d.id, child: Text(d.name)),
      if (_departmentId != null && !departments.any((d) => d.id == _departmentId))
        DropdownMenuItem<String?>(value: _departmentId, child: Text(_e?.departmentName ?? '（已封存的部門）')),
    ];
    final emailLocked = _isEdit && _e!.isBound;

    return AlertDialog(
      title: Text(_isEdit ? '編輯員工' : '新增員工'),
      content: SizedBox(
        width: 460,
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _no,
                  decoration: const InputDecoration(labelText: '員工編號 *', border: OutlineInputBorder()),
                  validator: (v) => (v ?? '').trim().isEmpty ? '必填' : null,
                ),
                const SizedBox(height: OideaSpace.space3),
                TextFormField(
                  controller: _name,
                  decoration: const InputDecoration(labelText: '姓名 *', border: OutlineInputBorder()),
                  validator: (v) => (v ?? '').trim().isEmpty ? '必填' : null,
                ),
                const SizedBox(height: OideaSpace.space3),
                TextFormField(
                  controller: _email,
                  enabled: !emailLocked,
                  keyboardType: TextInputType.emailAddress,
                  decoration: InputDecoration(
                    labelText: 'Email *',
                    border: const OutlineInputBorder(),
                    helperText: emailLocked ? '已綁定登入帳號，要改 Email 請先解除綁定' : null,
                  ),
                  validator: (v) {
                    final s = (v ?? '').trim();
                    if (s.isEmpty) return '必填';
                    return isValidEmail(s) ? null : 'Email 格式不正確';
                  },
                ),
                const SizedBox(height: OideaSpace.space3),
                DateTextField(controller: _hire, label: '到職日', required: true),
                const SizedBox(height: OideaSpace.space3),
                DropdownButtonFormField<String?>(
                  initialValue: _departmentId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '部門', border: OutlineInputBorder()),
                  items: deptItems,
                  onChanged: _busy ? null : (v) => setState(() => _departmentId = v),
                ),
                const SizedBox(height: OideaSpace.space3),
                TextFormField(
                  controller: _title,
                  decoration: const InputDecoration(labelText: '職稱', border: OutlineInputBorder()),
                ),
                const SizedBox(height: OideaSpace.space3),
                InputDecorator(
                  decoration: const InputDecoration(labelText: '直屬主管', border: OutlineInputBorder()),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          _managerId == null ? '（依部門主管）' : (_managerName ?? _managerId!),
                        ),
                      ),
                      TextButton(onPressed: _busy ? null : _pickManager, child: const Text('選擇')),
                      if (_managerId != null)
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => setState(() {
                                    _managerId = null;
                                    _managerName = null;
                                  }),
                          child: const Text('清除'),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: OideaSpace.space3),
                DropdownButtonFormField<String>(
                  initialValue: _type,
                  decoration: const InputDecoration(labelText: '僱用類型', border: OutlineInputBorder()),
                  items: [
                    for (final e in employmentTypeLabels.entries)
                      DropdownMenuItem(value: e.key, child: Text(e.value)),
                  ],
                  onChanged: _busy ? null : (v) => setState(() => _type = v ?? 'full_time'),
                ),
                if (_isEdit && !_e!.isTerminated) ...[
                  const SizedBox(height: OideaSpace.space3),
                  DropdownButtonFormField<String>(
                    initialValue: _status,
                    decoration: const InputDecoration(labelText: '在職狀態', border: OutlineInputBorder()),
                    items: const [
                      DropdownMenuItem(value: 'active', child: Text('在職')),
                      DropdownMenuItem(value: 'on_leave', child: Text('留職停薪')),
                    ],
                    onChanged: _busy ? null : (v) => setState(() => _status = v ?? 'active'),
                  ),
                ],
                const SizedBox(height: OideaSpace.space3),
                TextFormField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: '電話', border: OutlineInputBorder()),
                ),
                if (_error != null) ...[
                  const SizedBox(height: OideaSpace.space3),
                  Text(_error!, style: const TextStyle(color: Colors.red, fontSize: OideaFontSize.size12)),
                ],
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('儲存'),
        ),
      ],
    );
  }
}
