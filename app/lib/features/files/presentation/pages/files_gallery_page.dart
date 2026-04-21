import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/network/api_client.dart';
import '../../../workspace/providers/workspace_provider.dart';
import 'image_viewer_page.dart';

/// Notion/Affine 風格的工作空間檔案庫。按類別篩選、關鍵字搜尋、網格或清單檢視，
/// 點圖片開全螢幕預覽、點其他檔案走 OS 處理器。
class FilesGalleryPage extends ConsumerStatefulWidget {
  const FilesGalleryPage({super.key});

  @override
  ConsumerState<FilesGalleryPage> createState() => _FilesGalleryPageState();
}

enum _FileKind { all, image, pdf, doc, video, audio, other }
enum _ViewMode { grid, list }

class _FilesGalleryPageState extends ConsumerState<FilesGalleryPage> {
  _FileKind _kind = _FileKind.all;
  _ViewMode _view = _ViewMode.grid;
  String _search = '';
  Timer? _searchDebounce;

  List<Map<String, dynamic>> _items = [];
  int _total = 0;
  bool _loading = false;
  bool _uploading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _fetch());
  }

  @override
  void dispose() {
    _searchDebounce?.cancel();
    super.dispose();
  }

  String _kindToApi(_FileKind k) => switch (k) {
        _FileKind.all => 'all',
        _FileKind.image => 'image',
        _FileKind.pdf => 'pdf',
        _FileKind.doc => 'doc',
        _FileKind.video => 'video',
        _FileKind.audio => 'audio',
        _FileKind.other => 'other',
      };

  Future<void> _fetch() async {
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) {
      setState(() {
        _error = '請先選擇工作空間';
        _items = [];
        _total = 0;
      });
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).browseWorkspaceFiles(
            wsId,
            type: _kindToApi(_kind),
            search: _search,
            limit: 100,
          );
      final items = (res['items'] as List? ?? [])
          .whereType<Map>()
          .map((m) => Map<String, dynamic>.from(m))
          .toList();
      setState(() {
        _items = items;
        _total = (res['total'] as int?) ?? items.length;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = '載入失敗：$e';
        _loading = false;
      });
    }
  }

  void _onSearchChanged(String v) {
    _search = v;
    _searchDebounce?.cancel();
    _searchDebounce = Timer(const Duration(milliseconds: 350), _fetch);
  }

  Future<void> _uploadFile() async {
    final wsId = ref.read(currentWorkspaceIdProvider);
    if (wsId == null) return;
    final picked = await FilePicker.platform.pickFiles(withData: true);
    if (picked == null || picked.files.isEmpty) return;
    final file = picked.files.first;
    final bytes = file.bytes;
    if (bytes == null) return;
    setState(() => _uploading = true);
    try {
      await ref.read(apiClientProvider).uploadFile(
            workspaceId: wsId,
            bytes: bytes,
            fileName: file.name,
          );
      await _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('上傳失敗：$e')));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _deleteFile(Map<String, dynamic> item) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('刪除檔案'),
        content: Text('確定刪除「${item['fileName']}」？'),
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
      await ref.read(apiClientProvider).deleteFile(item['id'] as String);
      await _fetch();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('刪除失敗：$e')));
      }
    }
  }

  Future<void> _openFile(Map<String, dynamic> item) async {
    final mime = (item['fileType'] as String?) ?? '';
    final url = _resolveUrl(item['url'] as String? ?? '');
    if (mime.startsWith('image/')) {
      if (!mounted) return;
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => ImageViewerPage(url: url, title: item['fileName'] as String? ?? '圖片'),
      ));
      return;
    }
    // 其它類型（PDF / Office / 影音…）一律走 OS 處理器
    final uri = Uri.tryParse(url);
    if (uri == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('無法解析檔案連結')));
      }
      return;
    }
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('無法打開檔案')));
    }
  }

  /// DB 存的 url 是 `host:port/bucket/key` 而沒有 scheme，補上 http://。
  String _resolveUrl(String raw) {
    if (raw.isEmpty) return raw;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    return 'http://$raw';
  }

  IconData _iconFor(String mime) {
    if (mime.startsWith('image/')) return Icons.image_outlined;
    if (mime == 'application/pdf') return Icons.picture_as_pdf;
    if (mime.startsWith('video/')) return Icons.movie_outlined;
    if (mime.startsWith('audio/')) return Icons.music_note_outlined;
    if (mime.contains('sheet') || mime.contains('excel') || mime.contains('csv')) {
      return Icons.grid_on;
    }
    if (mime.contains('presentation') || mime.contains('powerpoint')) {
      return Icons.slideshow;
    }
    if (mime.contains('word') || mime.startsWith('text/') || mime.contains('opendocument')) {
      return Icons.description_outlined;
    }
    return Icons.insert_drive_file_outlined;
  }

  Color _colorFor(String mime) {
    if (mime.startsWith('image/')) return const Color(0xFF10B981);
    if (mime == 'application/pdf') return const Color(0xFFEF4444);
    if (mime.startsWith('video/')) return const Color(0xFF8B5CF6);
    if (mime.startsWith('audio/')) return const Color(0xFFF59E0B);
    if (mime.contains('sheet') || mime.contains('excel') || mime.contains('csv')) {
      return const Color(0xFF059669);
    }
    if (mime.contains('presentation') || mime.contains('powerpoint')) {
      return const Color(0xFFDC2626);
    }
    if (mime.contains('word') || mime.startsWith('text/') || mime.contains('opendocument')) {
      return const Color(0xFF2563EB);
    }
    return const Color(0xFF6B7280);
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1024 * 1024 * 1024) return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
    return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          _buildToolbar(),
          _buildFilterStrip(),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _items.isEmpty
                    ? _emptyState()
                    : RefreshIndicator(
                        onRefresh: _fetch,
                        child: _view == _ViewMode.grid ? _buildGrid() : _buildList(),
                      ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _uploading ? null : _uploadFile,
        icon: _uploading
            ? const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
              )
            : const Icon(Icons.upload_file),
        label: Text(_uploading ? '上傳中…' : '上傳檔案'),
      ),
    );
  }

  Widget _buildToolbar() {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Row(
        children: [
          const Text('檔案庫', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
          const SizedBox(width: 12),
          if (_total > 0)
            Text('共 $_total 筆', style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
          const Spacer(),
          SizedBox(
            width: 240,
            child: TextField(
              decoration: InputDecoration(
                hintText: '搜尋檔名…',
                prefixIcon: const Icon(Icons.search, size: 18),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 10),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
              ),
              onChanged: _onSearchChanged,
            ),
          ),
          const SizedBox(width: 8),
          IconButton(
            tooltip: _view == _ViewMode.grid ? '清單檢視' : '網格檢視',
            icon: Icon(_view == _ViewMode.grid ? Icons.view_list : Icons.grid_view),
            onPressed: () => setState(() => _view = _view == _ViewMode.grid ? _ViewMode.list : _ViewMode.grid),
          ),
          IconButton(
            tooltip: '重新載入',
            icon: const Icon(Icons.refresh),
            onPressed: _fetch,
          ),
        ],
      ),
    );
  }

  Widget _buildFilterStrip() {
    const labels = {
      _FileKind.all: '全部',
      _FileKind.image: '圖片',
      _FileKind.pdf: 'PDF',
      _FileKind.doc: '文件',
      _FileKind.video: '影片',
      _FileKind.audio: '音訊',
      _FileKind.other: '其它',
    };
    return SizedBox(
      height: 40,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        children: [
          for (final k in _FileKind.values)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                label: Text(labels[k]!),
                selected: _kind == k,
                onSelected: (_) {
                  setState(() => _kind = k);
                  _fetch();
                },
              ),
            ),
        ],
      ),
    );
  }

  Widget _emptyState() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.folder_open_outlined, size: 64, color: Colors.grey.shade400),
          const SizedBox(height: 12),
          Text(
            _search.isNotEmpty ? '找不到符合的檔案' : '目前還沒有檔案',
            style: TextStyle(color: Colors.grey.shade600, fontSize: 15),
          ),
          const SizedBox(height: 8),
          if (_search.isEmpty)
            TextButton.icon(
              icon: const Icon(Icons.upload_file),
              label: const Text('上傳第一個檔案'),
              onPressed: _uploadFile,
            ),
        ],
      ),
    );
  }

  Widget _buildGrid() {
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 180,
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: 0.85,
      ),
      itemCount: _items.length,
      itemBuilder: (_, i) => _gridTile(_items[i]),
    );
  }

  Widget _gridTile(Map<String, dynamic> item) {
    final mime = (item['fileType'] as String?) ?? '';
    final isImage = mime.startsWith('image/');
    final url = _resolveUrl((item['url'] as String?) ?? '');
    return InkWell(
      onTap: () => _openFile(item),
      borderRadius: BorderRadius.circular(8),
      child: Container(
        decoration: BoxDecoration(
          border: Border.all(color: Colors.grey.shade300),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
                child: Container(
                  color: _colorFor(mime).withOpacity(0.08),
                  child: isImage
                      ? Image.network(
                          url,
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => _iconPlaceholder(mime),
                          loadingBuilder: (_, child, p) =>
                              p == null ? child : _iconPlaceholder(mime),
                        )
                      : _iconPlaceholder(mime),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 4, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          (item['fileName'] as String?) ?? '',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
                        ),
                        Text(
                          _formatSize((item['fileSize'] as int?) ?? 0),
                          style: TextStyle(fontSize: 10, color: Colors.grey.shade600),
                        ),
                      ],
                    ),
                  ),
                  PopupMenuButton<String>(
                    padding: EdgeInsets.zero,
                    iconSize: 16,
                    onSelected: (v) {
                      if (v == 'delete') _deleteFile(item);
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'delete', child: Text('刪除', style: TextStyle(color: Colors.red))),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _iconPlaceholder(String mime) {
    return Center(
      child: Icon(_iconFor(mime), size: 42, color: _colorFor(mime)),
    );
  }

  Widget _buildList() {
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
      itemCount: _items.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, i) {
        final item = _items[i];
        final mime = (item['fileType'] as String?) ?? '';
        final uploader = item['uploader'] as Map?;
        return ListTile(
          leading: Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: _colorFor(mime).withOpacity(0.12),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(_iconFor(mime), color: _colorFor(mime)),
          ),
          title: Text(
            (item['fileName'] as String?) ?? '',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            [
              _formatSize((item['fileSize'] as int?) ?? 0),
              if (uploader?['displayName'] != null) '上傳者：${uploader!['displayName']}',
            ].join(' · '),
            style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
          ),
          trailing: PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'delete') _deleteFile(item);
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'delete', child: Text('刪除', style: TextStyle(color: Colors.red))),
            ],
          ),
          onTap: () => _openFile(item),
        );
      },
    );
  }
}
