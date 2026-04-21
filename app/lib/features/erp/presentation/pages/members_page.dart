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
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.person_add_alt),
        label: const Text('邀請成員'),
        onPressed: () => _openInviteDialog(context, ref, workspaceId),
      ),
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

  Future<void> _openInviteDialog(BuildContext context, WidgetRef ref, String workspaceId) async {
    final added = await showDialog<bool>(
      context: context,
      builder: (_) => _InviteMemberDialog(workspaceId: workspaceId),
    );
    if (added == true) {
      ref.invalidate(workspaceMembersProvider(workspaceId));
    }
  }
}

class _InviteMemberDialog extends ConsumerStatefulWidget {
  final String workspaceId;
  const _InviteMemberDialog({required this.workspaceId});

  @override
  ConsumerState<_InviteMemberDialog> createState() => _InviteMemberDialogState();
}

class _InviteMemberDialogState extends ConsumerState<_InviteMemberDialog> {
  final _controller = TextEditingController();
  String _role = 'member';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final identifier = _controller.text.trim();
    if (identifier.isEmpty) {
      setState(() => _error = '請填 email 或 username');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).inviteMemberByIdentifier(
            widget.workspaceId,
            identifier: identifier,
            role: _role,
          );
      if (!mounted) return;
      Navigator.of(context).pop(true);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('已加入 $identifier')),
      );
    } catch (e) {
      setState(() {
        _busy = false;
        _error = _prettyError(e.toString());
      });
    }
  }

  String _prettyError(String raw) {
    if (raw.contains('404')) {
      return '找不到這個使用者；請對方先到 https://oidea.oadpiz.com 註冊';
    }
    if (raw.contains('已是成員')) return '此使用者已經在工作空間裡了';
    if (raw.contains('403')) return '權限不足（需 admin 以上才能邀請）';
    return raw;
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('邀請成員'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              '輸入對方的 email 或 username（對方必須已在本站註冊）',
              style: TextStyle(fontSize: 12, color: Colors.black54),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _controller,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Email 或 Username',
                hintText: 'alice@example.com',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.person_search),
              ),
              onSubmitted: (_) => _busy ? null : _submit(),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              value: _role,
              decoration: const InputDecoration(
                labelText: '角色',
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'admin', child: Text('管理員')),
                DropdownMenuItem(value: 'hr', child: Text('HR')),
                DropdownMenuItem(value: 'finance', child: Text('財務')),
                DropdownMenuItem(value: 'member', child: Text('一般成員')),
              ],
              onChanged: _busy ? null : (v) => setState(() => _role = v ?? 'member'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('邀請'),
        ),
      ],
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
