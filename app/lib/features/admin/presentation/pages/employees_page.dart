import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';
import '../widgets/admin_widgets.dart';
import '../widgets/employee_action_dialogs.dart';
import '../widgets/employee_form_dialog.dart';

/// 員工名冊。`employee.read_all` 可查看；有 `employee.manage` 才會出現新增、編輯、離職等按鈕。
class EmployeesPage extends ConsumerStatefulWidget {
  const EmployeesPage({super.key});

  @override
  ConsumerState<EmployeesPage> createState() => _EmployeesPageState();
}

class _EmployeesPageState extends ConsumerState<EmployeesPage> {
  final _keyword = TextEditingController();

  @override
  void dispose() {
    _keyword.dispose();
    super.dispose();
  }

  void _setQuery(EmployeeQuery Function(EmployeeQuery) f) {
    final notifier = ref.read(employeeQueryProvider.notifier);
    notifier.state = f(notifier.state);
  }

  void _applyKeyword() => _setQuery((q) => q.copyWith(keyword: _keyword.text.trim(), page: 1));

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  /// 執行一個會改資料的動作；失敗用對話框顯示完整訊息。
  Future<void> _perform(Future<void> Function() action, String okMessage) async {
    try {
      await action();
      if (!mounted) return;
      ref.invalidate(employeesProvider);
      _toast(okMessage);
    } catch (e) {
      if (!mounted) return;
      await showErrorDialog(context, e);
    }
  }

  Future<void> _create() async {
    final saved = await showEmployeeFormDialog(context);
    if (saved == true && mounted) {
      ref.invalidate(employeesProvider);
      _toast('已新增員工');
    }
  }

  Future<void> _edit(EmployeeDto e) async {
    final saved = await showEmployeeFormDialog(context, employee: e);
    if (saved == true && mounted) {
      ref.invalidate(employeesProvider);
      _toast('已更新員工資料');
    }
  }

  Future<void> _import() async {
    final done = await showEmployeeImportDialog(context);
    if (done == true && mounted) {
      ref.invalidate(employeesProvider);
      ref.invalidate(departmentsProvider);
      _toast('匯入完成');
    }
  }

  Future<void> _terminate(EmployeeDto e) async {
    final date = await showTerminateDialog(context, e);
    if (date == null || !mounted) return;
    await _perform(
      () => ref.read(apiClientProvider).terminateEmployee(e.id, date),
      '${e.fullName} 已離職',
    );
  }

  Future<void> _reinstate(EmployeeDto e) async {
    final ok = await confirmAction(
      context,
      title: '復職：${e.fullName}',
      message: '會恢復登入資格並把狀態改回在職。下次用 SSO 登入時會自動加回公司工作空間，但不會自動加回其他工作空間。',
      confirmLabel: '確認復職',
    );
    if (!ok || !mounted) return;
    await _perform(() => ref.read(apiClientProvider).reinstateEmployee(e.id), '${e.fullName} 已復職');
  }

  Future<void> _unbind(EmployeeDto e) async {
    final ok = await confirmAction(
      context,
      title: '解除綁定：${e.fullName}',
      message: '會移除這位員工與登入帳號的綁定，並登出該帳號的所有裝置。'
          '用於員工在 Authentik 的帳號識別碼改變的情況；下次登入會重新比對 Email 綁定。',
      confirmLabel: '解除綁定',
      destructive: true,
    );
    if (!ok || !mounted) return;
    await _perform(() => ref.read(apiClientProvider).unbindEmployee(e.id), '已解除綁定');
  }

  @override
  Widget build(BuildContext context) {
    final perms = ref.watch(adminPermissionsProvider);
    final canManage = perms.contains(AdminPerm.employeeManage);
    final query = ref.watch(employeeQueryProvider);
    final async = ref.watch(employeesProvider);
    final departments = ref.watch(departmentsProvider(false)).valueOrNull ?? const <DepartmentDto>[];

    return Scaffold(
      appBar: AppBar(
        title: const Text('員工名冊'),
        actions: [
          if (canManage)
            IconButton(
              tooltip: '匯入 CSV',
              icon: const Icon(Icons.upload_file),
              onPressed: _import,
            ),
          IconButton(
            tooltip: '重新整理',
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(employeesProvider),
          ),
        ],
      ),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              onPressed: _create,
              icon: const Icon(Icons.person_add_alt),
              label: const Text('新增員工'),
            )
          : null,
      body: Column(
        children: [
          _FilterBar(
            keyword: _keyword,
            departments: departments,
            query: query,
            onSubmitKeyword: _applyKeyword,
            onDepartment: (id) => _setQuery((q) => q.copyWith(departmentId: id, page: 1)),
            onStatus: (s) => _setQuery((q) => q.copyWith(status: s, page: 1)),
          ),
          const Divider(height: 1),
          Expanded(
            child: async.when(
              loading: () => const LoadingWidget(),
              error: (e, _) => AppErrorWidget(
                message: adminErrorMessage(e),
                onRetry: () => ref.invalidate(employeesProvider),
              ),
              data: (page) {
                if (page.items.isEmpty) {
                  return const EmptyStateWidget(icon: Icons.badge_outlined, title: '沒有符合條件的員工');
                }
                return _EmployeeTable(
                  employees: page.items,
                  canManage: canManage,
                  onEdit: _edit,
                  onTerminate: _terminate,
                  onReinstate: _reinstate,
                  onUnbind: _unbind,
                );
              },
            ),
          ),
          if (async.valueOrNull != null) ...[
            const Divider(height: 1),
            _Pager(
              page: async.value!,
              onPage: (p) => _setQuery((q) => q.copyWith(page: p)),
            ),
          ],
        ],
      ),
    );
  }
}

class _FilterBar extends StatelessWidget {
  const _FilterBar({
    required this.keyword,
    required this.departments,
    required this.query,
    required this.onSubmitKeyword,
    required this.onDepartment,
    required this.onStatus,
  });

  final TextEditingController keyword;
  final List<DepartmentDto> departments;
  final EmployeeQuery query;
  final VoidCallback onSubmitKeyword;
  final ValueChanged<String?> onDepartment;
  final ValueChanged<String?> onStatus;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(OideaSpace.space3),
      child: Wrap(
        spacing: OideaSpace.space3,
        runSpacing: OideaSpace.space2,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          SizedBox(
            width: 260,
            child: TextField(
              controller: keyword,
              decoration: InputDecoration(
                labelText: '搜尋編號、姓名、Email',
                border: const OutlineInputBorder(),
                isDense: true,
                suffixIcon: IconButton(
                  tooltip: '搜尋',
                  icon: const Icon(Icons.search),
                  onPressed: onSubmitKeyword,
                ),
              ),
              onSubmitted: (_) => onSubmitKeyword(),
            ),
          ),
          SizedBox(
            width: 200,
            child: DropdownButtonFormField<String?>(
              initialValue: query.departmentId,
              isExpanded: true,
              decoration: const InputDecoration(labelText: '部門', border: OutlineInputBorder(), isDense: true),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('全部部門')),
                for (final d in departments) DropdownMenuItem<String?>(value: d.id, child: Text(d.name)),
              ],
              onChanged: onDepartment,
            ),
          ),
          SizedBox(
            width: 160,
            child: DropdownButtonFormField<String?>(
              initialValue: query.status,
              isExpanded: true,
              decoration: const InputDecoration(labelText: '狀態', border: OutlineInputBorder(), isDense: true),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('全部狀態')),
                for (final e in employmentStatusLabels.entries)
                  DropdownMenuItem<String?>(value: e.key, child: Text(e.value)),
              ],
              onChanged: onStatus,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmployeeTable extends StatelessWidget {
  const _EmployeeTable({
    required this.employees,
    required this.canManage,
    required this.onEdit,
    required this.onTerminate,
    required this.onReinstate,
    required this.onUnbind,
  });

  final List<EmployeeDto> employees;
  final bool canManage;
  final void Function(EmployeeDto) onEdit;
  final void Function(EmployeeDto) onTerminate;
  final void Function(EmployeeDto) onReinstate;
  final void Function(EmployeeDto) onUnbind;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: DataTable(
          columnSpacing: 20,
          columns: [
            const DataColumn(label: Text('編號')),
            const DataColumn(label: Text('姓名')),
            const DataColumn(label: Text('Email')),
            const DataColumn(label: Text('部門')),
            const DataColumn(label: Text('職稱')),
            const DataColumn(label: Text('狀態')),
            const DataColumn(label: Text('到職日')),
            const DataColumn(label: Text('登入帳號')),
            if (canManage) const DataColumn(label: Text('操作')),
          ],
          rows: [
            for (final e in employees)
              DataRow(cells: [
                DataCell(Text(e.employeeNo)),
                DataCell(Text(e.fullName)),
                DataCell(Text(e.email)),
                DataCell(Text(e.departmentName ?? '—')),
                DataCell(Text(e.jobTitle.isEmpty ? '—' : e.jobTitle)),
                DataCell(_StatusChip(employee: e)),
                DataCell(Text(e.hireDate ?? '—')),
                DataCell(Text(e.isBound ? (e.disabled ? '已停用' : '已綁定') : '尚未登入')),
                if (canManage)
                  DataCell(_RowMenu(
                    employee: e,
                    onEdit: onEdit,
                    onTerminate: onTerminate,
                    onReinstate: onReinstate,
                    onUnbind: onUnbind,
                  )),
              ]),
          ],
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.employee});
  final EmployeeDto employee;

  @override
  Widget build(BuildContext context) {
    final label = employmentStatusLabels[employee.employmentStatus] ?? employee.employmentStatus;
    final text = employee.isTerminated && employee.terminationDate != null
        ? '$label（${employee.terminationDate}）'
        : label;
    final color = switch (employee.employmentStatus) {
      'terminated' => Colors.red,
      'on_leave' => Colors.orange,
      _ => Colors.green,
    };
    return Text(text, style: TextStyle(color: color, fontWeight: FontWeight.w500));
  }
}

enum _RowAction { edit, terminate, reinstate, unbind }

class _RowMenu extends StatelessWidget {
  const _RowMenu({
    required this.employee,
    required this.onEdit,
    required this.onTerminate,
    required this.onReinstate,
    required this.onUnbind,
  });

  final EmployeeDto employee;
  final void Function(EmployeeDto) onEdit;
  final void Function(EmployeeDto) onTerminate;
  final void Function(EmployeeDto) onReinstate;
  final void Function(EmployeeDto) onUnbind;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<_RowAction>(
      tooltip: '操作',
      icon: const Icon(Icons.more_horiz),
      onSelected: (a) {
        switch (a) {
          case _RowAction.edit:
            onEdit(employee);
          case _RowAction.terminate:
            onTerminate(employee);
          case _RowAction.reinstate:
            onReinstate(employee);
          case _RowAction.unbind:
            onUnbind(employee);
        }
      },
      itemBuilder: (_) => [
        const PopupMenuItem(value: _RowAction.edit, child: Text('編輯')),
        if (!employee.isTerminated) const PopupMenuItem(value: _RowAction.terminate, child: Text('離職')),
        if (employee.isTerminated) const PopupMenuItem(value: _RowAction.reinstate, child: Text('復職')),
        if (employee.isBound) const PopupMenuItem(value: _RowAction.unbind, child: Text('解除綁定')),
      ],
    );
  }
}

class _Pager extends StatelessWidget {
  const _Pager({required this.page, required this.onPage});
  final EmployeePage page;
  final ValueChanged<int> onPage;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: OideaSpace.space3, vertical: OideaSpace.space1),
      child: Row(
        children: [
          Text('共 ${page.total} 位'),
          const Spacer(),
          IconButton(
            tooltip: '上一頁',
            icon: const Icon(Icons.chevron_left),
            onPressed: page.page > 1 ? () => onPage(page.page - 1) : null,
          ),
          Text('第 ${page.page} / ${page.pageCount} 頁'),
          IconButton(
            tooltip: '下一頁',
            icon: const Icon(Icons.chevron_right),
            onPressed: page.page < page.pageCount ? () => onPage(page.page + 1) : null,
          ),
        ],
      ),
    );
  }
}
