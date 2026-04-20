import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../workspace/providers/workspace_provider.dart';

class ErpHomePage extends ConsumerWidget {
  const ErpHomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('ERP')),
      body: workspaceId == null
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text('請先建立或選擇工作空間', textAlign: TextAlign.center),
              ),
            )
          : GridView.count(
              crossAxisCount: MediaQuery.sizeOf(context).width > 720 ? 3 : 2,
              padding: const EdgeInsets.all(16),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.4,
              children: [
                _Tile(
                  icon: Icons.how_to_reg,
                  label: '打卡',
                  color: Colors.indigo,
                  onTap: () => context.go('/erp/attendance'),
                ),
                _Tile(
                  icon: Icons.receipt_long,
                  label: '費用報銷',
                  color: Colors.teal,
                  onTap: () => context.go('/erp/expenses'),
                ),
                _Tile(
                  icon: Icons.event_busy,
                  label: '請假',
                  color: Colors.orange,
                  onTap: () => context.go('/erp/leaves'),
                ),
                _Tile(
                  icon: Icons.admin_panel_settings,
                  label: '成員與權限',
                  color: Colors.purple,
                  onTap: () => context.go('/erp/members'),
                ),
              ],
            ),
    );
  }
}

class _Tile extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  const _Tile({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 44, color: color),
              const SizedBox(height: 12),
              Text(
                label,
                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
