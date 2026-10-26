import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/theme_mode_provider.dart';
import 'core/router/app_router.dart';
import 'features/auth/sso/browser_window.dart';
import 'features/auth/sso/sso_service.dart';

void main() {
  // Web SSO: read the ticket from `/auth/callback#ticket=…` and clear it from
  // the address bar before anything else runs (no-op off web).
  final ssoCallback = captureWebSsoCallback(currentBrowserWindow());
  WidgetsFlutterBinding.ensureInitialized();
  runApp(ProviderScope(
    overrides: [
      pendingSsoCallbackProvider.overrideWithValue(PendingSsoCallback(ssoCallback)),
    ],
    child: const OideaApp(),
  ));
}

class OideaApp extends ConsumerWidget {
  const OideaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    final themeMode = ref.watch(themeModeProvider);

    return MaterialApp.router(
      title: 'Oidea',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: themeMode,
      routerConfig: router,
    );
  }
}
