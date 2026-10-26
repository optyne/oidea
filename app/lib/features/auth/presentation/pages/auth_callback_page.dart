import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../providers/auth_provider.dart';
import '../../sso/sso_service.dart';

/// Web landing page of the SSO redirect (`/auth/callback`).
///
/// `main()` already read the fragment and cleared it from the address bar
/// ([captureWebSsoCallback]); this page exchanges the ticket once, then goes
/// to the app (success) or back to the login page, which shows the error.
class AuthCallbackPage extends ConsumerStatefulWidget {
  const AuthCallbackPage({super.key});

  @override
  ConsumerState<AuthCallbackPage> createState() => _AuthCallbackPageState();
}

class _AuthCallbackPageState extends ConsumerState<AuthCallbackPage> {
  bool _navigated = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run());
  }

  Future<void> _run() async {
    if (!mounted) return;
    final callback = ref.read(pendingSsoCallbackProvider).take();
    if (callback != null) {
      final ok = await ref.read(authStateProvider.notifier).completeWebSso(callback);
      _go(ok ? '/chat' : '/login');
      return;
    }
    // Nothing to exchange here (already handled by an earlier instance of
    // this page, or the URL was opened by hand).
    final auth = ref.read(authStateProvider);
    if (auth.isLoading) return; // the listener below navigates when done
    _go(auth.isAuthenticated ? '/chat' : '/login');
  }

  void _go(String location) {
    if (!mounted || _navigated) return;
    _navigated = true;
    context.go(location);
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<AuthState>(authStateProvider, (prev, next) {
      if (prev?.isLoading == true && !next.isLoading) {
        _go(next.isAuthenticated ? '/chat' : '/login');
      }
    });
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('正在登入…'),
          ],
        ),
      ),
    );
  }
}
