import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/network/api_client.dart';

/// 頻道訊息關鍵字搜尋（防抖後呼叫 API）。
class ChannelSearchDelegate extends SearchDelegate<void> {
  ChannelSearchDelegate({required this.channelId});

  final String channelId;

  @override
  String get searchFieldLabel => '搜尋訊息';

  @override
  List<Widget>? buildActions(BuildContext context) {
    return [
      if (query.isNotEmpty)
        IconButton(
          icon: const Icon(Icons.clear),
          onPressed: () {
            query = '';
            showSuggestions(context);
          },
        ),
    ];
  }

  @override
  Widget? buildLeading(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.arrow_back),
      onPressed: () => close(context, null),
    );
  }

  @override
  Widget buildResults(BuildContext context) {
    return _SearchBody(
      channelId: channelId,
      query: query,
    );
  }

  @override
  Widget buildSuggestions(BuildContext context) {
    return _SearchBody(
      channelId: channelId,
      query: query,
    );
  }
}

class _SearchBody extends ConsumerStatefulWidget {
  const _SearchBody({
    required this.channelId,
    required this.query,
  });

  final String channelId;
  final String query;

  @override
  ConsumerState<_SearchBody> createState() => _SearchBodyState();
}

class _SearchBodyState extends ConsumerState<_SearchBody> {
  Timer? _debounce;
  String _lastFetched = '';
  Future<List<dynamic>>? _future;

  @override
  void didUpdateWidget(covariant _SearchBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.query != widget.query) {
      _schedule();
    }
  }

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  void _schedule() {
    _debounce?.cancel();
    final q = widget.query.trim();
    if (q.isEmpty) {
      setState(() {
        _future = null;
        _lastFetched = '';
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      setState(() {
        _lastFetched = q;
        _future = ref.read(apiClientProvider).searchMessages(widget.channelId, q);
      });
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final q = widget.query.trim();
    if (q.isEmpty) {
      return const Center(child: Text('輸入關鍵字以搜尋此頻道訊息'));
    }

    final fut = _future;
    if (fut == null || _lastFetched != q) {
      return const Center(child: CircularProgressIndicator.adaptive());
    }

    return FutureBuilder<List<dynamic>>(
      future: fut,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator.adaptive());
        }
        if (snap.hasError) {
          return Center(child: Text('錯誤：${snap.error}'));
        }
        final list = snap.data ?? [];
        if (list.isEmpty) {
          return const Center(child: Text('沒有符合的訊息'));
        }
        return ListView.separated(
          itemCount: list.length,
          separatorBuilder: (_, __) => const Divider(height: 1),
          itemBuilder: (context, index) {
            final msg = list[index] as Map<String, dynamic>;
            final sender = msg['sender'] as Map<String, dynamic>?;
            final preview = (msg['content'] as String? ?? '').replaceAll('\n', ' ');
            return ListTile(
              title: Text(
                preview,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(sender?['displayName'] as String? ?? '?'),
            );
          },
        );
      },
    );
  }
}
