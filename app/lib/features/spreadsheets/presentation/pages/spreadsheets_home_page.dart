import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/network/api_client.dart';
import '../../../workspace/providers/workspace_provider.dart';

class SpreadsheetsHomePage extends ConsumerStatefulWidget {
  const SpreadsheetsHomePage({super.key});

  @override
  ConsumerState<SpreadsheetsHomePage> createState() => _SpreadsheetsHomePageState();
}

class _SpreadsheetsHomePageState extends ConsumerState<SpreadsheetsHomePage> {
  List<Map<String, dynamic>> _items = [];
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _fetch());
  }

  Future<void> _fetch() async {
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) {
      setState(() {
        _error = '請先選擇工作空間';
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final raw = await ref.read(apiClientProvider).getSpreadsheets(wsId);
      setState(() {
        _items = raw.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = '載入失敗：$e';
        _loading = false;
      });
    }
  }

  Future<void> _createNew() async {
    final ctrl = TextEditingController();
    final title = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新增試算表'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: '試算表名稱',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(
            onPressed: () {
              final t = ctrl.text.trim();
              if (t.isNotEmpty) Navigator.pop(ctx, t);
            },
            child: const Text('建立'),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (title == null) return;
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) return;
    try {
      final created = await ref.read(apiClientProvider).createSpreadsheet(
            workspaceId: wsId,
            title: title,
          );
      if (!mounted) return;
      context.push('/sheets/${created['id']}');
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('建立失敗：$e')));
      }
    }
  }

  Future<void> _delete(Map<String, dynamic> item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('刪除試算表'),
        content: Text('確定刪除「${item['title']}」？'),
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
      await ref.read(apiClientProvider).deleteSpreadsheet(item['id'] as String);
      _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('刪除失敗：$e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: Colors.red)))
              : _items.isEmpty
                  ? _empty()
                  : RefreshIndicator(
                      onRefresh: _fetch,
                      child: ListView.separated(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
                        itemCount: _items.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (_, i) {
                          final s = _items[i];
                          return Card(
                            child: ListTile(
                              leading: const Icon(Icons.grid_on, color: Color(0xFF059669)),
                              title: Text(s['title'] as String? ?? ''),
                              subtitle: Text(
                                (s['description'] as String?)?.isNotEmpty == true
                                    ? s['description'] as String
                                    : '最後更新：${_formatDate(s['updatedAt'] as String?)}',
                                style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                              ),
                              trailing: PopupMenuButton<String>(
                                onSelected: (v) {
                                  if (v == 'delete') _delete(s);
                                },
                                itemBuilder: (_) => const [
                                  PopupMenuItem(
                                    value: 'delete',
                                    child: Text('刪除', style: TextStyle(color: Colors.red)),
                                  ),
                                ],
                              ),
                              onTap: () => context.push('/sheets/${s['id']}'),
                            ),
                          );
                        },
                      ),
                    ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _createNew,
        icon: const Icon(Icons.add),
        label: const Text('新增試算表'),
      ),
    );
  }

  Widget _empty() => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.grid_on, size: 64, color: Colors.grey.shade400),
            const SizedBox(height: 12),
            Text('目前還沒有試算表', style: TextStyle(color: Colors.grey.shade600, fontSize: 15)),
            const SizedBox(height: 8),
            TextButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('建立第一張試算表'),
              onPressed: _createNew,
            ),
          ],
        ),
      );

  String _formatDate(String? iso) {
    if (iso == null) return '';
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso;
    return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} '
        '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }
}
