import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/network/socket_service.dart';
import '../widgets/thread_panel.dart';

/// 行動/窄螢幕的討論串全頁路由。寬版 ChannelPage 會直接在側邊嵌入 ThreadPanel。
class ThreadPage extends ConsumerStatefulWidget {
  final String channelId;
  final String parentId;
  final Map<String, dynamic>? parentSummary;

  const ThreadPage({
    super.key,
    required this.channelId,
    required this.parentId,
    this.parentSummary,
  });

  @override
  ConsumerState<ThreadPage> createState() => _ThreadPageState();
}

class _ThreadPageState extends ConsumerState<ThreadPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(socketProvider).joinChannel(widget.channelId);
    });
  }

  @override
  void dispose() {
    ref.read(socketProvider).leaveChannel(widget.channelId);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('討論串'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.pop(),
        ),
      ),
      body: ThreadPanel(
        channelId: widget.channelId,
        parentId: widget.parentId,
        parentSummary: widget.parentSummary,
        showHeader: false,
      ),
    );
  }
}
