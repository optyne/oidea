import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/notes_providers.dart';
import '../widgets/block_editor.dart';
import '../widgets/database_view.dart';

class NotesHomePage extends ConsumerWidget {
  const NotesHomePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspaceId = ref.watch(currentWorkspaceIdProvider);
    if (workspaceId == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('筆記')),
        body: const Center(child: Text('請先選擇工作空間')),
      );
    }

    final selectedId = ref.watch(selectedPageIdProvider);
    final isWide = MediaQuery.sizeOf(context).width > 820;

    final sidebar = _PageSidebar(workspaceId: workspaceId);
    final detail = selectedId == null
        ? const _EmptyDetail()
        : _PageDetailPane(pageId: selectedId);

    return Scaffold(
      appBar: isWide ? null : AppBar(title: const Text('筆記')),
      body: isWide
          ? Row(
              children: [
                SizedBox(width: 280, child: sidebar),
                const VerticalDivider(width: 1),
                Expanded(child: detail),
              ],
            )
          : (selectedId == null ? sidebar : detail),
    );
  }
}

class _PageSidebar extends ConsumerWidget {
  final String workspaceId;
  const _PageSidebar({required this.workspaceId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pagesAsync = ref.watch(workspacePagesProvider(workspaceId));

    return Column(
      children: [
        AppBar(
          automaticallyImplyLeading: false,
          title: const Text('筆記'),
          actions: [
            IconButton(
              tooltip: '新建頁面',
              icon: const Icon(Icons.note_add_outlined),
              onPressed: () => _createPage(context, ref),
            ),
            PopupMenuButton<String>(
              icon: const Icon(Icons.add_box_outlined),
              tooltip: '新建資料庫',
              onSelected: (v) async {
                final api = ref.read(apiClientProvider);
                try {
                  if (v == 'finance') {
                    final res = await api.createFinanceLog(workspaceId);
                    ref.invalidate(workspacePagesProvider(workspaceId));
                    final page = res['page'] as Map<String, dynamic>;
                    ref.read(selectedPageIdProvider.notifier).state = page['id'] as String;
                  } else if (v == 'blank') {
                    final created = await api.createDatabase({
                      'workspaceId': workspaceId,
                      'title': '📊 新資料庫',
                      'icon': '📊',
                      'properties': [
                        {'key': 'title', 'name': '名稱', 'type': 'text'},
                        {'key': 'status', 'name': '狀態', 'type': 'select', 'config': {
                          'options': [
                            {'id': 'todo', 'label': '待辦', 'color': 'grey'},
                            {'id': 'doing', 'label': '進行中', 'color': 'blue'},
                            {'id': 'done', 'label': '完成', 'color': 'green'},
                          ],
                        }},
                      ],
                    });
                    ref.invalidate(workspacePagesProvider(workspaceId));
                    final page = created['page'] as Map<String, dynamic>;
                    ref.read(selectedPageIdProvider.notifier).state = page['id'] as String;
                  }
                } catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context)
                        .showSnackBar(SnackBar(content: Text('建立失敗：$e')));
                  }
                }
              },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'finance', child: Text('💰 記帳（含預設欄位）')),
                PopupMenuItem(value: 'blank', child: Text('📊 空白資料庫')),
              ],
            ),
          ],
        ),
        Expanded(
          child: pagesAsync.when(
            loading: () => const LoadingWidget(),
            error: (e, _) => AppErrorWidget(message: e.toString()),
            data: (list) {
              if (list.isEmpty) {
                return EmptyStateWidget(
                  icon: Icons.article_outlined,
                  title: '尚無頁面',
                  subtitle: '新建一個頁面或一張記帳表吧',
                  action: FilledButton.tonal(
                    onPressed: () => _createPage(context, ref),
                    child: const Text('新建頁面'),
                  ),
                );
              }
              return _PageTree(pages: list, workspaceId: workspaceId);
            },
          ),
        ),
      ],
    );
  }

  Future<void> _createPage(BuildContext context, WidgetRef ref) async {
    final titleCtl = TextEditingController(text: 'Untitled');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新建頁面'),
        content: TextField(
          controller: titleCtl,
          autofocus: true,
          decoration: const InputDecoration(labelText: '標題'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('建立')),
        ],
      ),
    );
    final title = titleCtl.text.trim();
    titleCtl.dispose();
    if (ok != true || title.isEmpty) return;

    try {
      final created = await ref.read(apiClientProvider).createKnowledgePage({
        'workspaceId': workspaceId,
        'title': title,
      });
      ref.invalidate(workspacePagesProvider(workspaceId));
      ref.read(selectedPageIdProvider.notifier).state = created['id'] as String;
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('建立失敗：$e')));
      }
    }
  }
}

class _PageTree extends ConsumerWidget {
  final String workspaceId;
  final List<dynamic> pages;
  const _PageTree({required this.pages, required this.workspaceId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedId = ref.watch(selectedPageIdProvider);
    final byParent = <String?, List<Map<String, dynamic>>>{};
    for (final p in pages) {
      final m = p as Map<String, dynamic>;
      final parent = m['parentId'] as String?;
      byParent.putIfAbsent(parent, () => []).add(m);
    }

    List<Widget> build(String? parentId, int depth) {
      final items = byParent[parentId] ?? [];
      final widgets = <Widget>[];
      for (final item in items) {
        final id = item['id'] as String;
        final icon = (item['icon'] as String?) ?? (item['kind'] == 'database' ? '📊' : '📄');
        widgets.add(
          InkWell(
            onTap: () => ref.read(selectedPageIdProvider.notifier).state = id,
            child: Container(
              color: id == selectedId
                  ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.3)
                  : null,
              padding: EdgeInsets.fromLTRB(12 + depth * 14.0, 8, 12, 8),
              child: Row(
                children: [
                  Text(icon, style: const TextStyle(fontSize: 14)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      item['title'] as String? ?? 'Untitled',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
        widgets.addAll(build(id, depth + 1));
      }
      return widgets;
    }

    return ListView(children: build(null, 0));
  }
}

class _EmptyDetail extends StatelessWidget {
  const _EmptyDetail();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: EmptyStateWidget(
        icon: Icons.article_outlined,
        title: '選擇或新建一個頁面',
        subtitle: '左側可新建「📄 頁面」或「💰 記帳」。',
      ),
    );
  }
}

class _PageDetailPane extends ConsumerStatefulWidget {
  final String pageId;
  const _PageDetailPane({required this.pageId});

  @override
  ConsumerState<_PageDetailPane> createState() => _PageDetailPaneState();
}

class _PageDetailPaneState extends ConsumerState<_PageDetailPane> {
  final _titleController = TextEditingController();
  String _titleInitial = '';
  String _currentPageId = '';

  @override
  void dispose() {
    _titleController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final detailAsync = ref.watch(pageDetailProvider(widget.pageId));

    return detailAsync.when(
      loading: () => const LoadingWidget(),
      error: (e, _) => AppErrorWidget(message: e.toString()),
      data: (page) {
        final title = page['title'] as String? ?? '';
        if (_currentPageId != widget.pageId) {
          _currentPageId = widget.pageId;
          _titleInitial = title;
          _titleController.text = title;
        }
        final kind = page['kind'] as String? ?? 'page';
        final blocks = (page['blocks'] as List<dynamic>?) ?? [];
        final database = page['database'] as Map<String, dynamic>?;
        final properties = (database?['properties'] as List<dynamic>?) ?? [];

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 16, 6),
              child: Row(
                children: [
                  Text(
                    (page['icon'] as String?) ?? (kind == 'database' ? '📊' : '📄'),
                    style: const TextStyle(fontSize: 28),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: TextField(
                      controller: _titleController,
                      style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        isCollapsed: true,
                        hintText: 'Untitled',
                      ),
                      onSubmitted: (v) async => _saveTitle(v),
                      onEditingComplete: () => _saveTitle(_titleController.text),
                    ),
                  ),
                  PopupMenuButton<String>(
                    icon: const Icon(Icons.more_horiz),
                    onSelected: (v) async {
                      if (v == 'delete') {
                        final confirm = await showDialog<bool>(
                          context: context,
                          builder: (ctx) => AlertDialog(
                            title: const Text('刪除頁面？'),
                            content: const Text('刪除後將無法復原（軟刪除）。'),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(ctx, false),
                                child: const Text('取消'),
                              ),
                              FilledButton(
                                style: FilledButton.styleFrom(backgroundColor: Colors.red),
                                onPressed: () => Navigator.pop(ctx, true),
                                child: const Text('刪除'),
                              ),
                            ],
                          ),
                        );
                        if (confirm != true) return;
                        await ref.read(apiClientProvider).deleteKnowledgePage(widget.pageId);
                        final workspaceId = page['workspaceId'] as String?;
                        if (workspaceId != null) {
                          ref.invalidate(workspacePagesProvider(workspaceId));
                        }
                        ref.read(selectedPageIdProvider.notifier).state = null;
                      }
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'delete', child: Text('刪除頁面')),
                    ],
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: kind == 'database' && database != null
                  ? DatabaseView(
                      pageId: widget.pageId,
                      database: database,
                      properties: properties,
                    )
                  : BlockEditor(pageId: widget.pageId, initialBlocks: blocks),
            ),
          ],
        );
      },
    );
  }

  Future<void> _saveTitle(String v) async {
    final t = v.trim();
    if (t == _titleInitial) return;
    try {
      await ref.read(apiClientProvider).updateKnowledgePage(widget.pageId, {'title': t});
      _titleInitial = t;
      // 重新載入樹以更新顯示的標題（非必要但較好）。
      final detail = ref.read(pageDetailProvider(widget.pageId)).valueOrNull;
      final workspaceId = detail?['workspaceId'] as String?;
      if (workspaceId != null) ref.invalidate(workspacePagesProvider(workspaceId));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('更新失敗：$e')));
      }
    }
  }
}
