import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:badges/badges.dart' as badges;
import 'package:go_router/go_router.dart';
import '../../core/network/api_client.dart';
import 'workspace_switcher_bar.dart';

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

class MainShell extends ConsumerWidget {
  final Widget child;
  const MainShell({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unreadAsync = ref.watch(unreadCountProvider);
    final tabIndex = ref.watch(currentTabProvider);

    return Scaffold(
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const WorkspaceSwitcherBar(),
          Expanded(child: child),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tabIndex,
        onDestinationSelected: (index) {
          ref.read(currentTabProvider.notifier).state = index;
          const routes = ['/chat', '/projects', '/meetings', '/whiteboard', '/notes', '/erp'];
          context.go(routes[index]);
        },
        destinations: [
          NavigationDestination(
            icon: badges.Badge(
              showBadge: (unreadAsync.valueOrNull ?? 0) > 0,
              badgeContent: Text(
                '${unreadAsync.valueOrNull ?? 0}',
                style: const TextStyle(color: Colors.white, fontSize: 10),
              ),
              child: const Icon(Icons.chat_bubble_outline),
            ),
            selectedIcon: badges.Badge(
              showBadge: (unreadAsync.valueOrNull ?? 0) > 0,
              badgeContent: Text(
                '${unreadAsync.valueOrNull ?? 0}',
                style: const TextStyle(color: Colors.white, fontSize: 10),
              ),
              child: const Icon(Icons.chat_bubble),
            ),
            label: '聊天',
          ),
          const NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: '專案',
          ),
          const NavigationDestination(
            icon: Icon(Icons.videocam_outlined),
            selectedIcon: Icon(Icons.videocam),
            label: '會議',
          ),
          const NavigationDestination(
            icon: Icon(Icons.draw_outlined),
            selectedIcon: Icon(Icons.draw),
            label: '白板',
          ),
          const NavigationDestination(
            icon: Icon(Icons.article_outlined),
            selectedIcon: Icon(Icons.article),
            label: '筆記',
          ),
          const NavigationDestination(
            icon: Icon(Icons.business_center_outlined),
            selectedIcon: Icon(Icons.business_center),
            label: 'ERP',
          ),
        ],
      ),
    );
  }
}
