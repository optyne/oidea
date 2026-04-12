import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/project_provider.dart';

class ProjectHomePage extends ConsumerStatefulWidget {
  const ProjectHomePage({super.key});

  @override
  ConsumerState<ProjectHomePage> createState() => _ProjectHomePageState();
}

class _ProjectHomePageState extends ConsumerState<ProjectHomePage> {
  @override
  Widget build(BuildContext context) {
    final workspacesAsync = ref.watch(workspacesProvider);
    final workspaceId = ref.watch(currentWorkspaceIdProvider);

    if (workspacesAsync.isLoading) {
      return Scaffold(
        appBar: AppBar(title: const Text('專案')),
        body: const LoadingWidget(),
      );
    }
    final list = workspacesAsync.value ?? [];
    if (list.isNotEmpty && workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('專案')),
        body: const LoadingWidget(),
      );
    }
    if (workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('專案')),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('請在頂端建立或選擇工作空間', textAlign: TextAlign.center),
          ),
        ),
      );
    }

    final projectsAsync = ref.watch(projectsProvider(workspaceId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('專案'),
        actions: [
          IconButton(icon: const Icon(Icons.view_list), onPressed: () {}),
        ],
      ),
      body: projectsAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(message: e.toString(), onRetry: () => ref.invalidate(projectsProvider(workspaceId))),
        data: (projects) {
          if (projects.isEmpty) {
            return EmptyStateWidget(
              icon: Icons.dashboard_outlined,
              title: '尚無專案',
              subtitle: '建立第一個專案開始管理任務',
              action: FilledButton(onPressed: () => _showCreateProject(context), child: const Text('建立專案')),
            );
          }

          return GridView.builder(
            padding: const EdgeInsets.all(16),
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              childAspectRatio: 1.5,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12,
            ),
            itemCount: projects.length,
            itemBuilder: (context, index) {
              final project = projects[index] as Map<String, dynamic>;
              return Card(
                child: InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => context.go('/projects/board/${project['id']}'),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: _parseHexColor(project['color'] as String?),
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                project['name'] ?? '',
                                style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                        const Spacer(),
                        Text(
                          '${project['_count']?['tasks'] ?? 0} 個任務',
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.grey),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          );
        },
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _showCreateProject(context),
        child: const Icon(Icons.add),
      ),
    );
  }

  void _showCreateProject(BuildContext context) {
    final nameController = TextEditingController();
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('建立專案'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: nameController, decoration: const InputDecoration(labelText: '專案名稱')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () async {
              final api = ref.read(apiClientProvider);
              final ws = ref.read(currentWorkspaceIdProvider);
              if (ws == null) return;
              await api.createProject({'name': nameController.text, 'workspaceId': ws});
              if (ctx.mounted) Navigator.pop(ctx);
              ref.invalidate(projectsProvider(ws));
            },
            child: const Text('建立'),
          ),
        ],
      ),
    );
  }

  static Color _parseHexColor(String? raw) {
    if (raw == null || raw.isEmpty) return const Color(0xFF4F46E5);
    final hex = raw.replaceAll('#', '');
    final v = int.tryParse(hex.length == 6 ? hex : '', radix: 16);
    if (v == null) return const Color(0xFF4F46E5);
    return Color(0xFF000000 | v);
  }
}
