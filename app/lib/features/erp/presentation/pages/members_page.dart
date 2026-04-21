import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
      appBar: AppBar(
        title: const Text('成員與權限'),
        actions: [
          IconButton(
            tooltip: '建立邀請連結',
            icon: const Icon(Icons.link),
            onPressed: () => _openInviteLinkDialog(context, ref, workspaceId),
          ),
        ],
      ),
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

  Future<void> _openInviteLinkDialog(BuildContext context, WidgetRef ref, String workspaceId) async {
    await showDialog<void>(
      context: context,
      builder: (_) => _InviteLinkDialog(workspaceId: workspaceId),
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

/// 以 email / username 直接加入既有使用者（對方必須已註冊）。
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

/// 建立邀請連結對話框：選角色／有效天數 → 產 token → 顯示可複製的完整 URL。
class _InviteLinkDialog extends ConsumerStatefulWidget {
  final String workspaceId;
  const _InviteLinkDialog({required this.workspaceId});

  @override
  ConsumerState<_InviteLinkDialog> createState() => _InviteLinkDialogState();
}

class _InviteLinkDialogState extends ConsumerState<_InviteLinkDialog> {
  String _role = 'member';
  int _days = 7;
  bool _busy = false;
  String? _link;
  String? _error;

  /// 產連結時使用的 base。build 時 bake 進去，讓生產 / 本地可以用不同 base。
  static const _webBase = String.fromEnvironment(
    'WEB_BASE_URL',
    defaultValue: 'https://oidea.oadpiz.com',
  );

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
      _link = null;
    });
    try {
      final res = await ref.read(apiClientProvider).createWorkspaceInvite(
            widget.workspaceId,
            role: _role,
            expiresInDays: _days,
          );
      final token = res['token'] as String?;
      if (token == null) throw Exception('後端未回傳 token');
      setState(() {
        _link = '$_webBase/invite/$token';
        _busy = false;
      });
    } catch (e) {
      setState(() {
        _error = _prettyError(e.toString());
        _busy = false;
      });
    }
  }

  String _prettyError(String raw) {
    if (raw.contains('403')) return '權限不足（需 admin 以上才能建立邀請）';
    return raw;
  }

  Future<void> _copy() async {
    if (_link == null) return;
    await Clipboard.setData(ClipboardData(text: _link!));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('連結已複製')),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('建立邀請連結'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              '任何人拿到連結、登入／註冊後就能加入此工作空間。每條連結只能用一次，可隨時撤銷。',
              style: TextStyle(fontSize: 12, color: Colors.black54),
            ),
            const SizedBox(height: 16),
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
              onChanged: _busy || _link != null ? null : (v) => setState(() => _role = v ?? 'member'),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              value: _days,
              decoration: const InputDecoration(
                labelText: '有效天數',
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 1, child: Text('1 天')),
                DropdownMenuItem(value: 3, child: Text('3 天')),
                DropdownMenuItem(value: 7, child: Text('7 天')),
                DropdownMenuItem(value: 14, child: Text('14 天')),
                DropdownMenuItem(value: 30, child: Text('30 天')),
              ],
              onChanged: _busy || _link != null ? null : (v) => setState(() => _days = v ?? 7),
            ),
            if (_link != null) ...[
              const SizedBox(height: 20),
              const Text(
                '邀請連結（複製給對方）',
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFFF5F5FA),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: const Color(0x1A000000)),
                ),
                child: SelectableText(
                  _link!,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: Colors.red, fontSize: 12)),
            ],
          ],
        ),
      ),
      actions: [
        if (_link == null)
          TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(),
            child: const Text('取消'),
          ),
        if (_link == null)
          FilledButton(
            onPressed: _busy ? null : _create,
            child: _busy
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('產生連結'),
          )
        else ...[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('關閉'),
          ),
          FilledButton.icon(
            onPressed: _copy,
            icon: const Icon(Icons.copy, size: 16),
            label: const Text('複製連結'),
          ),
        ],
      ],
    );
  }
}
