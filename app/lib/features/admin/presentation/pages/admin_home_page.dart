import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/theme/app_theme.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';

/// 後台首頁：只列出目前使用者有權限的功能。
class AdminHomePage extends ConsumerWidget {
  const AdminHomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final perms = ref.watch(adminPermissionsProvider);

    final tiles = <_Tile>[
      if (perms.contains(AdminPerm.employeeReadAll))
        const _Tile(Icons.badge_outlined, '員工名冊', Colors.indigo, '/admin/employees'),
      if (perms.contains(AdminPerm.employeeReadAll))
        const _Tile(Icons.account_tree_outlined, '部門', Colors.teal, '/admin/departments'),
      if (perms.contains(AdminPerm.leavePolicyManage))
        const _Tile(Icons.event_available_outlined, '國定假日', Colors.green, '/admin/holidays'),
      if (perms.contains(AdminPerm.memberRoleManage))
        const _Tile(Icons.admin_panel_settings, '成員與角色', Colors.purple, '/admin/roles'),
      if (perms.contains(AdminPerm.auditRead))
        const _Tile(Icons.fact_check_outlined, '審計日誌', Colors.orange, '/admin/audit'),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('後台')),
      body: tiles.isEmpty
          ? const Center(child: Text('目前沒有可用的後台功能'))
          : GridView.count(
              crossAxisCount: MediaQuery.sizeOf(context).width > 720 ? 3 : 2,
              padding: const EdgeInsets.all(OideaSpace.space4),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.4,
              children: [
                for (final t in tiles)
                  Card(
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: () => context.go(t.route),
                      child: Padding(
                        padding: const EdgeInsets.all(OideaSpace.space4),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(t.icon, size: 44, color: t.color),
                            const SizedBox(height: OideaSpace.space3),
                            Text(
                              t.label,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: OideaFontSize.size15,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _Tile {
  const _Tile(this.icon, this.label, this.color, this.route);
  final IconData icon;
  final String label;
  final Color color;
  final String route;
}
