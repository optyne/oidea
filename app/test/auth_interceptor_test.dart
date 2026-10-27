import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/core/network/auth_session.dart';

typedef _Handler = Future<ResponseBody> Function(RequestOptions options);

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.handler);

  final _Handler handler;
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

ResponseBody _json(Object body, int status) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

String _jwt(DateTime exp) {
  String seg(Map<String, dynamic> m) => base64Url.encode(utf8.encode(jsonEncode(m))).replaceAll('=', '');
  return '${seg({'alg': 'HS256'})}.${seg({'sub': 'u1', 'exp': exp.millisecondsSinceEpoch ~/ 1000})}.sig';
}

class _Harness {
  _Harness({
    required _Handler api,
    required _Handler refresh,
    String? access = 'old-access',
    String? refreshToken = 'r1',
    DateTime Function()? clock,
  }) {
    store = MemoryTokenStore(accessToken: access, refreshToken: refreshToken);
    refreshAdapter = _FakeAdapter(refresh);
    final refreshDio = Dio(BaseOptions(baseUrl: 'http://test/api/'))..httpClientAdapter = refreshAdapter;
    session = AuthSession(store: store, refreshDio: refreshDio, clock: clock);
    session.onSessionExpired.listen((_) => expiredEvents++);
    apiAdapter = _FakeAdapter(api);
    dio = Dio(BaseOptions(baseUrl: 'http://test/api/'))..httpClientAdapter = apiAdapter;
    dio.interceptors.add(AuthInterceptor(session, dio));
  }

  late final MemoryTokenStore store;
  late final AuthSession session;
  late final _FakeAdapter refreshAdapter;
  late final _FakeAdapter apiAdapter;
  late final Dio dio;
  int expiredEvents = 0;

  List<RequestOptions> get refreshCalls =>
      refreshAdapter.requests.where((r) => r.path == 'auth/refresh').toList();
}

void main() {
  group('AuthInterceptor single-flight refresh', () {
    test('3 concurrent 401s trigger exactly 1 refresh and all 3 are retried', () async {
      final gate = Completer<void>();
      var unauthorized = 0;
      late _Harness h;
      h = _Harness(
        api: (o) async {
          if (o.headers['Authorization'] == 'Bearer new-access') {
            return _json({'path': o.path}, 200);
          }
          unauthorized++;
          if (unauthorized == 3 && !gate.isCompleted) gate.complete();
          return _json({'message': 'Unauthorized'}, 401);
        },
        refresh: (o) async {
          await gate.future; // hold the refresh until all three have hit 401
          return _json({
            'accessToken': 'new-access',
            'refreshToken': 'r2',
            'user': {'id': 'u1', 'email': 'a@b.c'},
          }, 201); // backend answers refresh with 201 Created
        },
      );

      final results = await Future.wait([
        h.dio.get<Map<String, dynamic>>('a'),
        h.dio.get<Map<String, dynamic>>('b'),
        h.dio.get<Map<String, dynamic>>('c'),
      ]);

      expect(h.refreshCalls, hasLength(1));
      expect(results.map((r) => r.data!['path']).toList(), ['a', 'b', 'c']);
      // 3 original requests + 3 retries.
      expect(h.apiAdapter.requests, hasLength(6));
      expect(h.store.accessToken, 'new-access');
      expect(h.store.refreshToken, 'r2');
      expect(h.expiredEvents, 0);
    });

    test('refresh sends the refresh token in the body and no Authorization header', () async {
      final h = _Harness(
        api: (o) async => o.headers['Authorization'] == 'Bearer new-access'
            ? _json({}, 200)
            : _json({}, 401),
        refresh: (o) async => _json({'accessToken': 'new-access', 'refreshToken': 'r2'}, 200),
      );

      await h.dio.get<dynamic>('x');

      final call = h.refreshCalls.single;
      expect(call.method, 'POST');
      expect(call.data, {'refreshToken': 'r1'});
      expect(call.headers.containsKey('Authorization'), isFalse);
    });

    test('failed refresh (401) clears tokens and signals session expiry once', () async {
      final h = _Harness(
        api: (o) async => _json({}, 401),
        refresh: (o) async => _json({'message': 'revoked'}, 401),
      );

      final outcomes = await Future.wait([
        for (final p in ['a', 'b', 'c'])
          h.dio.get<dynamic>(p).then((_) => 0, onError: (Object e) => (e as DioException).response?.statusCode),
      ]);

      expect(outcomes, [401, 401, 401]);
      expect(h.refreshCalls, hasLength(1));
      expect(h.store.accessToken, isNull);
      expect(h.store.refreshToken, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(h.expiredEvents, 1);
    });

    test('a retried request that is still 401 does not refresh again', () async {
      final h = _Harness(
        api: (o) async => _json({}, 401),
        refresh: (o) async => _json({'accessToken': 'new-access', 'refreshToken': 'r2'}, 200),
      );

      await expectLater(h.dio.get<dynamic>('x'), throwsA(isA<DioException>()));

      expect(h.refreshCalls, hasLength(1));
      expect(h.apiAdapter.requests, hasLength(2));
    });

    test('401 from auth endpoints is never refreshed', () async {
      final h = _Harness(
        api: (o) async => _json({}, 401),
        refresh: (o) async => _json({'accessToken': 'new-access'}, 200),
      );

      await expectLater(h.dio.post<dynamic>('auth/login', data: {}), throwsA(isA<DioException>()));
      await expectLater(h.dio.post<dynamic>('auth/refresh', data: {}), throwsA(isA<DioException>()));

      expect(h.refreshCalls, isEmpty);
      expect(h.store.refreshToken, 'r1');
    });

    test('network error during refresh keeps tokens and does not expire the session', () async {
      final h = _Harness(
        api: (o) async => _json({}, 401),
        refresh: (o) async => throw DioException.connectionError(
          requestOptions: o,
          reason: 'offline',
        ),
      );

      await expectLater(h.dio.get<dynamic>('x'), throwsA(isA<DioException>()));

      expect(h.store.accessToken, 'old-access');
      expect(h.store.refreshToken, 'r1');
      await Future<void>.delayed(Duration.zero);
      expect(h.expiredEvents, 0);
    });

    for (final status in [429, 408, 404, 500, 503]) {
      test('refresh answered $status keeps tokens, does not expire the session, surfaces the error', () async {
        final h = _Harness(
          api: (o) async => _json({}, 401),
          refresh: (o) async => _json({'message': 'busy'}, status),
        );

        final err = await h.dio.get<dynamic>('x').then<Object?>((_) => null, onError: (Object e) => e);

        expect(err, isA<DioException>());
        expect((err as DioException).response?.statusCode, status);
        expect(err.requestOptions.path, 'x');
        expect(h.store.accessToken, 'old-access');
        expect(h.store.refreshToken, 'r1');
        expect(h.session.lastRefreshError?.response?.statusCode, status);
        await Future<void>.delayed(Duration.zero);
        expect(h.expiredEvents, 0);
      });
    }

    for (final status in [400, 401, 403]) {
      test('refresh answered $status ends the session', () async {
        final h = _Harness(
          api: (o) async => _json({}, 401),
          refresh: (o) async => _json({'message': 'revoked'}, status),
        );

        await expectLater(h.dio.get<dynamic>('x'), throwsA(isA<DioException>()));

        expect(h.store.accessToken, isNull);
        expect(h.store.refreshToken, isNull);
        expect(h.session.lastRefreshError, isNull);
        await Future<void>.delayed(Duration.zero);
        expect(h.expiredEvents, 1);
      });
    }

    test('a successful refresh clears lastRefreshError', () async {
      var status = 429;
      final h = _Harness(
        api: (o) async => o.headers['Authorization'] == 'Bearer new-access' ? _json({'ok': true}, 200) : _json({}, 401),
        refresh: (o) async =>
            status == 200 ? _json({'accessToken': 'new-access', 'refreshToken': 'r2'}, 200) : _json({}, status),
      );

      await expectLater(h.dio.get<dynamic>('x'), throwsA(isA<DioException>()));
      expect(h.session.lastRefreshError, isNotNull);
      status = 200;
      await h.dio.get<dynamic>('x');
      expect(h.session.lastRefreshError, isNull);
    });

    test('request that failed with a token already replaced is retried without refreshing', () async {
      late _Harness h;
      h = _Harness(
        api: (o) async {
          if (o.headers['Authorization'] == 'Bearer newer') return _json({}, 200);
          // Simulate another request having refreshed meanwhile.
          h.store.accessToken = 'newer';
          return _json({}, 401);
        },
        refresh: (o) async => _json({'accessToken': 'unused'}, 200),
      );

      await h.dio.get<dynamic>('x');

      expect(h.refreshCalls, isEmpty);
      expect(h.apiAdapter.requests.last.headers['Authorization'], 'Bearer newer');
    });
  });

  group('AuthSession', () {
    test('logout posts the refresh token and clears tokens even if the server fails', () async {
      final h = _Harness(
        api: (o) async => _json({}, 200),
        refresh: (o) async => _json({'message': 'boom'}, 500),
      );

      await h.session.logout();

      final call = h.refreshAdapter.requests.single;
      expect(call.path, 'auth/logout');
      expect(call.data, {'refreshToken': 'r1'});
      expect(h.store.accessToken, isNull);
      expect(h.store.refreshToken, isNull);
      expect(h.expiredEvents, 0);
    });

    test('validAccessToken refreshes an access token that is about to expire', () async {
      final now = DateTime.utc(2026, 10, 26, 12);
      final h = _Harness(
        access: _jwt(now.add(const Duration(seconds: 10))),
        clock: () => now,
        api: (o) async => _json({}, 200),
        refresh: (o) async => _json({'accessToken': 'fresh', 'refreshToken': 'r2'}, 200),
      );

      expect(await h.session.validAccessToken(), 'fresh');
      expect(h.refreshCalls, hasLength(1));
    });

    test('validAccessToken keeps a token that is still valid', () async {
      final now = DateTime.utc(2026, 10, 26, 12);
      final token = _jwt(now.add(const Duration(minutes: 10)));
      final h = _Harness(
        access: token,
        clock: () => now,
        api: (o) async => _json({}, 200),
        refresh: (o) async => _json({'accessToken': 'fresh'}, 200),
      );

      expect(await h.session.validAccessToken(), token);
      expect(h.refreshCalls, isEmpty);
    });

    test('jwtExpiry reads exp and tolerates non-JWT strings', () {
      final exp = DateTime.utc(2026, 10, 26, 12, 15);
      expect(jwtExpiry(_jwt(exp)), exp);
      expect(jwtExpiry('not-a-jwt'), isNull);
    });
  });

  test('searchUsers always sends workspaceId', () async {
    final adapter = _FakeAdapter((o) async => _json([], 200));
    final dio = Dio(BaseOptions(baseUrl: 'http://test/api/'))..httpClientAdapter = adapter;

    await ApiClient(dio).searchUsers('ann', workspaceId: 'ws1');

    final req = adapter.requests.single;
    expect(req.path, 'users/search');
    expect(req.queryParameters, {'q': 'ann', 'workspaceId': 'ws1'});
  });
}
