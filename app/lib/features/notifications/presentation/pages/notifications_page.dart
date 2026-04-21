import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../../../core/network/api_client.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../providers/notifications_provider.dart';

class NotificationsPage extends ConsumerWidget {
  const NotificationsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final listAsync = ref.watch(notificationsListProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('通知'),
        actions: [
          IconButton(
            icon: const Icon(Icons.done_all),
            tooltip: '全部標為已讀',
            onPressed: () async {
              await ref.read(apiClientProvider).markAllNotificationsRead();
              ref.invalidate(notificationsListProvider);
              ref.invalidate(unreadNotificationCountProvider);
            },
          ),
        ],
      ),
      body: listAsync.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(message: e.toString()),
        data: (list) {
          if (list.isEmpty) {
            return const EmptyStateWidget(
              icon: Icons.notifications_none,
              title: '目前沒有通知',
              subtitle: '被提及或指派任務時會出現在這裡',
            );
          }
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(notificationsListProvider);
              await ref.read(notificationsListProvider.future);
            },
            child: ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, index) {
                final n = list[index] as Map<String, dynamic>;
                final read = n['read'] == true;
                final createdAt = DateTime.tryParse(n['createdAt']?.toString() ?? '');
                return ListTile(
                  leading: CircleAvatar(
                    backgroundColor: _typeColor(n['type'] as String?),
                    child: Icon(_typeIcon(n['type'] as String?), color: Colors.white, size: 20),
                  ),
                  title: Text(
                    n['title'] as String? ?? '',
                    style: TextStyle(fontWeight: read ? FontWeight.normal : FontWeight.w600),
                  ),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if ((n['content'] as String?)?.isNotEmpty == true)
                        Text(n['content'] as String, maxLines: 2, overflow: TextOverflow.ellipsis),
                      if (createdAt != null)
                        Text(
                          timeago.format(createdAt, locale: 'zh_TW'),
                          style: TextStyle(fontSize: 11, color: Colors.grey.shade500),
                        ),
                    ],
                  ),
                  trailing: read
                      ? null
                      : const CircleAvatar(radius: 4, backgroundColor: Colors.blue),
                  onTap: () async {
                    if (!read) {
                      await ref.read(apiClientProvider).markNotificationRead(n['id'] as String);
                      ref.invalidate(notificationsListProvider);
                      ref.invalidate(unreadNotificationCountProvider);
                    }
                  },
                );
              },
            ),
          );
        },
      ),
    );
  }

  Color _typeColor(String? type) {
    switch (type) {
      case 'mention':
        return Colors.blue;
      case 'task_assigned':
        return Colors.orange;
      case 'meeting_invite':
        return Colors.purple;
      default:
        return Colors.grey;
    }
  }

  IconData _typeIcon(String? type) {
    switch (type) {
      case 'mention':
        return Icons.alternate_email;
      case 'task_assigned':
        return Icons.assignment_ind;
      case 'meeting_invite':
        return Icons.event;
      default:
        return Icons.notifications;
    }
  }
}
