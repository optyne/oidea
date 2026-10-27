import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:oidea/core/network/socket_service.dart';
import 'package:oidea/features/auth/sso/browser_window.dart';

class FakeBrowserWindow implements BrowserWindow {
  FakeBrowserWindow({this.pathname = '/', this.hash = ''});

  @override
  String pathname;

  @override
  String hash;

  final List<String> replaced = [];
  final List<String> assigned = [];
  final Map<String, String> session = {};

  @override
  void replaceState(String url) {
    replaced.add(url);
    final i = url.indexOf('#');
    pathname = i < 0 ? url : url.substring(0, i);
    hash = i < 0 ? '' : url.substring(i);
  }

  @override
  void assign(String url) => assigned.add(url);

  @override
  String? sessionGet(String key) => session[key];

  @override
  void sessionSet(String key, String value) => session[key] = value;

  @override
  void sessionRemove(String key) => session.remove(key);
}

typedef FakeHandler = Future<ResponseBody> Function(RequestOptions options);

class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  final FakeHandler handler;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options);
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonBody(Object body, int status) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

/// Never opens a real socket.
class FakeSocketService extends SocketService {
  FakeSocketService() : super(tokenProvider: () async => null, refreshToken: () async => null);

  int connects = 0;

  @override
  void connect() => connects++;

  @override
  void disconnect() {}
}
