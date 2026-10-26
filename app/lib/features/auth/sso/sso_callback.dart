/// What the backend's final SSO redirect carried.
///
/// Web: `https://<app>/auth/callback#ticket=<t>` or `#error=<code>`.
/// Mobile: `oidea://auth?ticket=<t>` or `?error=<code>`.
sealed class SsoCallback {
  const SsoCallback();
}

class SsoTicket extends SsoCallback {
  const SsoTicket(this.ticket);
  final String ticket;

  /// Never print the ticket.
  @override
  String toString() => 'SsoTicket(<redacted>)';
}

class SsoError extends SsoCallback {
  const SsoError(this.code);
  final String code;

  @override
  String toString() => 'SsoError($code)';
}

/// Neither a ticket nor an error (e.g. the user opened /auth/callback by hand).
class SsoMissing extends SsoCallback {
  const SsoMissing();
}

/// Parses `ticket=…&error=…` (a URL fragment or query, with or without the
/// leading `#` / `?`). An `error` always wins over a `ticket`: a redirect that
/// reports a failure is never exchanged.
SsoCallback parseSsoParams(String raw) {
  var s = raw;
  if (s.startsWith('#') || s.startsWith('?')) s = s.substring(1);
  Map<String, String> params;
  try {
    params = Uri.splitQueryString(s);
  } catch (_) {
    return const SsoMissing();
  }
  final error = params['error']?.trim();
  if (error != null && error.isNotEmpty) return SsoError(error);
  final ticket = params['ticket']?.trim();
  if (ticket != null && ticket.isNotEmpty) return SsoTicket(ticket);
  return const SsoMissing();
}

/// Parses the mobile callback URL returned by the auth session.
SsoCallback parseSsoCallbackUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return const SsoMissing();
  final fromQuery = parseSsoParams(uri.query);
  if (fromQuery is! SsoMissing) return fromQuery;
  return parseSsoParams(uri.fragment);
}

const ssoGenericFailure = '登入失敗，請稍後再試';
const ssoTimeoutMessage = '登入逾時，請再試一次';

const _knownSsoErrorCodes = {
  'not_employee',
  'terminated',
  'disabled',
  'profile_bound',
  'email_unverified',
  'invalid_state',
  'expired',
};

bool isKnownSsoErrorCode(String code) => _knownSsoErrorCodes.contains(code);

/// User-facing message for a backend SSO error code.
String ssoErrorMessage(String code) {
  switch (code) {
    case 'not_employee':
      return '此帳號尚未建立員工資料，請聯絡人資';
    case 'terminated':
    case 'disabled':
      return '此帳號已停用，請聯絡人資';
    case 'profile_bound':
      return '此員工資料已綁定其他帳號，請聯絡人資';
    case 'email_unverified':
      return '公司信箱尚未驗證';
    case 'invalid_state':
    case 'expired':
      return ssoTimeoutMessage;
    default:
      return ssoGenericFailure;
  }
}
