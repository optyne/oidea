import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';

/// 頁面分享對話框：切換 visibility、繼承開關、維護成員與角色的 permission 清單。
///
/// 需要 full access 的所有寫入動作若被後端拒，會 SnackBar 顯示錯誤；view 也能開啟對話框
/// 觀看分享清單（後端 list 端點只要 view 就給，寫入才擋）。
class SharePageDialog extends ConsumerStatefulWidget {
  final String pageId;
  final String workspaceId;
  final String pageTitle;

  const SharePageDialog({
    super.key,
    required this.pageId,
    required this.workspaceId,
    required this.pageTitle,
  });

  @override
  ConsumerState<SharePageDialog> createState() => _SharePageDialogState();
}

class _SharePageDialogState extends ConsumerState<SharePageDialog> {
  static const _visibilityOptions = [
    ('workspace', '工作空間', '所有成員預設可編輯'),
    ('private', '私人', '只有你與明確分享對象'),
    ('restricted', '限制', '無預設權限，需要逐一分享'),
  ];

  static const _roles = [
    ('admin', '管理員'),
    ('hr', '人資'),
    ('finance', '財務'),
    ('member', '一般成員'),
  ];

  String _visibility = 'workspace';
  bool _inheritParentAcl = true;
  List<dynamic> _permissions = [];
  List<dynamic> _members = [];
  bool _loading = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final results = await Future.wait([
        api.getKnowledgePage(widget.pageId),
        api.listPagePermissions(widget.pageId),
        api.getWorkspaceMembers(widget.workspaceId),
      ]);
      final page = results[0] as Map<String, dynamic>;
      setState(() {
        _visibility = (page['visibility'] as String?) ?? 'workspace';
        _inheritParentAcl = (page['inheritParentAcl'] as bool?) ?? true;
        _permissions = results[1] as List<dynamic>;
        _members = results[2] as List<dynamic>;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _setVisibility(String v) async {
    if (_busy || v == _visibility) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).updatePageVisibility(
            widget.pageId,
            visibility: v,
            inheritParentAcl: _inheritParentAcl,
          );
      setState(() => _visibility = v);
      _snack('已更新可見性');
    } catch (e) {
      _snack('更新失敗：$e', isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setInherit(bool v) async {
    if (_busy || v == _inheritParentAcl) return;
    setState(() => _busy = true);
    try {
      await ref.read(apiClientProvider).updatePageVisibility(
            widget.pageId,
            visibility: _visibility,
            inheritParentAcl: v,
          );
      setState(() => _inheritParentAcl = v);
    } catch (e) {
      _snack('更新失敗：$e', isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addPermission() async {
    final result = await showDialog<_NewPermission>(
      context: context,
      builder: (_) => _AddPermissionDialog(members: _members, roles: _roles),
    );
    if (result == null) return;
    setState(() => _busy = true);
    try {
      final api = ref.read(apiClientProvider);
      await api.sharePage(
        widget.pageId,
        userId: result.userId,
        role: result.role,
        access: result.access,
      );
      _permissions = await api.listPagePermissions(widget.pageId);
      _snack('已新增分享');
    } catch (e) {
      _snack('新增失敗：$e', isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _removePermission(String permId) async {
    setState(() => _busy = true);
    try {
      final api = ref.read(apiClientProvider);
      await api.removePagePermission(widget.pageId, permId);
      _permissions = await api.listPagePermissions(widget.pageId);
      _snack('已移除');
    } catch (e) {
      _snack('移除失敗：$e', isError: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String msg, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg),
        backgroundColor: isError ? Colors.red : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 36),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 540, maxHeight: 640),
        child: _loading
            ? const SizedBox(height: 240, child: Center(child: CircularProgressIndicator()))
            : _error != null
                ? _ErrorBody(message: _error!, onRetry: _load)
                : _buildContent(context),
      ),
    );
  }

  Widget _buildContent(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '分享「${widget.pageTitle}」',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Flexible(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const _SectionLabel('可見性'),
                const SizedBox(height: 8),
                for (final opt in _visibilityOptions)
                  _VisibilityTile(
                    label: opt.$2,
                    hint: opt.$3,
                    selected: _visibility == opt.$1,
                    onTap: _busy ? null : () => _setVisibility(opt.$1),
                  ),
                const SizedBox(height: 12),
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  value: _inheritParentAcl,
                  onChanged: _busy ? null : _setInherit,
                  title: const Text('繼承父頁權限'),
                  subtitle: const Text('本頁沒有自己的分享時，採用父頁的設定'),
                ),
                const Divider(height: 32),
                Row(
                  children: [
                    const Expanded(child: _SectionLabel('分享清單')),
                    TextButton.icon(
                      onPressed: _busy ? null : _addPermission,
                      icon: const Icon(Icons.person_add_alt),
                      label: const Text('新增'),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                if (_permissions.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      _visibility == 'workspace'
                          ? '目前由 "工作空間" 預設授權所有成員 edit。'
                          : '尚未分享給任何成員。',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  )
                else
                  ..._permissions.map((p) {
                    final perm = p as Map<String, dynamic>;
                    return _PermissionTile(
                      perm: perm,
                      onRemove: _busy ? null : () => _removePermission(perm['id'] as String),
                    );
                  }),
              ],
            ),
          ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 10, 20, 14),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('關閉')),
            ],
          ),
        ),
      ],
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String label;
  const _SectionLabel(this.label);

  @override
  Widget build(BuildContext context) => Text(
        label,
        style: Theme.of(context).textTheme.labelLarge?.copyWith(fontWeight: FontWeight.w700),
      );
}

class _VisibilityTile extends StatelessWidget {
  final String label;
  final String hint;
  final bool selected;
  final VoidCallback? onTap;

  const _VisibilityTile({
    required this.label,
    required this.hint,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: selected ? theme.colorScheme.primary.withValues(alpha: 0.1) : null,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: selected ? theme.colorScheme.primary : theme.dividerColor,
          ),
        ),
        child: Row(
          children: [
            Icon(
              selected ? Icons.radio_button_checked : Icons.radio_button_off,
              color: selected ? theme.colorScheme.primary : theme.disabledColor,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: theme.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600)),
                  Text(hint, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PermissionTile extends StatelessWidget {
  final Map<String, dynamic> perm;
  final VoidCallback? onRemove;

  const _PermissionTile({required this.perm, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    final user = perm['user'] as Map<String, dynamic>?;
    final role = perm['role'] as String?;
    final access = perm['access'] as String? ?? 'view';
    final title = user != null
        ? (user['displayName'] as String? ?? '使用者')
        : (_roleLabel(role) ?? '未知角色');
    final subtitle = user != null ? '個人' : '角色';

    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      leading: CircleAvatar(
        backgroundImage: user?['avatarUrl'] != null && (user?['avatarUrl'] as String).isNotEmpty
            ? NetworkImage(user!['avatarUrl'] as String)
            : null,
        child: user?['avatarUrl'] == null || (user?['avatarUrl'] as String).isEmpty
            ? Text(_initials(title))
            : null,
      ),
      title: Text(title),
      subtitle: Text('$subtitle · ${_accessLabel(access)}'),
      trailing: onRemove == null
          ? null
          : IconButton(
              tooltip: '移除',
              onPressed: onRemove,
              icon: const Icon(Icons.close),
            ),
    );
  }

  String _initials(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return '?';
    return trimmed.characters.take(1).toString().toUpperCase();
  }

  static String? _roleLabel(String? role) {
    switch (role) {
      case 'admin':
        return '管理員';
      case 'hr':
        return '人資';
      case 'finance':
        return '財務';
      case 'member':
        return '一般成員';
      default:
        return role;
    }
  }

  static String _accessLabel(String access) {
    switch (access) {
      case 'view':
        return '檢視';
      case 'edit':
        return '編輯';
      case 'full':
        return '完整';
      default:
        return access;
    }
  }
}

class _ErrorBody extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorBody({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, color: Colors.red, size: 40),
          const SizedBox(height: 12),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          OutlinedButton(onPressed: onRetry, child: const Text('重試')),
        ],
      ),
    );
  }
}

// ─────────────────── 新增一條分享的子對話框 ───────────────────

class _NewPermission {
  final String? userId;
  final String? role;
  final String access;
  _NewPermission.user(this.userId, this.access) : role = null;
  _NewPermission.role(this.role, this.access) : userId = null;
}

class _AddPermissionDialog extends StatefulWidget {
  final List<dynamic> members;
  final List<(String, String)> roles;

  const _AddPermissionDialog({required this.members, required this.roles});

  @override
  State<_AddPermissionDialog> createState() => _AddPermissionDialogState();
}

class _AddPermissionDialogState extends State<_AddPermissionDialog> {
  String _target = 'user'; // user | role
  String? _userId;
  String? _role;
  String _access = 'view';

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('新增分享'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'user', label: Text('指定成員')),
                ButtonSegment(value: 'role', label: Text('指定角色')),
              ],
              selected: {_target},
              onSelectionChanged: (s) => setState(() {
                _target = s.first;
                _userId = null;
                _role = null;
              }),
            ),
            const SizedBox(height: 16),
            if (_target == 'user')
              DropdownButtonFormField<String>(
                value: _userId,
                decoration: const InputDecoration(labelText: '成員', border: OutlineInputBorder()),
                items: widget.members.map((m) {
                  final member = m as Map<String, dynamic>;
                  final user = member['user'] as Map<String, dynamic>?;
                  final id = user?['id'] as String? ?? member['userId'] as String;
                  final name = user?['displayName'] as String? ?? id;
                  return DropdownMenuItem(value: id, child: Text(name));
                }).toList(),
                onChanged: (v) => setState(() => _userId = v),
              )
            else
              DropdownButtonFormField<String>(
                value: _role,
                decoration: const InputDecoration(labelText: '角色', border: OutlineInputBorder()),
                items: widget.roles
                    .map((r) => DropdownMenuItem(value: r.$1, child: Text(r.$2)))
                    .toList(),
                onChanged: (v) => setState(() => _role = v),
              ),
            const SizedBox(height: 14),
            DropdownButtonFormField<String>(
              value: _access,
              decoration: const InputDecoration(labelText: '存取層級', border: OutlineInputBorder()),
              items: const [
                DropdownMenuItem(value: 'view', child: Text('檢視')),
                DropdownMenuItem(value: 'edit', child: Text('編輯')),
                DropdownMenuItem(value: 'full', child: Text('完整')),
              ],
              onChanged: (v) => setState(() => _access = v ?? 'view'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(
          onPressed: _canConfirm()
              ? () => Navigator.pop(
                    context,
                    _target == 'user'
                        ? _NewPermission.user(_userId, _access)
                        : _NewPermission.role(_role, _access),
                  )
              : null,
          child: const Text('新增'),
        ),
      ],
    );
  }

  bool _canConfirm() => _target == 'user' ? _userId != null : _role != null;
}
