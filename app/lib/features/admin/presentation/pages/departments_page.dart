import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';
import '../widgets/admin_widgets.dart';

final _showArchivedProvider = StateProvider.autoDispose<bool>((ref) => false);

/// 部門樹。`employee.read_all` 可查看；有 `department.manage` 才有新增、改名、移動、封存、刪除。
class DepartmentsPage extends ConsumerWidget {
  const DepartmentsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = ref.watch(adminPermissionsProvider).contains(AdminPerm.departmentManage);
    final showArchived = ref.watch(_showArchivedProvider);
    final async = ref.watch(departmentsProvider(showArchived));

    return Scaffold(
      appBar: AppBar(
        title: const Text('部門'),
        actions: [
          Row(
            children: [
              const Text('顯示已封存', style: TextStyle(fontSize: OideaFontSize.size13)),
              Switch(
                value: showArchived,
                onChanged: (v) => ref.read(_showArchivedProvider.notifier).state = v,
              ),
            ],
          ),
          IconButton(
            tooltip: '重新整理',
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(departmentsProvider),
          ),
        ],
      ),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              onPressed: () => _createDept(context, ref, parent: null),
              icon: const Icon(Icons.add),
              label: const Text('新增根部門'),
            )
          : null,
      body: async.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(
          message: adminErrorMessage(e),
          onRetry: () => ref.invalidate(departmentsProvider),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyStateWidget(icon: Icons.account_tree_outlined, title: '還沒有部門');
          }
          final rows = <_FlatRow>[];
          void walk(List<DepartmentNode> nodes, int depth) {
            for (final n in nodes) {
              rows.add(_FlatRow(n.dept, depth));
              walk(n.children, depth + 1);
            }
          }

          walk(buildDepartmentTree(list), 0);
          return ListView.separated(
            padding: const EdgeInsets.only(bottom: 88),
            itemCount: rows.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (ctx, i) => _DepartmentTile(
              row: rows[i],
              all: list,
              canManage: canManage,
            ),
          );
        },
      ),
    );
  }
}

class _FlatRow {
  const _FlatRow(this.dept, this.depth);
  final DepartmentDto dept;
  final int depth;
}

enum _DeptAction { addChild, rename, move, setManager, clearManager, archive, unarchive, delete }

class _DepartmentTile extends ConsumerWidget {
  const _DepartmentTile({required this.row, required this.all, required this.canManage});

  final _FlatRow row;
  final List<DepartmentDto> all;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final d = row.dept;
    final details = <String>[
      if (d.managerName != null) '主管：${d.managerName}' else '未指定主管',
      '成員 ${d.memberCount}',
      if (d.childCount > 0) '子部門 ${d.childCount}',
    ];
    return ListTile(
      contentPadding: EdgeInsets.only(left: OideaSpace.space4 + row.depth * 24.0, right: OideaSpace.space2),
      leading: Icon(
        row.depth == 0 ? Icons.apartment : Icons.subdirectory_arrow_right,
        color: d.isArchived ? Colors.grey : null,
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              d.name,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontWeight: FontWeight.w600,
                color: d.isArchived ? Colors.grey : null,
              ),
            ),
          ),
          if (d.isArchived) ...[
            const SizedBox(width: OideaSpace.space2),
            const Chip(label: Text('已封存'), visualDensity: VisualDensity.compact),
          ],
        ],
      ),
      subtitle: Text(details.join('　・　')),
      trailing: canManage
          ? PopupMenuButton<_DeptAction>(
              tooltip: '操作',
              onSelected: (a) => _onAction(context, ref, a),
              itemBuilder: (_) => [
                if (!d.isArchived) const PopupMenuItem(value: _DeptAction.addChild, child: Text('新增子部門')),
                const PopupMenuItem(value: _DeptAction.rename, child: Text('重新命名')),
                const PopupMenuItem(value: _DeptAction.move, child: Text('移動到…')),
                const PopupMenuItem(value: _DeptAction.setManager, child: Text('指定主管')),
                if (d.managerProfileId != null)
                  const PopupMenuItem(value: _DeptAction.clearManager, child: Text('清除主管')),
                if (d.isArchived)
                  const PopupMenuItem(value: _DeptAction.unarchive, child: Text('取消封存'))
                else
                  const PopupMenuItem(value: _DeptAction.archive, child: Text('封存')),
                const PopupMenuItem(value: _DeptAction.delete, child: Text('刪除')),
              ],
            )
          : null,
    );
  }

  Future<void> _onAction(BuildContext context, WidgetRef ref, _DeptAction a) async {
    final d = row.dept;
    switch (a) {
      case _DeptAction.addChild:
        await _createDept(context, ref, parent: d);
      case _DeptAction.rename:
        final name = await _askName(context, title: '重新命名', initial: d.name);
        if (name == null || name == d.name || !context.mounted) return;
        await _run(context, ref, () => ref.read(apiClientProvider).updateDepartment(d.id, {'name': name}), '已重新命名');
      case _DeptAction.move:
        final choice = await showDialog<_MoveChoice>(
          context: context,
          builder: (_) => _MoveDialog(dept: d, all: all),
        );
        if (choice == null || !context.mounted) return;
        await _run(
          context,
          ref,
          () => ref.read(apiClientProvider).updateDepartment(d.id, {'parentId': choice.parentId}),
          '已移動部門',
        );
      case _DeptAction.setManager:
        final picked = await showEmployeePicker(context, title: '指定「${d.name}」的主管');
        if (picked == null || !context.mounted) return;
        await _run(
          context,
          ref,
          () => ref.read(apiClientProvider).updateDepartment(d.id, {'managerProfileId': picked.id}),
          '已指定主管：${picked.fullName}',
        );
      case _DeptAction.clearManager:
        await _run(
          context,
          ref,
          () => ref.read(apiClientProvider).updateDepartment(d.id, {'managerProfileId': null}),
          '已清除主管',
        );
      case _DeptAction.archive:
        final ok = await confirmAction(
          context,
          title: '封存：${d.name}',
          message: '封存後不能再把員工指派到這個部門，既有成員不受影響。之後可以取消封存。',
          confirmLabel: '封存',
        );
        if (!ok || !context.mounted) return;
        await _run(context, ref, () => ref.read(apiClientProvider).archiveDepartment(d.id), '已封存');
      case _DeptAction.unarchive:
        await _run(context, ref, () => ref.read(apiClientProvider).unarchiveDepartment(d.id), '已取消封存');
      case _DeptAction.delete:
        final ok = await confirmAction(
          context,
          title: '刪除：${d.name}',
          message: '刪除後無法復原。只有完全沒有員工（含已離職）與子部門的部門才能刪除，否則請改用封存。',
          confirmLabel: '刪除',
          destructive: true,
        );
        if (!ok || !context.mounted) return;
        await _run(context, ref, () => ref.read(apiClientProvider).deleteDepartment(d.id), '已刪除');
    }
  }
}

Future<void> _run(
  BuildContext context,
  WidgetRef ref,
  Future<Object?> Function() action,
  String okMessage,
) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await action();
    ref.invalidate(departmentsProvider);
    messenger.showSnackBar(SnackBar(content: Text(okMessage)));
  } catch (e) {
    if (!context.mounted) return;
    // 例如 409 department_not_empty：把後端的原因完整顯示出來。
    await showErrorDialog(context, e);
  }
}

Future<void> _createDept(BuildContext context, WidgetRef ref, {required DepartmentDto? parent}) async {
  final name = await _askName(
    context,
    title: parent == null ? '新增根部門' : '在「${parent.name}」底下新增部門',
  );
  if (name == null || !context.mounted) return;
  await _run(
    context,
    ref,
    () => ref.read(apiClientProvider).createDepartment({
      'name': name,
      if (parent != null) 'parentId': parent.id,
    }),
    '已新增部門',
  );
}

Future<String?> _askName(BuildContext context, {required String title, String initial = ''}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _NameDialog(title: title, initial: initial),
  );
}

class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.title, required this.initial});
  final String title;
  final String initial;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final TextEditingController _c = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _submit() {
    final v = _c.text.trim();
    if (v.isNotEmpty) Navigator.pop(context, v);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _c,
        autofocus: true,
        decoration: const InputDecoration(labelText: '部門名稱', border: OutlineInputBorder()),
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: _c.text.trim().isEmpty ? null : _submit, child: const Text('確定')),
      ],
    );
  }
}

class _MoveChoice {
  const _MoveChoice(this.parentId);
  final String? parentId;
}

/// 選新的上層部門。自己與所有子孫都不能選（會形成循環）；根層可選。
class _MoveDialog extends StatefulWidget {
  const _MoveDialog({required this.dept, required this.all});
  final DepartmentDto dept;
  final List<DepartmentDto> all;

  @override
  State<_MoveDialog> createState() => _MoveDialogState();
}

class _MoveDialogState extends State<_MoveDialog> {
  late String? _parentId = widget.dept.parentId;

  @override
  Widget build(BuildContext context) {
    final blocked = departmentSubtreeIds(widget.all, widget.dept.id);
    final candidates = <_FlatRow>[];
    void walk(List<DepartmentNode> nodes, int depth) {
      for (final n in nodes) {
        if (blocked.contains(n.dept.id) || n.dept.isArchived) continue;
        candidates.add(_FlatRow(n.dept, depth));
        walk(n.children, depth + 1);
      }
    }

    walk(buildDepartmentTree(widget.all), 0);

    return AlertDialog(
      title: Text('移動「${widget.dept.name}」'),
      content: SizedBox(
        width: 380,
        height: 360,
        child: ListView(
          children: [
            ListTile(
              dense: true,
              selected: _parentId == null,
              leading: const Icon(Icons.home_work_outlined),
              title: const Text('（根層）'),
              trailing: _parentId == null ? const Icon(Icons.check) : null,
              onTap: () => setState(() => _parentId = null),
            ),
            for (final r in candidates)
              ListTile(
                dense: true,
                selected: _parentId == r.dept.id,
                contentPadding: EdgeInsets.only(left: OideaSpace.space4 + r.depth * 16.0, right: OideaSpace.space4),
                title: Text(r.dept.name),
                trailing: _parentId == r.dept.id ? const Icon(Icons.check) : null,
                onTap: () => setState(() => _parentId = r.dept.id),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _parentId == widget.dept.parentId ? null : () => Navigator.pop(context, _MoveChoice(_parentId)),
          child: const Text('移動'),
        ),
      ],
    );
  }
}
