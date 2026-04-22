import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/theme_mode_provider.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/shortcuts/presentation/widgets/shortcuts_cheatsheet.dart';
import '../../features/workspace/providers/workspace_provider.dart';
import '../../features/workspace/workspace_slug.dart';
import '../../features/workspace/workspace_storage.dart';
import '../pages/main_shell.dart';
import 'common_widgets.dart';

const double kOideaSidebarExpanded = 240;
const double kOideaSidebarCollapsed = 64;

/// 側欄是否收合（呼應 prototype 的 layout: expanded / collapsed）。
final sidebarCollapsedProvider = StateProvider<bool>((ref) => false);

/// 主要導覽項目，對應 main_shell 的 8 個路由。
class _NavItem {
  final String label;
  final IconData icon;
  final String route;
  final int index;
  const _NavItem(this.label, this.icon, this.route, this.index);
}

const _navItems = <_NavItem>[
  _NavItem('通訊', Icons.chat_bubble_outline, '/chat', 0),
  _NavItem('專案', Icons.dashboard_outlined, '/projects', 1),
  _NavItem('會議', Icons.videocam_outlined, '/meetings', 2),
  _NavItem('白板', Icons.draw_outlined, '/whiteboard', 3),
  _NavItem('筆記', Icons.article_outlined, '/notes', 4),
  _NavItem('檔案', Icons.folder_outlined, '/files', 5),
  _NavItem('試算表', Icons.grid_on_outlined, '/sheets', 6),
  _NavItem('ERP', Icons.business_center_outlined, '/erp', 7),
];

/// 對應 prototype 的 OideaSidebar：深色、頂端 workspace switcher、中段導覽、
/// 底端設定/主題/使用者。點選項目切換 tab + go_router route。
class OideaSidebar extends ConsumerWidget {
  const OideaSidebar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final collapsed = ref.watch(sidebarCollapsedProvider);
    final tabIndex = ref.watch(currentTabProvider);
    final width = collapsed ? kOideaSidebarCollapsed : kOideaSidebarExpanded;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOutCubic,
      width: width,
      color: OideaTokens.sidebarBg,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _WorkspaceSwitcher(collapsed: collapsed),
              Container(height: 1, color: OideaTokens.sidebarDivider),
              const SizedBox(height: 6),
              // 導覽
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Column(
                  children: [
                    for (final item in _navItems)
                      _SidebarItem(
                        icon: item.icon,
                        label: item.label,
                        active: tabIndex == item.index,
                        collapsed: collapsed,
                        onTap: () {
                          ref.read(currentTabProvider.notifier).state = item.index;
                          context.go(item.route);
                        },
                      ),
                  ],
                ),
              ),
              const Spacer(),
              Container(height: 1, color: OideaTokens.sidebarDivider),
              const _BottomArea(),
            ],
          ),
          // 收合切換鈕 —— 貼在右緣
          Positioned(
            right: collapsed ? (kOideaSidebarCollapsed / 2 - 11) : -11,
            bottom: 120,
            child: _CollapseToggle(collapsed: collapsed),
          ),
        ],
      ),
    );
  }
}

class _WorkspaceSwitcher extends ConsumerWidget {
  final bool collapsed;
  const _WorkspaceSwitcher({required this.collapsed});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspacesAsync = ref.watch(workspacesProvider);
    final currentId = ref.watch(currentWorkspaceIdProvider);

    final list = workspacesAsync.value ?? const [];
    final maps = list.cast<Map<String, dynamic>>();
    Map<String, dynamic>? current;
    for (final w in maps) {
      if (w['id'] == currentId) {
        current = w;
        break;
      }
    }
    final name = (current?['name'] as String?) ?? 'Oidea';
    final initials = _initialsOf(name);

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: collapsed ? 8 : 14,
        vertical: 12,
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => _showMenu(context, ref, maps, currentId),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: OideaTokens.accent,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    initials,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                    ),
                  ),
                ),
                if (!collapsed) ...[
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            height: 1.3,
                          ),
                        ),
                        const Text(
                          'Free plan',
                          style: TextStyle(
                            color: Color(0x66FFFFFF),
                            fontSize: 11,
                            height: 1.2,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.keyboard_arrow_down, size: 14, color: Color(0x66FFFFFF)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _initialsOf(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return 'OI';
    final parts = trimmed.split(RegExp(r'\s+'));
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    final s = trimmed.replaceAll(RegExp(r'[^A-Za-z0-9]'), '');
    if (s.length >= 2) return s.substring(0, 2).toUpperCase();
    return (s.isEmpty ? trimmed.substring(0, 1) : s).toUpperCase().padRight(2, 'I');
  }

  void _showMenu(
    BuildContext context,
    WidgetRef ref,
    List<Map<String, dynamic>> maps,
    String? currentId,
  ) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xFF1A1A2E),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                '切換工作空間',
                style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600),
              ),
            ),
            if (maps.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('尚無工作空間', style: TextStyle(color: Colors.white70)),
              ),
            ...maps.map((w) {
              final id = w['id'] as String;
              final wname = w['name'] as String? ?? id;
              final selected = id == currentId;
              return ListTile(
                leading: Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: OideaTokens.accent,
                    borderRadius: BorderRadius.circular(7),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    _initialsOf(wname),
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                title: Text(wname, style: const TextStyle(color: Colors.white, fontSize: 13)),
                trailing: selected ? const Icon(Icons.check, color: OideaTokens.accent) : null,
                onTap: () async {
                  Navigator.pop(ctx);
                  ref.read(currentWorkspaceIdProvider.notifier).state = id;
                  await WorkspaceStorage.write(id);
                },
              );
            }),
            const Divider(color: Color(0x14FFFFFF), height: 1),
            ListTile(
              leading: const Icon(Icons.add, color: Colors.white70),
              title: const Text('新增工作空間', style: TextStyle(color: Colors.white70, fontSize: 13)),
              onTap: () {
                Navigator.pop(ctx);
                _showCreateWorkspaceDialog(context, ref);
              },
            ),
          ],
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
          autofocus: true,
          decoration: const InputDecoration(labelText: '名稱', hintText: '例如：我的團隊'),
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

  static Future<void> _createWorkspaceWithRetries(
    BuildContext context,
    WidgetRef ref,
    String name,
  ) async {
    final api = ref.read(apiClientProvider);
    final messenger = ScaffoldMessenger.maybeOf(context);
    var slug = workspaceSlugFromName(name);
    for (var attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        slug = workspaceSlugFromName(
          name,
          randomSuffix: '${DateTime.now().millisecondsSinceEpoch % 100000}',
        );
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
        if (code == 409 || code == 400) continue;
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

class _SidebarItem extends StatefulWidget {
  final IconData icon;
  final String label;
  final bool active;
  final bool collapsed;
  final VoidCallback onTap;

  const _SidebarItem({
    required this.icon,
    required this.label,
    required this.active,
    required this.collapsed,
    required this.onTap,
  });

  @override
  State<_SidebarItem> createState() => _SidebarItemState();
}

class _SidebarItemState extends State<_SidebarItem> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final Color bg;
    if (widget.active) {
      bg = OideaTokens.sidebarItemActive;
    } else if (_hover) {
      bg = OideaTokens.sidebarItemHover;
    } else {
      bg = Colors.transparent;
    }
    final fg = widget.active ? Colors.white : OideaTokens.sidebarText;

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          height: 34,
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(7),
          ),
          child: Row(
            mainAxisAlignment: widget.collapsed ? MainAxisAlignment.center : MainAxisAlignment.start,
            children: [
              // active indicator bar
              if (widget.active && !widget.collapsed)
                Container(
                  width: 3,
                  height: 18,
                  decoration: const BoxDecoration(
                    color: OideaTokens.accent,
                    borderRadius: BorderRadius.horizontal(right: Radius.circular(2)),
                  ),
                ),
              SizedBox(width: widget.collapsed ? 0 : (widget.active ? 9 : 12)),
              Icon(widget.icon, size: 18, color: fg),
              if (!widget.collapsed) ...[
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    widget.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      color: fg,
                      fontWeight: widget.active ? FontWeight.w500 : FontWeight.w400,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _BottomArea extends ConsumerWidget {
  const _BottomArea();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final collapsed = ref.watch(sidebarCollapsedProvider);
    final themeMode = ref.watch(themeModeProvider);
    final auth = ref.watch(authStateProvider);
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        children: [
          // 提醒
          _PlainButton(
            icon: Icons.notifications_none_outlined,
            label: '提醒',
            collapsed: collapsed,
            onTap: () => context.push('/reminders'),
          ),
          // 快捷鍵
          _PlainButton(
            icon: Icons.keyboard_outlined,
            label: '快捷鍵',
            collapsed: collapsed,
            onTap: () => showShortcutsCheatsheet(context),
          ),
          // 主題切換
          _PlainButton(
            icon: isDark ? Icons.wb_sunny_outlined : Icons.dark_mode_outlined,
            label: isDark ? '亮色模式' : '暗色模式',
            collapsed: collapsed,
            onTap: () {
              final next = isDark ? ThemeMode.light : ThemeMode.dark;
              // 保留 system 的語意：若目前是 system，直接切到相反色
              ref.read(themeModeProvider.notifier).setMode(
                    themeMode == ThemeMode.system
                        ? (isDark ? ThemeMode.light : ThemeMode.dark)
                        : next,
                  );
            },
          ),
          Container(
            height: 1,
            margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            color: OideaTokens.sidebarDivider,
          ),
          // 使用者
          InkWell(
            onTap: () => _showProfileSheet(context, ref, auth),
            child: Padding(
              padding: EdgeInsets.symmetric(
                horizontal: collapsed ? 0 : 14,
                vertical: 8,
              ),
              child: Row(
                mainAxisAlignment:
                    collapsed ? MainAxisAlignment.center : MainAxisAlignment.start,
                children: [
                  Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Container(
                        width: 28,
                        height: 28,
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: LinearGradient(
                            colors: [OideaTokens.accent, OideaTokens.accent2],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                        ),
                        alignment: Alignment.center,
                        child: Text(
                          _avatarInitials(auth.displayName ?? auth.email ?? '?'),
                          style: const TextStyle(
                            color: Colors.white,
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      Positioned(
                        right: 0,
                        bottom: 0,
                        child: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: const Color(0xFF10B981),
                            shape: BoxShape.circle,
                            border: Border.all(color: OideaTokens.sidebarBg, width: 1.5),
                          ),
                        ),
                      ),
                    ],
                  ),
                  if (!collapsed) ...[
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        auth.displayName ?? auth.email ?? 'You',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: OideaTokens.sidebarText,
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  static String _avatarInitials(String name) {
    final s = name.trim();
    if (s.isEmpty) return '?';
    return s.substring(0, 1).toUpperCase();
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
          left: 24,
          right: 24,
          top: 24,
          bottom: MediaQuery.viewInsetsOf(ctx).bottom + 24,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                UserAvatar(
                  name: auth.displayName ?? '?',
                  avatarUrl: auth.avatarUrl,
                  radius: 28,
                ),
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
                        Text(
                          auth.email!,
                          style: TextStyle(color: Colors.grey.shade600, fontSize: 13),
                        ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
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
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('已更新顯示名稱')),
                    );
                  }
                } catch (e) {
                  if (ctx.mounted) {
                    ScaffoldMessenger.of(ctx).showSnackBar(
                      SnackBar(content: Text('更新失敗：$e')),
                    );
                  }
                }
              },
              child: const Text('更新名稱'),
            ),
            const Divider(height: 32),
            _ThemeModeRow(),
            const Divider(height: 32),
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

class _PlainButton extends StatefulWidget {
  final IconData icon;
  final String label;
  final bool collapsed;
  final VoidCallback onTap;
  const _PlainButton({
    required this.icon,
    required this.label,
    required this.collapsed,
    required this.onTap,
  });

  @override
  State<_PlainButton> createState() => _PlainButtonState();
}

class _PlainButtonState extends State<_PlainButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: Container(
          height: 32,
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          decoration: BoxDecoration(
            color: _hover ? OideaTokens.sidebarItemHover : Colors.transparent,
            borderRadius: BorderRadius.circular(7),
          ),
          padding: EdgeInsets.symmetric(horizontal: widget.collapsed ? 0 : 14),
          child: Row(
            mainAxisAlignment:
                widget.collapsed ? MainAxisAlignment.center : MainAxisAlignment.start,
            children: [
              Icon(widget.icon, size: 16, color: OideaTokens.sidebarTextDim),
              if (!widget.collapsed) ...[
                const SizedBox(width: 10),
                Text(
                  widget.label,
                  style: const TextStyle(
                    fontSize: 13,
                    color: OideaTokens.sidebarTextDim,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _CollapseToggle extends ConsumerWidget {
  final bool collapsed;
  const _CollapseToggle({required this.collapsed});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Material(
      color: const Color(0xFF2A2A3E),
      shape: const CircleBorder(side: BorderSide(color: Color(0x26FFFFFF), width: 1)),
      elevation: 3,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: () => ref.read(sidebarCollapsedProvider.notifier).state = !collapsed,
        child: SizedBox(
          width: 22,
          height: 22,
          child: Icon(
            collapsed ? Icons.chevron_right : Icons.chevron_left,
            size: 14,
            color: const Color(0x99FFFFFF),
          ),
        ),
      ),
    );
  }
}

/// 主題模式切換（System / Light / Dark）
class _ThemeModeRow extends ConsumerWidget {
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
