import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/theme_mode_provider.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/workspace/providers/workspace_provider.dart';
import '../../features/workspace/workspace_slug.dart';
import '../../features/workspace/workspace_storage.dart';
import '../widgets/common_widgets.dart';

/// 頂部工作空間列：顯示名稱、切換、建立（列表為空時）。
class WorkspaceSwitcherBar extends ConsumerWidget {
  const WorkspaceSwitcherBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspacesAsync = ref.watch(workspacesProvider);
    final currentId = ref.watch(currentWorkspaceIdProvider);

    return Material(
      elevation: 1,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        color: Theme.of(context).colorScheme.surfaceContainerHighest.withValues(alpha: 0.5),
        child: workspacesAsync.when(
          loading: () => const Row(
            children: [
              SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
              SizedBox(width: 12),
              Text('載入工作空間…'),
            ],
          ),
          error: (_, __) => const Text('無法載入工作空間'),
          data: (list) {
            if (list.isEmpty) {
              return Row(
                children: [
                  Expanded(
                    child: Text(
                      '尚無工作空間',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ),
                  FilledButton.tonal(
                    onPressed: () => _showCreateWorkspaceDialog(context, ref),
                    child: const Text('建立工作空間'),
                  ),
                ],
              );
            }

            final maps = list.cast<Map<String, dynamic>>();
            String title = '選擇工作空間';
            for (final w in maps) {
              if (w['id'] == currentId) {
                title = w['name'] as String? ?? title;
                break;
              }
            }

            return Row(
              children: [
                const Icon(Icons.business_outlined, size: 20),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
                PopupMenuButton<String>(
                  icon: const Icon(Icons.arrow_drop_down),
                  onSelected: (id) async {
                    ref.read(currentWorkspaceIdProvider.notifier).state = id;
                    await WorkspaceStorage.write(id);
                  },
                  itemBuilder: (ctx) => maps
                      .map(
                        (w) => PopupMenuItem<String>(
                          value: w['id'] as String,
                          child: Text(w['name'] as String? ?? w['id'] as String),
                        ),
                      )
                      .toList(),
                ),
                IconButton(
                  tooltip: '新增工作空間',
                  icon: const Icon(Icons.add),
                  onPressed: () => _showCreateWorkspaceDialog(context, ref),
                ),
                IconButton(
                  tooltip: '提醒',
                  icon: const Icon(Icons.notifications_none_outlined),
                  onPressed: () => context.push('/reminders'),
                ),
                const SizedBox(width: 4),
                _UserAvatarButton(parentContext: context),
              ],
            );
          },
        ),
      ),
    );
  }

  static Future<void> _showCreateWorkspaceDialog(BuildContext context, WidgetRef ref) async {
    final nameController = TextEditingController();
    final rootContext = context;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('建立工作空間'),
        content: TextField(
          controller: nameController,
          decoration: const InputDecoration(
            labelText: '名稱',
            hintText: '例如：我的團隊',
          ),
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () async {
              final name = nameController.text.trim();
              if (name.isEmpty) return;
              Navigator.pop(ctx);
              await _createWorkspaceWithRetries(rootContext, ref, name);
            },
            child: const Text('建立'),
          ),
        ],
      ),
    );
    nameController.dispose();
  }

  static Future<void> _createWorkspaceWithRetries(BuildContext context, WidgetRef ref, String name) async {
    final api = ref.read(apiClientProvider);
    final messenger = ScaffoldMessenger.maybeOf(context);
    var slug = workspaceSlugFromName(name);
    for (var attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        slug = workspaceSlugFromName(name, randomSuffix: '${DateTime.now().millisecondsSinceEpoch % 100000}');
      }
      try {
        final created = await api.createWorkspace({'name': name, 'slug': slug});
        final id = created['id'] as String?;
        if (id == null) throw StateError('missing id');
        ref.invalidate(workspacesProvider);
        ref.read(currentWorkspaceIdProvider.notifier).state = id;
        await WorkspaceStorage.write(id);
        return;
      } on DioException catch (e) {
        final code = e.response?.statusCode;
        if (code == 409 || code == 400) {
          continue;
        }
        messenger?.showSnackBar(SnackBar(content: Text('建立失敗：${e.message ?? e}')));
        return;
      } catch (e) {
        messenger?.showSnackBar(SnackBar(content: Text('建立失敗：$e')));
        return;
      }
    }
    messenger?.showSnackBar(const SnackBar(content: Text('建立失敗：請稍後再試或換個名稱')));
  }
}

/// 右上角使用者頭像按鈕 — 點擊顯示個人資料與登出選單
class _UserAvatarButton extends ConsumerWidget {
  final BuildContext parentContext;
  const _UserAvatarButton({required this.parentContext});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authStateProvider);
    final name = auth.displayName ?? auth.email ?? '?';

    return GestureDetector(
      onTap: () => _showProfileSheet(context, ref, auth),
      child: Tooltip(
        message: name,
        child: UserAvatar(
          name: name,
          avatarUrl: auth.avatarUrl,
          radius: 16,
        ),
      ),
    );
  }

  void _showProfileSheet(BuildContext context, WidgetRef ref, AuthState auth) {
    final nameController = TextEditingController(text: auth.displayName ?? '');
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          left: 24, right: 24, top: 24,
          bottom: MediaQuery.viewInsetsOf(ctx).bottom + 24,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header
            Row(
              children: [
                UserAvatar(name: auth.displayName ?? '?', avatarUrl: auth.avatarUrl, radius: 28),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        auth.displayName ?? '未設定名稱',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                      ),
                      if (auth.email != null)
                        Text(auth.email!, style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            // Display name update
            TextField(
              controller: nameController,
              decoration: const InputDecoration(
                labelText: '顯示名稱',
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: () async {
                final newName = nameController.text.trim();
                if (newName.isEmpty) return;
                try {
                  await ref.read(apiClientProvider).updateUserProfile({'displayName': newName});
                  await ref.read(authStateProvider.notifier).reloadProfile();
                  if (ctx.mounted) {
                    Navigator.pop(ctx);
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已更新顯示名稱')));
                  }
                } catch (e) {
                  if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('更新失敗：$e')));
                }
              },
              child: const Text('更新名稱'),
            ),
            const Divider(height: 32),
            // Theme mode
            const _ThemeModeRow(),
            const Divider(height: 32),
            // Logout
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: Colors.red,
                side: const BorderSide(color: Colors.red),
              ),
              icon: const Icon(Icons.logout),
              label: const Text('登出'),
              onPressed: () async {
                Navigator.pop(ctx);
                await ref.read(authStateProvider.notifier).logout();
              },
            ),
          ],
        ),
      ),
    ).then((_) => nameController.dispose());
  }
}

/// 主題模式切換（System / Light / Dark）—— 用 SegmentedButton 呈現，
/// 即時寫回 themeModeProvider，MaterialApp 會自動跟著切換。
class _ThemeModeRow extends ConsumerWidget {
  const _ThemeModeRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(themeModeProvider);
    return Row(
      children: [
        const Icon(Icons.palette_outlined, size: 18),
        const SizedBox(width: 8),
        const Text('主題', style: TextStyle(fontWeight: FontWeight.w500)),
        const Spacer(),
        SegmentedButton<ThemeMode>(
          segments: const [
            ButtonSegment(
              value: ThemeMode.system,
              icon: Icon(Icons.brightness_auto, size: 16),
              tooltip: '跟隨系統',
            ),
            ButtonSegment(
              value: ThemeMode.light,
              icon: Icon(Icons.light_mode_outlined, size: 16),
              tooltip: '淺色',
            ),
            ButtonSegment(
              value: ThemeMode.dark,
              icon: Icon(Icons.dark_mode_outlined, size: 16),
              tooltip: '深色',
            ),
          ],
          selected: {mode},
          showSelectedIcon: false,
          onSelectionChanged: (sel) {
            ref.read(themeModeProvider.notifier).setMode(sel.first);
          },
          style: const ButtonStyle(visualDensity: VisualDensity.compact),
        ),
      ],
    );
  }
}
