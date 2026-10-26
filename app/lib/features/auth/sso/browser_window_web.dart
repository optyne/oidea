import 'dart:js_interop';

import 'browser_window.dart';

@JS('window.location')
external _Location get _location;

@JS('window.history')
external _History get _history;

@JS('window.sessionStorage')
external _Storage get _sessionStorage;

extension type _Location(JSObject _) implements JSObject {
  external String get pathname;
  external String get hash;
  external void assign(String url);
}

extension type _History(JSObject _) implements JSObject {
  external void replaceState(JSAny? data, String unused, String url);
}

extension type _Storage(JSObject _) implements JSObject {
  external JSString? getItem(String key);
  external void setItem(String key, String value);
  external void removeItem(String key);
}

class _WebBrowserWindow implements BrowserWindow {
  @override
  String get pathname => _location.pathname;

  @override
  String get hash => _location.hash;

  @override
  void replaceState(String url) => _history.replaceState(null, '', url);

  @override
  void assign(String url) => _location.assign(url);

  @override
  String? sessionGet(String key) {
    try {
      return _sessionStorage.getItem(key)?.toDart;
    } catch (_) {
      return null;
    }
  }

  @override
  void sessionSet(String key, String value) {
    try {
      _sessionStorage.setItem(key, value);
    } catch (_) {}
  }

  @override
  void sessionRemove(String key) {
    try {
      _sessionStorage.removeItem(key);
    } catch (_) {}
  }
}

BrowserWindow? createBrowserWindow() => _WebBrowserWindow();
