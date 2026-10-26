import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

import '../../../core/network/api_client.dart';
import 'browser_window.dart';
import 'pkce.dart';
import 'sso_callback.dart';

/// `GET /api/auth/config` (public).
class AuthConfig {
  const AuthConfig({
    required this.sso,
    required this.passwordLogin,
    this.endSessionUrl,
  });

  factory AuthConfig.fromJson(Map<String, dynamic> json) {
    final end = json['endSessionUrl'];
    return AuthConfig(
      sso: json['sso'] == true,
      passwordLogin: json['passwordLogin'] == true,
      endSessionUrl: end is String && end.trim().isNotEmpty ? end.trim() : null,
    );
  }

  final bool sso;
  final bool passwordLogin;

  /// Where web logout sends the browser so the IdP session ends too.
  final String? endSessionUrl;
}

final authConfigProvider = FutureProvider<AuthConfig>((ref) async {
  final json = await ref.watch(apiClientProvider).getAuthConfig();
  return AuthConfig.fromJson(json);
});

/// Holds the PKCE verifier between "start" and "exchange".
abstract class VerifierStore {
  void save(String verifier);

  /// Returns the saved verifier and removes it (one use only).
  String? take();
}

class MemoryVerifierStore implements VerifierStore {
  String? _value;

  @override
  void save(String verifier) => _value = verifier;

  @override
  String? take() {
    final v = _value;
    _value = null;
    return v;
  }
}

/// Web: the page navigates away to the IdP and comes back as a fresh app
/// instance, so the verifier survives in `sessionStorage` (same tab only).
class SessionVerifierStore implements VerifierStore {
  SessionVerifierStore(this._window);

  static const key = 'oidea_oidc_verifier';

  final BrowserWindow? _window;

  @override
  void save(String verifier) => _window?.sessionSet(key, verifier);

  @override
  String? take() {
    final w = _window;
    if (w == null) return null;
    final v = w.sessionGet(key);
    w.sessionRemove(key);
    return v;
  }
}

/// Opens the auth session on mobile and returns the final callback URL.
typedef MobileWebAuth = Future<String> Function(String url, String callbackUrlScheme);

/// Result of a mobile SSO round trip.
class SsoMobileResult {
  const SsoMobileResult(this.callback, this.verifier);
  final SsoCallback callback;
  final String verifier;

  @override
  String toString() => 'SsoMobileResult($callback, verifier: <redacted>)';
}

/// The callback the web app was opened with (captured in `main()` before the
/// router starts). Taken once.
class PendingSsoCallback {
  PendingSsoCallback([this._value]);

  SsoCallback? _value;

  SsoCallback? take() {
    final v = _value;
    _value = null;
    return v;
  }
}

final pendingSsoCallbackProvider = Provider<PendingSsoCallback>((ref) => PendingSsoCallback());

const ssoCallbackPath = '/auth/callback';

/// Web only, call first thing in `main()`.
///
/// When the backend redirected to `<app>/auth/callback#ticket=…|#error=…`,
/// reads the fragment and immediately rewrites the address bar to the hash
/// route `#/auth/callback` (the app uses Flutter's default hash URL strategy),
/// so the ticket no longer sits in the URL, history or anything the page
/// later loads. Returns null when the app was not opened on the callback.
SsoCallback? captureWebSsoCallback(BrowserWindow? window) {
  if (window == null) return null;
  final path = window.pathname;
  if (!path.endsWith(ssoCallbackPath)) return null;
  final callback = parseSsoParams(window.hash);
  final base = path.substring(0, path.length - ssoCallbackPath.length);
  window.replaceState('$base/#$ssoCallbackPath');
  return callback;
}

class SsoService {
  SsoService({
    required this.apiBaseUrl,
    required this.isWeb,
    required this.webVerifiers,
    this.browser,
    MobileWebAuth? mobileAuth,
    Random? random,
  })  : _mobileAuth = mobileAuth,
        _random = random;

  /// Same base as ApiClient, with trailing slash (e.g. `https://x/api/`).
  final String apiBaseUrl;
  final bool isWeb;
  final VerifierStore webVerifiers;
  final BrowserWindow? browser;
  final MobileWebAuth? _mobileAuth;
  final Random? _random;

  static const callbackScheme = 'oidea';

  Uri startUri(String challenge) {
    final base = apiBaseUrl.endsWith('/') ? apiBaseUrl : '$apiBaseUrl/';
    return Uri.parse('${base}auth/oidc/start').replace(queryParameters: {
      'client': isWeb ? 'web' : 'mobile',
      'app_challenge': challenge,
    });
  }

  /// Web: saves the verifier in sessionStorage and navigates this tab to the
  /// backend; returns null (the page is being replaced).
  /// Mobile: runs the system auth session and returns its callback together
  /// with the in-memory verifier. Throws what the auth session throws
  /// (e.g. `PlatformException(code: 'CANCELED')`).
  Future<SsoMobileResult?> start() async {
    final verifier = generatePkceVerifier(random: _random);
    final url = startUri(pkceChallengeS256(verifier)).toString();
    if (isWeb) {
      final w = browser;
      if (w == null) throw StateError('no browser window');
      webVerifiers.save(verifier);
      w.assign(url);
      return null;
    }
    final auth = _mobileAuth;
    if (auth == null) throw StateError('no mobile auth');
    final result = await auth(url, callbackScheme);
    return SsoMobileResult(parseSsoCallbackUrl(result), verifier);
  }

  /// Web: the verifier saved by [start] in this tab, removed on read.
  String? takeWebVerifier() => webVerifiers.take();

  /// Web logout: sends the browser to the IdP end-session URL. Ignored off
  /// web, when [url] is absent, or when it is not an absolute http(s) URL.
  bool endBrowserSession(String? url) {
    if (!isWeb || url == null) return false;
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasAuthority || (uri.scheme != 'https' && uri.scheme != 'http')) {
      return false;
    }
    final w = browser;
    if (w == null) return false;
    w.assign(uri.toString());
    return true;
  }
}

final ssoServiceProvider = Provider<SsoService>((ref) {
  final window = currentBrowserWindow();
  return SsoService(
    apiBaseUrl: resolvedRestBaseUrl(),
    isWeb: kIsWeb,
    browser: window,
    webVerifiers: SessionVerifierStore(window),
    mobileAuth: (url, scheme) => FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: scheme),
  );
});
