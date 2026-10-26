import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/core/network/auth_session.dart';
import 'package:oidea/core/network/socket_service.dart';
import 'package:oidea/features/auth/presentation/pages/auth_callback_page.dart';
import 'package:oidea/features/auth/presentation/pages/login_page.dart';
import 'package:oidea/features/auth/providers/auth_provider.dart';
import 'package:oidea/features/auth/sso/pkce.dart';
import 'package:oidea/features/auth/sso/sso_callback.dart';
import 'package:oidea/features/auth/sso/sso_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/sso_fakes.dart';

const _verifier = 'VERIFIER-dBjftJeZ4CVP-mJ0kSnUVtw7a0BGYD-ZXyBmh5l3lfs';
const _ticket = 'TICKET-9f8e7d6c5b4a';
const _access = 'ACCESS-TOKEN-xyz';
const _refresh = 'REFRESH-TOKEN-xyz';

class _Harness {
  _Harness({
    SsoCallback? pending,
    this.config = const {'sso': true, 'passwordLogin': false},
    this.configStatus = 200,
    this.exchangeStatus = 201,
    this.exchangeBody,
  }) {
    adapter = FakeAdapter(_handle);
    pendingCallback = PendingSsoCallback(pending);
  }

  final MemoryTokenStore store = MemoryTokenStore();
  final FakeBrowserWindow window = FakeBrowserWindow();
  final FakeSocketService socket = FakeSocketService();
  late final FakeAdapter adapter;
  late final PendingSsoCallback pendingCallback;
  Map<String, dynamic> config;
  int configStatus;
  int exchangeStatus;
  Map<String, dynamic>? exchangeBody;

  /// Set to run the mobile flow instead of the web one.
  MobileWebAuth? mobileAuth;

  List<RequestOptions> requestsTo(String path) => adapter.requests.where((r) => r.path == path).toList();

  Future<ResponseBody> _handle(RequestOptions o) async {
    switch (o.path) {
      case 'auth/config':
        return jsonBody(configStatus == 200 ? config : {'message': 'boom'}, configStatus);
      case 'auth/oidc/exchange':
        if (exchangeStatus == 201) {
          return jsonBody({
            'accessToken': _access,
            'refreshToken': _refresh,
            'user': {'id': 'u1', 'email': 'emp@corp.example'},
          }, 201);
        }
        return jsonBody(exchangeBody ?? {'statusCode': exchangeStatus, 'message': 'Unauthorized'}, exchangeStatus);
      case 'users/me':
        return jsonBody({'id': 'u1', 'email': 'emp@corp.example', 'displayName': 'Emp'}, 200);
      case 'workspaces':
        return jsonBody(<dynamic>[], 200);
      default:
        return jsonBody({'message': 'not found'}, 404);
    }
  }

  Dio _dio() => Dio(BaseOptions(baseUrl: 'http://test/api/'))..httpClientAdapter = adapter;

  List<Override> get overrides => [
        authSessionProvider.overrideWith((ref) => AuthSession(store: store, refreshDio: _dio())),
        apiClientProvider.overrideWith((ref) {
          final dio = _dio();
          dio.interceptors.add(AuthInterceptor(ref.watch(authSessionProvider), dio));
          return ApiClient(dio);
        }),
        socketProvider.overrideWithValue(socket),
        ssoServiceProvider.overrideWithValue(SsoService(
          apiBaseUrl: 'http://test/api/',
          isWeb: mobileAuth == null,
          browser: window,
          webVerifiers: SessionVerifierStore(window),
          mobileAuth: mobileAuth,
        )),
        pendingSsoCallbackProvider.overrideWithValue(pendingCallback),
      ];

  Widget app({String initial = '/auth/callback'}) {
    final router = GoRouter(
      initialLocation: initial,
      routes: [
        GoRoute(path: '/auth/callback', builder: (_, __) => const AuthCallbackPage()),
        GoRoute(path: '/login', builder: (_, __) => const LoginPage()),
        GoRoute(path: '/chat', builder: (_, __) => const Scaffold(body: Text('CHAT-HOME'))),
      ],
    );
    return ProviderScope(overrides: overrides, child: MaterialApp.router(routerConfig: router));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('web /auth/callback page', () {
    testWidgets('ticket: exchanges once with the stored verifier, stores tokens, goes home', (tester) async {
      final h = _Harness(pending: const SsoTicket(_ticket));
      h.window.session[SessionVerifierStore.key] = _verifier;

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.text('CHAT-HOME'), findsOneWidget);
      expect(h.store.accessToken, _access);
      expect(h.store.refreshToken, _refresh);
      final exchanges = h.requestsTo('auth/oidc/exchange');
      expect(exchanges, hasLength(1));
      expect(exchanges.single.method, 'POST');
      expect(exchanges.single.data, {'ticket': _ticket, 'app_verifier': _verifier});
      expect(h.window.session.containsKey(SessionVerifierStore.key), isFalse,
          reason: 'verifier must be removed after use');
      expect(h.socket.connects, 1);
    });

    testWidgets('error code: no exchange, verifier removed, login page shows the message', (tester) async {
      final h = _Harness(pending: const SsoError('not_employee'));
      h.window.session[SessionVerifierStore.key] = _verifier;

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(find.text('此帳號尚未建立員工資料，請聯絡人資'), findsOneWidget);
      expect(h.requestsTo('auth/oidc/exchange'), isEmpty);
      expect(h.window.session.containsKey(SessionVerifierStore.key), isFalse);
      expect(h.store.accessToken, isNull);
    });

    testWidgets('exchange 401: back to login with the timeout message, no tokens', (tester) async {
      final h = _Harness(pending: const SsoTicket(_ticket), exchangeStatus: 401);
      h.window.session[SessionVerifierStore.key] = _verifier;

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(find.text('登入逾時，請再試一次'), findsOneWidget);
      expect(h.store.accessToken, isNull);
      expect(h.store.refreshToken, isNull);
      expect(h.window.session.containsKey(SessionVerifierStore.key), isFalse);
    });

    testWidgets('exchange 400 with a known code in the body uses that code', (tester) async {
      final h = _Harness(
        pending: const SsoTicket(_ticket),
        exchangeStatus: 400,
        exchangeBody: {'statusCode': 400, 'code': 'terminated'},
      );
      h.window.session[SessionVerifierStore.key] = _verifier;

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.text('此帳號已停用，請聯絡人資'), findsOneWidget);
    });

    testWidgets('ticket but no verifier (other tab / storage cleared): no exchange, timeout message', (tester) async {
      final h = _Harness(pending: const SsoTicket(_ticket));

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.text('登入逾時，請再試一次'), findsOneWidget);
      expect(h.requestsTo('auth/oidc/exchange'), isEmpty);
    });

    testWidgets('missing ticket and error: generic failure, no exchange', (tester) async {
      final h = _Harness(pending: const SsoMissing());
      h.window.session[SessionVerifierStore.key] = _verifier;

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.text('登入失敗，請稍後再試'), findsOneWidget);
      expect(h.requestsTo('auth/oidc/exchange'), isEmpty);
    });

    testWidgets('opened again with nothing pending: goes to login without an exchange', (tester) async {
      final h = _Harness();

      await tester.pumpWidget(h.app());
      await tester.pumpAndSettle();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(h.requestsTo('auth/oidc/exchange'), isEmpty);
    });
  });

  group('login page', () {
    testWidgets('sso only: shows the company button and hides the password form', (tester) async {
      final h = _Harness(config: {'sso': true, 'passwordLogin': false});
      await tester.pumpWidget(h.app(initial: '/login'));
      await tester.pumpAndSettle();

      expect(find.byKey(LoginPage.ssoButtonKey), findsOneWidget);
      expect(find.text('使用公司帳號登入'), findsOneWidget);
      expect(find.byKey(LoginPage.passwordFormKey), findsNothing);
      expect(find.text('免費建立帳號'), findsNothing);
    });

    testWidgets('sso + password login: shows both', (tester) async {
      final h = _Harness(config: {'sso': true, 'passwordLogin': true});
      await tester.pumpWidget(h.app(initial: '/login'));
      await tester.pumpAndSettle();

      expect(find.byKey(LoginPage.ssoButtonKey), findsOneWidget);
      expect(find.byKey(LoginPage.passwordFormKey), findsOneWidget);
    });

    testWidgets('password only: no company button', (tester) async {
      final h = _Harness(config: {'sso': false, 'passwordLogin': true});
      await tester.pumpWidget(h.app(initial: '/login'));
      await tester.pumpAndSettle();

      expect(find.byKey(LoginPage.ssoButtonKey), findsNothing);
      expect(find.byKey(LoginPage.passwordFormKey), findsOneWidget);
    });

    testWidgets('config fails: shows the company button and a retry that refetches', (tester) async {
      final h = _Harness(configStatus: 500);
      await tester.pumpWidget(h.app(initial: '/login'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.byKey(LoginPage.ssoButtonKey), findsOneWidget);
      expect(find.byKey(LoginPage.passwordFormKey), findsNothing);
      expect(find.byKey(LoginPage.configRetryKey), findsOneWidget);
      expect(h.requestsTo('auth/config'), hasLength(1));

      h
        ..configStatus = 200
        ..config = {'sso': true, 'passwordLogin': true};
      await tester.tap(find.byKey(LoginPage.configRetryKey));
      await tester.pumpAndSettle();

      expect(h.requestsTo('auth/config'), hasLength(2));
      expect(find.byKey(LoginPage.configRetryKey), findsNothing);
      expect(find.byKey(LoginPage.passwordFormKey), findsOneWidget);
    });

    testWidgets('company button (web): saves the verifier and navigates the tab to oidc/start', (tester) async {
      final h = _Harness();
      await tester.pumpWidget(h.app(initial: '/login'));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(LoginPage.ssoButtonKey));
      await tester.pump();

      final verifier = h.window.session[SessionVerifierStore.key];
      expect(verifier, isNotNull);
      expect(h.window.assigned, hasLength(1));
      final uri = Uri.parse(h.window.assigned.single);
      expect(uri.path, '/api/auth/oidc/start');
      expect(uri.queryParameters['client'], 'web');
      expect(uri.queryParameters.containsKey('app_challenge'), isTrue);
    });
  });

  group('mobile flow', () {
    test('auth session returns a ticket: exchanged with the in-memory verifier', () async {
      final h = _Harness();
      String? challenge;
      h.mobileAuth = (url, scheme) async {
        challenge = Uri.parse(url).queryParameters['app_challenge'];
        return 'oidea://auth?ticket=$_ticket';
      };
      final container = ProviderContainer(overrides: h.overrides);
      addTearDown(container.dispose);

      await container.read(authStateProvider.notifier).loginWithSso();

      final state = container.read(authStateProvider);
      expect(state.isAuthenticated, isTrue);
      expect(h.store.accessToken, _access);
      final body = h.requestsTo('auth/oidc/exchange').single.data as Map;
      expect(body['ticket'], _ticket);
      expect(pkceChallengeS256(body['app_verifier'] as String), challenge);
      expect(h.window.session, isEmpty, reason: 'mobile keeps the verifier in memory');
    });

    test('auth session returns an error code: message, no exchange', () async {
      final h = _Harness()..mobileAuth = (url, scheme) async => 'oidea://auth?error=profile_bound';
      final container = ProviderContainer(overrides: h.overrides);
      addTearDown(container.dispose);

      await container.read(authStateProvider.notifier).loginWithSso();

      expect(container.read(authStateProvider).error, '此員工資料已綁定其他帳號，請聯絡人資');
      expect(h.requestsTo('auth/oidc/exchange'), isEmpty);
    });

    test('user cancels the auth session: no error banner, not loading', () async {
      final h = _Harness()..mobileAuth = (url, scheme) async => throw PlatformException(code: 'CANCELED');
      final container = ProviderContainer(overrides: h.overrides);
      addTearDown(container.dispose);

      await container.read(authStateProvider.notifier).loginWithSso();

      final state = container.read(authStateProvider);
      expect(state.error, isNull);
      expect(state.isLoading, isFalse);
      expect(state.isAuthenticated, isFalse);
    });
  });

  group('secrets stay out of logs', () {
    test('no LogInterceptor on the API client', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final dio = container.read(apiClientProvider).dio;
      expect(dio.interceptors.whereType<LogInterceptor>(), isEmpty);
    });

    test('exchange (success and failure) prints nothing containing ticket, verifier or tokens', () async {
      final logs = <String>[];
      final originalDebugPrint = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) => logs.add(message ?? '');
      try {
        await runZoned(
          () async {
            for (final status in [201, 401, 500]) {
              final h = _Harness(exchangeStatus: status);
              final container = ProviderContainer(overrides: h.overrides);
              h.window.session[SessionVerifierStore.key] = _verifier;
              final notifier = container.read(authStateProvider.notifier);
              await notifier.completeWebSso(const SsoTicket(_ticket));
              final state = container.read(authStateProvider);
              logs.add(state.error ?? '');
              container.dispose();
            }
          },
          zoneSpecification: ZoneSpecification(print: (_, __, ___, line) => logs.add(line)),
        );
      } finally {
        debugPrint = originalDebugPrint;
      }
      final all = jsonEncode(logs);
      for (final secret in [_ticket, _verifier, _access, _refresh]) {
        expect(all.contains(secret), isFalse, reason: 'leaked $secret');
      }
    });
  });
}
