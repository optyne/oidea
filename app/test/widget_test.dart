import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:oidea/features/auth/sso/sso_service.dart';
import 'package:oidea/main.dart';

void main() {
  testWidgets('App boots', (WidgetTester tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        // The login page fetches auth/config; keep this smoke test off the network.
        authConfigProvider.overrideWith((ref) async => const AuthConfig(sso: true, passwordLogin: false)),
      ],
      child: const OideaApp(),
    ));
    await tester.pump();
    expect(find.byType(OideaApp), findsOneWidget);
  });
}
