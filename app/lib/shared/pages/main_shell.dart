import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/network/api_client.dart';
import '../../core/theme/app_theme.dart';
import '../../features/search/presentation/widgets/command_palette.dart';
import '../../features/shortcuts/presentation/widgets/shortcuts_cheatsheet.dart';
import '../widgets/oidea_sidebar.dart';

final currentTabProvider = StateProvider<int>((ref) => 0);

final unreadCountProvider = FutureProvider<int>((ref) async {
  final api = ref.watch(apiClientProvider);
  try {
    final data = await api.getUnreadCount();
    final raw = data['count'];
    if (raw is int) return raw;
    if (raw is num) return raw.toInt();
    return 0;
  } on DioException catch (e) {
    assert(() {
      debugPrint(
        'getUnreadCount failed: ${e.requestOptions.uri} '
        'status=${e.response?.statusCode}',
      );
      return true;
    }());
    return 0;
  } catch (_) {
    return 0;
  }
});

/// 對齊 prototype 的主視覺骨架：左側深色 `OideaSidebar` + 右側圓角內容卡。
/// 窄畫面（< 720）自動 fallback 到底部 NavigationBar，避免手機被 sidebar 吃掉。
class MainShell extends ConsumerWidget {
  final Widget child;
  const MainShell({super.key, required this.child});

  /// 寬度低於此值才走底部 NavigationBar 的窄版。
  /// 原本是 720 對手機太嚴格,很多瀏覽器視窗(split view、小螢幕)都被切到窄版 → 看不到側欄。
  static const double _mobileBreakpoint = 600;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < _mobileBreakpoint;

    return Shortcuts(
      shortcuts: const <ShortcutActivator, Intent>{
        SingleActivator(LogicalKeyboardKey.keyK, control: true): _OpenCommandPaletteIntent(),
        SingleActivator(LogicalKeyboardKey.keyK, meta: true): _OpenCommandPaletteIntent(),
        SingleActivator(LogicalKeyboardKey.slash, control: true): _OpenShortcutsIntent(),
        SingleActivator(LogicalKeyboardKey.slash, meta: true): _OpenShortcutsIntent(),
      },
      child: Actions(
        actions: <Type, Action<Intent>>{
          _OpenCommandPaletteIntent: CallbackAction<_OpenCommandPaletteIntent>(
            onInvoke: (_) {
              showCommandPalette(context);
              return null;
            },
          ),
          _OpenShortcutsIntent: CallbackAction<_OpenShortcutsIntent>(
            onInvoke: (_) {
              showShortcutsCheatsheet(context);
              return null;
            },
          ),
        },
        child: Focus(
          autofocus: true,
          child: isCompact ? _CompactShell(child: child) : _WideShell(child: child),
        ),
      ),
    );
  }
}

/// 寬版 —— prototype 主要視覺：深色 sidebar + 圓角內容卡。
class _WideShell extends ConsumerWidget {
  final Widget child;
  const _WideShell({required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final contentBg = Theme.of(context).scaffoldBackgroundColor;

    return Scaffold(
      backgroundColor: OideaTokens.sidebarBg,
      body: Row(
        children: [
          const OideaSidebar(),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(0, 6, 0, 6),
              child: ClipRRect(
                borderRadius: const BorderRadius.horizontal(left: Radius.circular(12)),
                child: Container(
                  color: contentBg,
                  child: child,
                ),
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.small(
        tooltip: '搜尋 (Ctrl/⌘+K)',
        onPressed: () => showCommandPalette(context),
        child: const Icon(Icons.search),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.endFloat,
    );
  }
}

/// 窄版（手機） —— 保留原本底部導覽，只是把導覽 icon 對齊新版命名。
class _CompactShell extends ConsumerWidget {
  final Widget child;
  const _CompactShell({required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tabIndex = ref.watch(currentTabProvider);

    return Scaffold(
      // 窄版也讓側欄能叫出來:各 feature 頁面的 AppBar 會自動取得漢堡 icon。
      drawer: const Drawer(
        child: SafeArea(child: OideaSidebar()),
      ),
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: tabIndex,
        onDestinationSelected: (index) {
          ref.read(currentTabProvider.notifier).state = index;
          const routes = [
            '/chat',
            '/projects',
            '/meetings',
            '/whiteboard',
            '/notes',
            '/files',
            '/sheets',
            '/erp',
          ];
          context.go(routes[index]);
        },
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.chat_bubble_outline),
            selectedIcon: Icon(Icons.chat_bubble),
            label: '通訊',
          ),
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: '專案',
          ),
          NavigationDestination(
            icon: Icon(Icons.videocam_outlined),
            selectedIcon: Icon(Icons.videocam),
            label: '會議',
          ),
          NavigationDestination(
            icon: Icon(Icons.draw_outlined),
            selectedIcon: Icon(Icons.draw),
            label: '白板',
          ),
          NavigationDestination(
            icon: Icon(Icons.article_outlined),
            selectedIcon: Icon(Icons.article),
            label: '筆記',
          ),
          NavigationDestination(
            icon: Icon(Icons.folder_outlined),
            selectedIcon: Icon(Icons.folder),
            label: '檔案',
          ),
          NavigationDestination(
            icon: Icon(Icons.grid_on_outlined),
            selectedIcon: Icon(Icons.grid_on),
            label: '試算表',
          ),
          NavigationDestination(
            icon: Icon(Icons.business_center_outlined),
            selectedIcon: Icon(Icons.business_center),
            label: 'ERP',
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.small(
        tooltip: '搜尋 (Ctrl/⌘+K)',
        onPressed: () => showCommandPalette(context),
        child: const Icon(Icons.search),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.endFloat,
    );
  }
}

class _OpenCommandPaletteIntent extends Intent {
  const _OpenCommandPaletteIntent();
}

class _OpenShortcutsIntent extends Intent {
  const _OpenShortcutsIntent();
}
