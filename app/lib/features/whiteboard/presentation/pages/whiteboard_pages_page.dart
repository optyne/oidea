import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/network/api_client.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../providers/whiteboard_provider.dart';

/// 一本筆記本（Whiteboard）內的頁面縮圖格。
/// 舊白板（無頁面、data.canvasItems 有東西）顯示「開啟舊畫布」入口。
class WhiteboardPagesPage extends ConsumerWidget {
  const WhiteboardPagesPage({super.key, required this.boardId});

  final String boardId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final boardAsync = ref.watch(whiteboardProvider(boardId));
    final pagesAsync = ref.watch(whiteboardPagesProvider(boardId));
    final legacyItems =
        ((boardAsync.value?['data'] as Map<String, dynamic>?)?['canvasItems'] as List?) ?? [];

    return Scaffold(
      appBar: AppBar(
        title: Text(boardAsync.value?['title'] as String? ?? '筆記本'),
        actions: [
          if (legacyItems.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.history),
              tooltip: '開啟舊畫布',
              onPressed: () => context.go('/whiteboard/canvas/$boardId'),
            ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('新增頁'),
        onPressed: () async {
          final page = await ref.read(apiClientProvider).createWhiteboardPage(boardId);
          ref.invalidate(whiteboardPagesProvider(boardId));
          if (context.mounted && page['id'] != null) {
            context.go('/whiteboard/pencil/$boardId/${page['id']}');
          }
        },
      ),
      body: pagesAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(
          message: e.toString(),
          onRetry: () => ref.invalidate(whiteboardPagesProvider(boardId)),
        ),
        data: (pages) {
          if (pages.isEmpty && legacyItems.isNotEmpty) {
            return _LegacyBoardNotice(boardId: boardId);
          }
          if (pages.isEmpty) {
            return const Center(child: Text('還沒有頁面 —— 按「新增頁」開始畫'));
          }
          return GridView.builder(
            padding: const EdgeInsets.all(OideaSpace.space4),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 220,
              mainAxisSpacing: OideaSpace.space4,
              crossAxisSpacing: OideaSpace.space4,
              childAspectRatio: 3 / 4,
            ),
            itemCount: pages.length,
            itemBuilder: (context, i) {
              final page = pages[i] as Map<String, dynamic>;
              return _PageCard(boardId: boardId, page: page, index: i);
            },
          );
        },
      ),
    );
  }
}

class _PageCard extends ConsumerWidget {
  const _PageCard({required this.boardId, required this.page, required this.index});

  final String boardId;
  final Map<String, dynamic> page;
  final int index;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final thumbnailUrl = page['thumbnailUrl'] as String?;
    return InkWell(
      borderRadius: OideaRadius.lgAll,
      onTap: () => context.go('/whiteboard/pencil/$boardId/${page['id']}'),
      onLongPress: () => _showActions(context, ref),
      child: Ink(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: OideaRadius.lgAll,
          border: Border.all(color: Theme.of(context).dividerTheme.color ?? Colors.black12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(top: Radius.circular(OideaRadius.lg)),
                child: thumbnailUrl == null
                    ? const Center(child: Icon(Icons.draw_outlined, size: OideaSpace.space8))
                    : Image.network(thumbnailUrl, fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) =>
                            const Center(child: Icon(Icons.broken_image_outlined))),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(OideaSpace.space2),
              child: Text('第 ${index + 1} 頁',
                  style: OideaType.caption, textAlign: TextAlign.center),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showActions(BuildContext context, WidgetRef ref) async {
    final api = ref.read(apiClientProvider);
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
                leading: const Icon(Icons.arrow_back),
                title: const Text('往前移'),
                onTap: () => Navigator.pop(context, 'left')),
            ListTile(
                leading: const Icon(Icons.arrow_forward),
                title: const Text('往後移'),
                onTap: () => Navigator.pop(context, 'right')),
            ListTile(
                leading: const Icon(Icons.delete_outline),
                title: const Text('刪除此頁'),
                onTap: () => Navigator.pop(context, 'delete')),
          ],
        ),
      ),
    );
    if (action == null) return;

    final pages = await api.getWhiteboardPages(boardId);
    final ids = pages.map((p) => (p as Map<String, dynamic>)['id'] as String).toList();
    final i = ids.indexOf(page['id'] as String);
    if (action == 'delete') {
      await api.deleteWhiteboardPage(boardId, page['id'] as String);
    } else if (action == 'left' && i > 0) {
      ids.removeAt(i);
      ids.insert(i - 1, page['id'] as String);
      await api.reorderWhiteboardPages(boardId, ids);
    } else if (action == 'right' && i >= 0 && i < ids.length - 1) {
      ids.removeAt(i);
      ids.insert(i + 1, page['id'] as String);
      await api.reorderWhiteboardPages(boardId, ids);
    }
    ref.invalidate(whiteboardPagesProvider(boardId));
  }
}

class _LegacyBoardNotice extends StatelessWidget {
  const _LegacyBoardNotice({required this.boardId});

  final String boardId;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('這是舊版白板（單張畫布）'),
          const SizedBox(height: OideaSpace.space3),
          FilledButton.icon(
            icon: const Icon(Icons.open_in_new),
            label: const Text('開啟舊畫布'),
            onPressed: () => context.go('/whiteboard/canvas/$boardId'),
          ),
          const SizedBox(height: OideaSpace.space2),
          Text('或按右下角「新增頁」改用筆記本模式',
              style: OideaType.bodySm.copyWith(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6))),
        ],
      ),
    );
  }
}
