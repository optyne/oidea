import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/erp_providers.dart';

const Map<String, String> _roleLabels = {
  'owner': '擁有者',
  'admin': '管理員',
  'hr': 'HR（可審核請假、讀出勤）',
  'finance': '財務（可審核／付款報銷）',
  'member': '一般成員',
};

class MembersPage extends ConsumerWidget {
  const MembersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      return const Scaffold(body: Center(child: Text('請先選擇工作空間')));
    }
    final membersAsync = ref.watch(workspaceMembersProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(title: const Text('成員與權限')),
      body: membersAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(message: e.toString()),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyStateWidget(icon: Icons.group, title: '尚無成員');
          }
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(workspaceMembersProvider(workspaceId));
            },
            child: ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (ctx, i) => _MemberTile(
                member: list[i] as Map<String, dynamic>,
                workspaceId: workspaceId,
                onChanged: () => ref.invalidate(workspaceMembersProvider(workspaceId)),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _MemberTile extends ConsumerWidget {
  final Map<String, dynamic> member;
  final String workspaceId;
  final VoidCallback onChanged;

  const _MemberTile({
    required this.member,
    required this.workspaceId,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = member['user'] as Map<String, dynamic>?;
    final role = member['role'] as String? ?? 'member';
    final userId = user?['id'] as String?;

    return ListTile(
      leading: UserAvatar(
        name: user?['displayName'] as String? ?? '?',
        avatarUrl: user?['avatarUrl'] as String?,
      ),
      title: Text(user?['displayName'] as String? ?? ''),
      subtitle: Text('${user?['email'] ?? ''}　・　${_roleLabels[role] ?? role}'),
      trailing: role == 'owner'
          ? const Chip(label: Text('擁有者'))
          : PopupMenuButton<String>(
              onSelected: (newRole) async {
                if (userId == null) return;
                try {
                  await ref.read(apiClientProvider).updateMemberRole(workspaceId, userId, newRole);
                  onChanged();
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context)
                        .showSnackBar(SnackBar(content: Text('更新失敗：$e')));
                  }
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'admin', child: Text('管理員')),
                PopupMenuItem(value: 'hr', child: Text('HR')),
                PopupMenuItem(value: 'finance', child: Text('財務')),
                PopupMenuItem(value: 'member', child: Text('一般成員')),
              ],
            ),
    );
  }
}
