import 'dart:convert';
import 'dart:math';

import 'sha256.dart';

/// PKCE helpers (RFC 7636) for the app ↔ backend leg of SSO.
///
/// The app keeps `app_verifier` and sends only `app_challenge` to
/// `/auth/oidc/start`; the backend binds the ticket to the challenge, so a
/// ticket intercepted on the way back (e.g. another app claiming the
/// `oidea://` scheme) cannot be exchanged without the verifier.

String _base64UrlNoPad(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

/// Random verifier: 32 random bytes, base64url without padding (43 chars,
/// within RFC 7636's 43–128 and its unreserved character set).
String generatePkceVerifier({Random? random}) {
  final rng = random ?? Random.secure();
  final bytes = List<int>.generate(32, (_) => rng.nextInt(256));
  return _base64UrlNoPad(bytes);
}

/// `base64url(sha256(ascii(verifier)))` without padding (S256).
String pkceChallengeS256(String verifier) => _base64UrlNoPad(sha256(ascii.encode(verifier)));
