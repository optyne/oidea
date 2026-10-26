import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/router/app_router.dart';
import 'package:oidea/features/auth/sso/pkce.dart';
import 'package:oidea/features/auth/sso/sso_callback.dart';
import 'package:oidea/features/auth/sso/sso_service.dart';

import 'support/sso_fakes.dart';

void main() {
  group('parseSsoParams', () {
    test('ticket', () {
      final r = parseSsoParams('#ticket=abc123');
      expect(r, isA<SsoTicket>());
      expect((r as SsoTicket).ticket, 'abc123');
    });

    test('error', () {
      final r = parseSsoParams('#error=not_employee');
      expect(r, isA<SsoError>());
      expect((r as SsoError).code, 'not_employee');
    });

    test('missing (empty, unrelated params, empty values)', () {
      expect(parseSsoParams(''), isA<SsoMissing>());
      expect(parseSsoParams('#'), isA<SsoMissing>());
      expect(parseSsoParams('#foo=bar'), isA<SsoMissing>());
      expect(parseSsoParams('#ticket=&error='), isA<SsoMissing>());
      expect(parseSsoParams('#/chat'), isA<SsoMissing>());
    });

    test('both: error wins, ticket is never exchanged', () {
      final r = parseSsoParams('#ticket=abc&error=expired');
      expect(r, isA<SsoError>());
      expect((r as SsoError).code, 'expired');
    });

    test('accepts a query string and percent-encoding', () {
      final r = parseSsoParams('?ticket=a%2Bb');
      expect((r as SsoTicket).ticket, 'a+b');
    });

    test('toString never contains the ticket', () {
      expect(const SsoTicket('secret-ticket').toString().contains('secret-ticket'), isFalse);
    });
  });

  group('parseSsoCallbackUrl (mobile)', () {
    test('oidea://auth?ticket=…', () {
      final r = parseSsoCallbackUrl('oidea://auth?ticket=t1');
      expect((r as SsoTicket).ticket, 't1');
    });

    test('oidea://auth?error=…', () {
      final r = parseSsoCallbackUrl('oidea://auth?error=terminated');
      expect((r as SsoError).code, 'terminated');
    });

    test('nothing', () {
      expect(parseSsoCallbackUrl('oidea://auth'), isA<SsoMissing>());
    });
  });

  group('ssoErrorMessage', () {
    test('maps every contract code', () {
      expect(ssoErrorMessage('not_employee'), '此帳號尚未建立員工資料，請聯絡人資');
      expect(ssoErrorMessage('terminated'), '此帳號已停用，請聯絡人資');
      expect(ssoErrorMessage('disabled'), '此帳號已停用，請聯絡人資');
      expect(ssoErrorMessage('profile_bound'), '此員工資料已綁定其他帳號，請聯絡人資');
      expect(ssoErrorMessage('email_unverified'), '公司信箱尚未驗證');
      expect(ssoErrorMessage('invalid_state'), '登入逾時，請再試一次');
      expect(ssoErrorMessage('expired'), '登入逾時，請再試一次');
      expect(ssoErrorMessage('something_new'), '登入失敗，請稍後再試');
      expect(ssoErrorMessage(''), '登入失敗，請稍後再試');
    });
  });

  group('captureWebSsoCallback', () {
    test('reads the fragment and removes it from the address bar', () {
      final w = FakeBrowserWindow(pathname: '/auth/callback', hash: '#ticket=tk-1');
      final r = captureWebSsoCallback(w);
      expect((r as SsoTicket).ticket, 'tk-1');
      expect(w.replaced, ['/#/auth/callback']);
      expect(w.hash.contains('tk-1'), isFalse);
      expect(w.pathname, '/');
    });

    test('keeps a sub-path base', () {
      final w = FakeBrowserWindow(pathname: '/app/auth/callback', hash: '#error=expired');
      final r = captureWebSsoCallback(w);
      expect((r as SsoError).code, 'expired');
      expect(w.replaced, ['/app/#/auth/callback']);
    });

    test('does nothing elsewhere or off web', () {
      final w = FakeBrowserWindow(pathname: '/', hash: '#/chat');
      expect(captureWebSsoCallback(w), isNull);
      expect(w.replaced, isEmpty);
      expect(captureWebSsoCallback(null), isNull);
    });
  });

  group('SsoService', () {
    SsoService web(FakeBrowserWindow w) => SsoService(
          apiBaseUrl: 'https://api.example.com/api/',
          isWeb: true,
          browser: w,
          webVerifiers: SessionVerifierStore(w),
        );

    test('web start saves the verifier in sessionStorage and navigates with its S256 challenge', () async {
      final w = FakeBrowserWindow();
      final result = await web(w).start();
      expect(result, isNull);
      final verifier = w.session[SessionVerifierStore.key];
      expect(verifier, isNotNull);
      expect(verifier!.length, inInclusiveRange(43, 128));
      expect(w.assigned, hasLength(1));
      final uri = Uri.parse(w.assigned.single);
      expect(uri.origin + uri.path, 'https://api.example.com/api/auth/oidc/start');
      expect(uri.queryParameters['client'], 'web');
      expect(uri.queryParameters['app_challenge'], pkceChallengeS256(verifier));
      expect(w.assigned.single.contains(verifier), isFalse);
    });

    test('takeWebVerifier returns the verifier once and removes it from storage', () async {
      final w = FakeBrowserWindow();
      final s = web(w);
      await s.start();
      final saved = w.session[SessionVerifierStore.key];
      expect(s.takeWebVerifier(), saved);
      expect(w.session.containsKey(SessionVerifierStore.key), isFalse);
      expect(s.takeWebVerifier(), isNull);
    });

    test('mobile start uses the oidea scheme and keeps the verifier in memory', () async {
      String? openedUrl;
      String? scheme;
      final s = SsoService(
        apiBaseUrl: 'https://api.example.com/api/',
        isWeb: false,
        webVerifiers: MemoryVerifierStore(),
        mobileAuth: (url, s) async {
          openedUrl = url;
          scheme = s;
          return 'oidea://auth?ticket=m-1';
        },
      );
      final r = await s.start();
      expect(scheme, 'oidea');
      final uri = Uri.parse(openedUrl!);
      expect(uri.queryParameters['client'], 'mobile');
      expect(uri.queryParameters['app_challenge'], pkceChallengeS256(r!.verifier));
      expect((r.callback as SsoTicket).ticket, 'm-1');
      expect(r.toString().contains(r.verifier), isFalse);
    });

    test('endBrowserSession: web only, http(s) only, absent is a no-op', () {
      final w = FakeBrowserWindow();
      final s = web(w);
      expect(s.endBrowserSession(null), isFalse);
      expect(s.endBrowserSession('javascript:alert(1)'), isFalse);
      expect(s.endBrowserSession('/relative'), isFalse);
      expect(s.endBrowserSession('https://sso.example.com/end-session/'), isTrue);
      expect(w.assigned, ['https://sso.example.com/end-session/']);

      final mobile = SsoService(apiBaseUrl: 'x/', isWeb: false, webVerifiers: MemoryVerifierStore(), browser: w);
      expect(mobile.endBrowserSession('https://sso.example.com/end-session/'), isFalse);
    });
  });

  group('AuthConfig', () {
    test('endSessionUrl is optional', () {
      expect(AuthConfig.fromJson({'sso': true, 'passwordLogin': false}).endSessionUrl, isNull);
      expect(AuthConfig.fromJson({'sso': true, 'passwordLogin': false, 'endSessionUrl': null}).endSessionUrl, isNull);
      final c = AuthConfig.fromJson({'sso': true, 'passwordLogin': true, 'endSessionUrl': 'https://e/x'});
      expect(c.sso, isTrue);
      expect(c.passwordLogin, isTrue);
      expect(c.endSessionUrl, 'https://e/x');
    });
  });

  group('authRedirect', () {
    test('lets /auth/callback through unauthenticated', () {
      expect(authRedirect('/auth/callback', isAuthenticated: false), isNull);
      expect(authRedirect('/login', isAuthenticated: false), isNull);
      expect(authRedirect('/chat', isAuthenticated: false), '/login');
      expect(authRedirect('/register', isAuthenticated: false), '/login');
    });

    test('sends a logged-in user from /auth/callback to the app', () {
      expect(authRedirect('/auth/callback', isAuthenticated: true), '/chat');
      expect(authRedirect('/chat', isAuthenticated: true), isNull);
    });
  });
}
