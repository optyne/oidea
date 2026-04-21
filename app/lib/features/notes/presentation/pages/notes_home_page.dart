import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../workspace/providers/workspace_provider.dart';
import '../../providers/notes_providers.dart';
import '../widgets/block_editor.dart';
import '../widgets/database_view.dart';
import '../widgets/share_page_dialog.dart';

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

/// Notion-style 側欄頁面樹：每個節點可展開/收合，hover 出現 +（建子頁）和 ⋯（操作）。
/// 展開狀態保留在 widget state；重新載入會清空（預設自動展開 selected 的 ancestors）。
class _PageTree extends ConsumerStatefulWidget {
  final String workspaceId;
  final List<dynamic> pages;
  const _PageTree({required this.pages, required this.workspaceId});

  @override
  ConsumerState<_PageTree> createState() => _PageTreeState();
}

class _PageTreeState extends ConsumerState<_PageTree> {
  final Set<String> _expanded = {};

  Map<String?, List<Map<String, dynamic>>> _groupByParent() {
    final by = <String?, List<Map<String, dynamic>>>{};
    for (final p in widget.pages) {
      final m = p as Map<String, dynamic>;
      final parent = m['parentId'] as String?;
      by.putIfAbsent(parent, () => []).add(m);
    }
    // 同層按 position / title 排序（position 優先，fallback title）
    for (final list in by.values) {
      list.sort((a, b) {
        final pa = (a['position'] as num?)?.toInt() ?? 0;
        final pb = (b['position'] as num?)?.toInt() ?? 0;
        if (pa != pb) return pa.compareTo(pb);
        final ta = (a['title'] as String?) ?? '';
        final tb = (b['title'] as String?) ?? '';
        return ta.compareTo(tb);
      });
    }
    return by;
  }

  /// 自動展開 selectedId 的所有 ancestor —— 不然選到一個深層頁，側欄看不到它。
  void _expandAncestorsOf(String? selectedId, Map<String?, List<Map<String, dynamic>>> byParent) {
    if (selectedId == null) return;
    // 反查 parent chain 需要 id→parentId 映射
    final parentOf = <String, String?>{};
    for (final entry in byParent.entries) {
      for (final item in entry.value) {
        parentOf[item['id'] as String] = entry.key;
      }
    }
    var cur = parentOf[selectedId];
    while (cur != null) {
      _expanded.add(cur);
      cur = parentOf[cur];
    }
  }

  @override
  Widget build(BuildContext context) {
    final selectedId = ref.watch(selectedPageIdProvider);
    final byParent = _groupByParent();
    _expandAncestorsOf(selectedId, byParent);

    final roots = byParent[null] ?? [];
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 4),
      children: [
        for (final item in roots) ..._buildNode(item, 0, byParent, selectedId),
      ],
    );
  }

  List<Widget> _buildNode(
    Map<String, dynamic> item,
    int depth,
    Map<String?, List<Map<String, dynamic>>> byParent,
    String? selectedId,
  ) {
    final id = item['id'] as String;
    final children = byParent[id] ?? [];
    final hasChildren = children.isNotEmpty;
    final expanded = _expanded.contains(id);

    final out = <Widget>[
      _PageTreeRow(
        key: ValueKey('ptr_$id'),
        item: item,
        depth: depth,
        hasChildren: hasChildren,
        expanded: expanded,
        selected: id == selectedId,
        onTap: () => ref.read(selectedPageIdProvider.notifier).state = id,
        onToggleExpand: () => setState(() {
          if (expanded) {
            _expanded.remove(id);
          } else {
            _expanded.add(id);
          }
        }),
        onAddChild: () => _createChildPage(id),
        onRename: () => _renamePage(item),
        onDelete: () => _deletePage(item),
      ),
    ];
    if (expanded) {
      for (final c in children) {
        out.addAll(_buildNode(c, depth + 1, byParent, selectedId));
      }
    }
    return out;
  }

  Future<void> _createChildPage(String parentId) async {
    try {
      final created = await ref.read(apiClientProvider).createKnowledgePage({
        'workspaceId': widget.workspaceId,
        'title': 'Untitled',
        'parentId': parentId,
      });
      setState(() => _expanded.add(parentId));
      ref.invalidate(workspacePagesProvider(widget.workspaceId));
      ref.read(selectedPageIdProvider.notifier).state = created['id'] as String;
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
      }
    }
  }

  Future<void> _renamePage(Map<String, dynamic> item) async {
    final ctrl = TextEditingController(text: item['title'] as String? ?? '');
    final newTitle = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重新命名'),
        content: TextField(controller: ctrl, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('確定'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (newTitle == null || newTitle.isEmpty) return;
    try {
      await ref
          .read(apiClientProvider)
          .updateKnowledgePage(item['id'] as String, {'title': newTitle});
      ref.invalidate(workspacePagesProvider(widget.workspaceId));
      ref.invalidate(pageDetailProvider(item['id'] as String));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失敗：$e')));
      }
    }
  }

  Future<void> _deletePage(Map<String, dynamic> item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('刪除頁面？'),
        content: Text('確定刪除「${item['title'] ?? ''}」？子頁面一併刪除（軟刪）。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('刪除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(apiClientProvider).deleteKnowledgePage(item['id'] as String);
      ref.invalidate(workspacePagesProvider(widget.workspaceId));
      final selectedId = ref.read(selectedPageIdProvider);
      if (selectedId == item['id']) {
        ref.read(selectedPageIdProvider.notifier).state = null;
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('失敗：$e')));
      }
    }
  }
}

/// 單一樹節點 —— hover 時右側露出 +／⋯ 快捷按鈕。
class _PageTreeRow extends StatefulWidget {
  final Map<String, dynamic> item;
  final int depth;
  final bool hasChildren;
  final bool expanded;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onToggleExpand;
  final VoidCallback onAddChild;
  final VoidCallback onRename;
  final VoidCallback onDelete;

  const _PageTreeRow({
    super.key,
    required this.item,
    required this.depth,
    required this.hasChildren,
    required this.expanded,
    required this.selected,
    required this.onTap,
    required this.onToggleExpand,
    required this.onAddChild,
    required this.onRename,
    required this.onDelete,
  });

  @override
  State<_PageTreeRow> createState() => _PageTreeRowState();
}

class _PageTreeRowState extends State<_PageTreeRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final icon = (widget.item['icon'] as String?) ??
        (widget.item['kind'] == 'database' ? '📊' : '📄');
    final title = widget.item['title'] as String? ?? 'Untitled';
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: InkWell(
        onTap: widget.onTap,
        child: Container(
          color: widget.selected
              ? Theme.of(context).colorScheme.primaryContainer.withValues(alpha: 0.3)
              : null,
          padding: EdgeInsets.fromLTRB(4 + widget.depth * 14.0, 2, 4, 2),
          child: Row(
            children: [
              // 展開／收合箭頭（無 children 就留空位保持對齊）
              SizedBox(
                width: 20,
                child: widget.hasChildren
                    ? InkWell(
                        onTap: widget.onToggleExpand,
                        borderRadius: BorderRadius.circular(4),
                        child: Icon(
                          widget.expanded
                              ? Icons.keyboard_arrow_down
                              : Icons.keyboard_arrow_right,
                          size: 18,
                          color: Colors.grey.shade600,
                        ),
                      )
                    : const SizedBox.shrink(),
              ),
              Text(icon, style: const TextStyle(fontSize: 14)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14),
                ),
              ),
              // hover 時露出 + 與 ⋯
              if (_hover) ...[
                InkWell(
                  onTap: widget.onAddChild,
                  borderRadius: BorderRadius.circular(4),
                  child: Tooltip(
                    message: '新增子頁面',
                    child: Padding(
                      padding: const EdgeInsets.all(4),
                      child: Icon(Icons.add, size: 16, color: Colors.grey.shade700),
                    ),
                  ),
                ),
                PopupMenuButton<String>(
                  padding: EdgeInsets.zero,
                  iconSize: 16,
                  tooltip: '更多',
                  icon: Icon(Icons.more_horiz, size: 16, color: Colors.grey.shade700),
                  onSelected: (v) {
                    switch (v) {
                      case 'rename':
                        widget.onRename();
                        break;
                      case 'add_child':
                        widget.onAddChild();
                        break;
                      case 'delete':
                        widget.onDelete();
                        break;
                    }
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'rename', child: Text('重新命名')),
                    PopupMenuItem(value: 'add_child', child: Text('新增子頁面')),
                    PopupMenuItem(
                      value: 'delete',
                      child: Text('刪除', style: TextStyle(color: Colors.red)),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
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
                      if (v == 'share') {
                        final workspaceId = page['workspaceId'] as String?;
                        if (workspaceId == null) return;
                        await showDialog<void>(
                          context: context,
                          builder: (_) => SharePageDialog(
                            pageId: widget.pageId,
                            workspaceId: workspaceId,
                            pageTitle: (page['title'] as String?) ?? 'Untitled',
                          ),
                        );
                        ref.invalidate(workspacePagesProvider(workspaceId));
                      } else if (v == 'delete') {
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
                      PopupMenuItem(
                        value: 'share',
                        child: Row(children: [
                          Icon(Icons.share_outlined, size: 18),
                          SizedBox(width: 8),
                          Text('分享／權限'),
                        ]),
                      ),
                      PopupMenuItem(
                        value: 'delete',
                        child: Row(children: [
                          Icon(Icons.delete_outline, size: 18, color: Colors.red),
                          SizedBox(width: 8),
                          Text('刪除頁面'),
                        ]),
                      ),
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
