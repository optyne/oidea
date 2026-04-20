import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/presentation/pages/login_page.dart';
import '../../features/auth/presentation/pages/register_page.dart';
import '../../features/auth/providers/auth_provider.dart';
import '../../features/chat/presentation/pages/chat_home_page.dart';
import '../../features/chat/presentation/pages/channel_page.dart';
import '../../features/chat/presentation/pages/thread_page.dart';
import '../../features/project/presentation/pages/project_home_page.dart';
import '../../features/project/presentation/pages/board_page.dart';
import '../../features/project/presentation/pages/task_detail_page.dart';
import '../../features/meeting/presentation/pages/meeting_home_page.dart';
import '../../features/meeting/presentation/pages/meeting_room_page.dart';
import '../../features/whiteboard/presentation/pages/whiteboard_home_page.dart';
import '../../features/whiteboard/presentation/pages/whiteboard_canvas_page.dart';
import '../../features/erp/presentation/pages/erp_home_page.dart';
import '../../features/erp/presentation/pages/attendance_page.dart';
import '../../features/erp/presentation/pages/expenses_page.dart';
import '../../features/erp/presentation/pages/leaves_page.dart';
import '../../features/erp/presentation/pages/members_page.dart';
import '../../features/notes/presentation/pages/notes_home_page.dart';
import '../../shared/pages/main_shell.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final authState = ref.watch(authStateProvider);

  return GoRouter(
    initialLocation: '/chat',
    redirect: (context, state) {
      final isLoggingIn = state.matchedLocation == '/login' ||
          state.matchedLocation == '/register';
      final isAuthenticated = authState.isAuthenticated;

      if (!isAuthenticated && !isLoggingIn) return '/login';
      if (isAuthenticated && isLoggingIn) return '/chat';
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginPage()),
      GoRoute(path: '/register', builder: (context, state) => const RegisterPage()),
      ShellRoute(
        builder: (context, state, child) => MainShell(child: child),
        routes: [
          GoRoute(
            path: '/chat',
            builder: (context, state) => const ChatHomePage(),
            routes: [
              GoRoute(
                path: 'channel/:channelId',
                builder: (context, state) => ChannelPage(
                  channelId: state.pathParameters['channelId']!,
                ),
                routes: [
                  GoRoute(
                    path: 'thread/:parentId',
                    builder: (context, state) {
                      final extra = state.extra;
                      Map<String, dynamic>? parentSummary;
                      if (extra is Map<String, dynamic>) {
                        parentSummary = extra;
                      }
                      return ThreadPage(
                        channelId: state.pathParameters['channelId']!,
                        parentId: state.pathParameters['parentId']!,
                        parentSummary: parentSummary,
                      );
                    },
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: '/projects',
            builder: (context, state) => const ProjectHomePage(),
            routes: [
              GoRoute(
                path: 'board/:projectId',
                builder: (context, state) => BoardPage(
                  projectId: state.pathParameters['projectId']!,
                ),
                routes: [
                  GoRoute(
                    path: 'task/:taskId',
                    builder: (context, state) => TaskDetailPage(
                      taskId: state.pathParameters['taskId']!,
                    ),
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: '/meetings',
            builder: (context, state) => const MeetingHomePage(),
            routes: [
              GoRoute(
                path: 'room/:meetingId',
                builder: (context, state) => MeetingRoomPage(
                  meetingId: state.pathParameters['meetingId']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/whiteboard',
            builder: (context, state) => const WhiteboardHomePage(),
            routes: [
              GoRoute(
                path: 'canvas/:boardId',
                builder: (context, state) => WhiteboardCanvasPage(
                  boardId: state.pathParameters['boardId']!,
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/notes',
            builder: (context, state) => const NotesHomePage(),
          ),
          GoRoute(
            path: '/erp',
            builder: (context, state) => const ErpHomePage(),
            routes: [
              GoRoute(
                path: 'attendance',
                builder: (context, state) => const AttendancePage(),
              ),
              GoRoute(
                path: 'expenses',
                builder: (context, state) => const ExpensesPage(),
              ),
              GoRoute(
                path: 'leaves',
                builder: (context, state) => const LeavesPage(),
              ),
              GoRoute(
                path: 'members',
                builder: (context, state) => const MembersPage(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
