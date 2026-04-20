import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/notifications/providers/notifications_provider.dart';
import '../../features/notifications/presentation/pages/notifications_page.dart';

class NotificationBadge extends ConsumerWidget {
  const NotificationBadge({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final countAsync = ref.watch(unreadNotificationCountProvider);
    final count = countAsync.maybeWhen(data: (v) => v, orElse: () => 0);

    return Stack(
      clipBehavior: Clip.none,
      children: [
        IconButton(
          icon: const Icon(Icons.notifications_outlined),
          tooltip: '通知',
          onPressed: () {
            Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const NotificationsPage()),
            );
          },
        ),
        if (count > 0)
          Positioned(
            right: 4,
            top: 4,
            child: IgnorePointer(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
                decoration: BoxDecoration(
                  color: Colors.red,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Text(
                  count > 99 ? '99+' : '$count',
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                  ),
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          ),
      ],
    );
  }
}
