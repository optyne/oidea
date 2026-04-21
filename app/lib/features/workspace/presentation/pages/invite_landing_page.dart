import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/network/api_client.dart';
import '../../../auth/providers/auth_provider.dart';
import '../../providers/workspace_provider.dart';

/// 使用者點開 /invite/:token 時的 landing page。
///
/// 三種狀態：
/// 1. 未登入 → 顯示工作空間資訊 + 「登入／註冊後接受邀請」按鈕
/// 2. 已登入 → 顯示「加入 {workspace} 作為 {role}」按鈕
/// 3. 邀請過期 / 已用過 → 顯示錯誤訊息
class InviteLandingPage extends ConsumerStatefulWidget {
  final String token;
  const InviteLandingPage({super.key, required this.token});

  @override
  ConsumerState<InviteLandingPage> createState() => _InviteLandingPageState();
}

class _InviteLandingPageState extends ConsumerState<InviteLandingPage> {
  Map<String, dynamic>? _invite;
  String? _error;
  bool _busy = false;
  String? _successMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final data = await ref.read(apiClientProvider).peekInvite(widget.token);
      if (!mounted) return;
      setState(() {
        _invite = data;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _prettyError(e.toString());
        _busy = false;
      });
    }
  }

  Future<void> _accept() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).acceptInvite(widget.token);
      if (!mounted) return;
      final wsId = res['workspaceId'] as String?;
      final alreadyMember = res['alreadyMember'] == true;
      setState(() {
        _successMessage = alreadyMember ? '你已經在這個工作空間裡' : '加入成功！';
        _busy = false;
      });
      // 切換到這個 workspace，然後 push 到 chat 首頁
      if (wsId != null) {
        ref.read(currentWorkspaceIdProvider.notifier).state = wsId;
      }
      await Future.delayed(const Duration(milliseconds: 800));
      if (!mounted) return;
      context.go('/chat');
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = _prettyError(e.toString());
        _busy = false;
      });
    }
  }

  String _prettyError(String raw) {
    if (raw.contains('404')) return '邀請連結不存在或已失效';
    if (raw.contains('已過期')) return '此邀請已過期，請向管理員索取新的連結';
    if (raw.contains('已被使用')) return '此邀請已被使用（每個連結只能用一次）';
    if (raw.contains('401')) return '請先登入再接受邀請';
    return raw;
  }

  String _roleLabel(String role) {
    switch (role) {
      case 'owner':
        return '擁有者';
      case 'admin':
        return '管理員';
      case 'hr':
        return 'HR';
      case 'finance':
        return '財務';
      case 'member':
        return '一般成員';
      default:
        return role;
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authStateProvider);
    final isAuth = authState.isAuthenticated;

    return Scaffold(
      appBar: AppBar(title: const Text('加入工作空間')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: _busy && _invite == null
                ? const Center(child: CircularProgressIndicator())
                : _error != null && _invite == null
                    ? _ErrorCard(message: _error!)
                    : _buildContent(context, isAuth),
          ),
        ),
      ),
    );
  }

  Widget _buildContent(BuildContext context, bool isAuth) {
    if (_invite == null) return const SizedBox();
    final workspace = _invite!['workspace'] as Map<String, dynamic>?;
    final role = _invite!['role'] as String? ?? 'member';
    final valid = _invite!['valid'] == true;
    final expired = _invite!['expired'] == true;
    final consumed = _invite!['consumed'] == true;
    final invitedBy = _invite!['invitedBy'] as String?;

    if (!valid) {
      return _ErrorCard(
        message: consumed
            ? '此邀請連結已被使用'
            : expired
                ? '此邀請連結已過期，請向管理員索取新的'
                : '邀請無效',
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.groups_rounded, size: 56, color: Color(0xFF4F46E5)),
            const SizedBox(height: 16),
            Text(
              '你被邀請加入',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 4),
            Text(
              workspace?['name'] as String? ?? '工作空間',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 16),
            _KV(label: '角色', value: _roleLabel(role)),
            if (invitedBy != null) _KV(label: '邀請人', value: invitedBy),
            const SizedBox(height: 20),
            if (_successMessage != null)
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.green.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle, color: Colors.green),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_successMessage!)),
                  ],
                ),
              )
            else if (!isAuth)
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    '請先登入或註冊才能接受邀請',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.black54),
                  ),
                  const SizedBox(height: 12),
                  FilledButton(
                    onPressed: () => context.go('/login?redirect=/invite/${widget.token}'),
                    child: const Text('登入'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: () => context.go('/register?redirect=/invite/${widget.token}'),
                    child: const Text('註冊新帳號'),
                  ),
                ],
              )
            else
              FilledButton.icon(
                onPressed: _busy ? null : _accept,
                icon: const Icon(Icons.check),
                label: _busy
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('接受邀請並加入'),
              ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: Colors.red), textAlign: TextAlign.center),
            ],
          ],
        ),
      ),
    );
  }
}

class _KV extends StatelessWidget {
  final String label;
  final String value;
  const _KV({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 80,
            child: Text(label, style: const TextStyle(color: Colors.black54)),
          ),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _ErrorCard extends StatelessWidget {
  final String message;
  const _ErrorCard({required this.message});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48, color: Colors.red),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
