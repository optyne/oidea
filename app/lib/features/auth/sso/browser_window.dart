import 'browser_window_stub.dart' if (dart.library.js_interop) 'browser_window_web.dart' as impl;

/// The few browser APIs the web SSO flow needs, behind an interface so the
/// flow can be tested on the VM.
abstract class BrowserWindow {
  /// `location.pathname`, e.g. `/auth/callback`.
  String get pathname;

  /// `location.hash` including the leading `#` (empty when there is none).
  String get hash;

  /// `history.replaceState(null, '', url)`: changes the address bar without
  /// a navigation or a history entry.
  void replaceState(String url);

  /// Full-page navigation in the current tab (`location.assign`).
  void assign(String url);

  /// `sessionStorage` access. Returns null / does nothing when storage is
  /// unavailable (e.g. blocked by the browser).
  String? sessionGet(String key);
  void sessionSet(String key, String value);
  void sessionRemove(String key);
}

/// The real browser window on web, null on every other platform.
BrowserWindow? currentBrowserWindow() => impl.createBrowserWindow();
