import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../erp/providers/erp_providers.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';
import '../widgets/admin_widgets.dart';

/// 成員與角色（公司工作空間）。需要 `member.role.manage`；
/// 有 `owner.transfer`（只有 owner）才會出現「移交擁有者」。
class RolesPage extends ConsumerWidget {
  const RolesPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(companyMeProvider);
    return me.when(
      loading: () => const Scaffold(body: LoadingWidget()),
      error: (e, _) => Scaffold(
        appBar: AppBar(title: const Text('成員與角色')),
        body: AppErrorWidget(message: adminErrorMessage(e), onRetry: () => ref.invalidate(companyMeProvider)),
      ),
      data: (m) => _RolesBody(workspaceId: m.workspaceId, canTransfer: m.can(AdminPerm.ownerTransfer)),
    );
  }
}

/// 可以指派的角色。owner 不在其中：只能用「移交擁有者」。
const _assignableRoles = ['admin', 'hr', 'finance', 'member'];

class _RolesBody extends ConsumerWidget {
  const _RolesBody({required this.workspaceId, required this.canTransfer});

  final String workspaceId;
  final bool canTransfer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(workspaceMembersProvider(workspaceId));
    return Scaffold(
      appBar: AppBar(
        title: const Text('成員與角色'),
        actions: [
          IconButton(
            tooltip: '重新整理',
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(workspaceMembersProvider(workspaceId)),
          ),
        ],
      ),
      body: async.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(
          message: adminErrorMessage(e),
          onRetry: () => ref.invalidate(workspaceMembersProvider(workspaceId)),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyStateWidget(icon: Icons.group, title: '尚無成員');
          }
          return ListView.separated(
            itemCount: list.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (ctx, i) => _MemberTile(
              member: list[i] as Map<String, dynamic>,
              workspaceId: workspaceId,
              canTransfer: canTransfer,
            ),
          );
        },
      ),
    );
  }
}

enum _MemberAction { admin, hr, finance, member, transfer }

class _MemberTile extends ConsumerWidget {
  const _MemberTile({required this.member, required this.workspaceId, required this.canTransfer});

  final Map<String, dynamic> member;
  final String workspaceId;
  final bool canTransfer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = member['user'] as Map<String, dynamic>?;
    final role = member['role'] as String? ?? 'member';
    final userId = (user?['id'] ?? member['userId']) as String?;
    final name = user?['displayName'] as String? ?? '';

    return ListTile(
      leading: UserAvatar(name: name.isEmpty ? '?' : name, avatarUrl: user?['avatarUrl'] as String?),
      title: Text(name),
      subtitle: Text('${user?['email'] ?? ''}　・　${workspaceRoleLabels[role] ?? role}'),
      trailing: userId == null || role == 'owner'
          ? (role == 'owner' ? const Chip(label: Text('擁有者')) : null)
          : PopupMenuButton<_MemberAction>(
              tooltip: '變更角色',
              onSelected: (a) => _onAction(context, ref, a, userId, name),
              itemBuilder: (_) => [
                for (final r in _assignableRoles)
                  if (r != role)
                    PopupMenuItem(
                      value: _MemberAction.values.byName(r),
                      child: Text('改為${workspaceRoleLabels[r]}'),
                    ),
                if (canTransfer) const PopupMenuItem(value: _MemberAction.transfer, child: Text('移交擁有者給此人')),
              ],
            ),
    );
  }

  Future<void> _onAction(
    BuildContext context,
    WidgetRef ref,
    _MemberAction action,
    String userId,
    String name,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    final api = ref.read(apiClientProvider);
    try {
      if (action == _MemberAction.transfer) {
        final ok = await confirmAction(
          context,
          title: '移交擁有者',
          message: '確定把擁有者身分移交給「$name」？你會改為管理員，且不能自行改回。',
          confirmLabel: '移交',
          destructive: true,
        );
        if (!ok) return;
        await api.transferWorkspaceOwner(workspaceId, userId);
        // 權限變了（自己不再是 owner），一併重抓。
        ref.invalidate(companyMeProvider);
        messenger.showSnackBar(SnackBar(content: Text('已移交擁有者給 $name')));
      } else {
        await api.updateMemberRole(workspaceId, userId, action.name);
        messenger.showSnackBar(SnackBar(content: Text('$name 已改為${workspaceRoleLabels[action.name]}')));
      }
      ref.invalidate(workspaceMembersProvider(workspaceId));
    } catch (e) {
      if (!context.mounted) return;
      await showErrorDialog(context, e);
    }
  }
}
