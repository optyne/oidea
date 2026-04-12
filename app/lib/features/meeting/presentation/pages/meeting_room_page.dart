import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../providers/meeting_provider.dart';

class MeetingRoomPage extends ConsumerStatefulWidget {
  final String meetingId;
  const MeetingRoomPage({super.key, required this.meetingId});

  @override
  ConsumerState<MeetingRoomPage> createState() => _MeetingRoomPageState();
}

class _MeetingRoomPageState extends ConsumerState<MeetingRoomPage> {
  bool _isMuted = false;
  bool _isCameraOn = true;
  bool _isScreenSharing = false;

  @override
  Widget build(BuildContext context) {
    final meetingAsync = ref.watch(meetingProvider(widget.meetingId));

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.grey.shade900,
        title: meetingAsync.when(
          data: (m) => Text(m['title'] ?? '會議', style: const TextStyle(color: Colors.white)),
          loading: () => const Text('載入中...', style: TextStyle(color: Colors.white)),
          error: (_, __) => const Text('會議', style: TextStyle(color: Colors.white)),
        ),
        actions: [
          IconButton(icon: const Icon(Icons.people, color: Colors.white), onPressed: () {}),
          IconButton(icon: const Icon(Icons.chat, color: Colors.white), onPressed: () {}),
          IconButton(icon: const Icon(Icons.more_vert, color: Colors.white), onPressed: () {}),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: meetingAsync.when(
              loading: () => const Center(child: CircularProgressIndicator(color: Colors.white)),
              error: (e, _) => Center(child: Text('Error: $e', style: const TextStyle(color: Colors.white))),
              data: (meeting) {
                final participants = (meeting['participants'] as List<dynamic>?) ?? [];

                return GridView.builder(
                  padding: const EdgeInsets.all(8),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    mainAxisSpacing: 8,
                    crossAxisSpacing: 8,
                  ),
                  itemCount: participants.length,
                  itemBuilder: (context, index) {
                    final participant = participants[index] as Map<String, dynamic>;
                    final user = participant['user'] as Map<String, dynamic>?;

                    return Container(
                      decoration: BoxDecoration(
                        color: Colors.grey.shade800,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Stack(
                        children: [
                          Center(
                            child: _isCameraOn
                                ? Container(
                                    color: Colors.grey.shade700,
                                    child: const Center(
                                      child: Icon(Icons.videocam, size: 48, color: Colors.white54),
                                    ),
                                  )
                                : UserAvatar(
                                    name: user?['displayName'] ?? '?',
                                    radius: 40,
                                  ),
                          ),
                          Positioned(
                            bottom: 8,
                            left: 8,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: Colors.black54,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    user?['displayName'] ?? 'Unknown',
                                    style: const TextStyle(color: Colors.white, fontSize: 12),
                                  ),
                                  if (participant['role'] == 'organizer') ...[
                                    const SizedBox(width: 4),
                                    const Icon(Icons.star, size: 12, color: Colors.amber),
                                  ],
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                );
              },
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            color: Colors.grey.shade900,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _ControlButton(
                  icon: _isMuted ? Icons.mic_off : Icons.mic,
                  isActive: _isMuted,
                  onTap: () => setState(() => _isMuted = !_isMuted),
                ),
                const SizedBox(width: 16),
                _ControlButton(
                  icon: _isCameraOn ? Icons.videocam : Icons.videocam_off,
                  isActive: !_isCameraOn,
                  onTap: () => setState(() => _isCameraOn = !_isCameraOn),
                ),
                const SizedBox(width: 16),
                _ControlButton(
                  icon: _isScreenSharing ? Icons.stop_screen_share : Icons.screen_share,
                  isActive: _isScreenSharing,
                  onTap: () => setState(() => _isScreenSharing = !_isScreenSharing),
                ),
                const SizedBox(width: 32),
                _ControlButton(
                  icon: Icons.call_end,
                  isActive: true,
                  activeColor: Colors.red,
                  onTap: () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ControlButton extends StatelessWidget {
  final IconData icon;
  final bool isActive;
  final Color activeColor;
  final VoidCallback onTap;
  const _ControlButton({
    required this.icon,
    required this.isActive,
    this.activeColor = Colors.white,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: isActive ? activeColor.withOpacity(0.2) : Colors.grey.shade700,
          shape: BoxShape.circle,
        ),
        child: Icon(icon, color: isActive ? activeColor : Colors.white, size: 24),
      ),
    );
  }
}
