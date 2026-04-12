import 'package:flutter/foundation.dart';

/// 僅填主機名或 IP（例如 `192.168.1.10`），實機開發不必手寫完整 URL。
/// 範例：`flutter run --dart-define=BACKEND_HOST=192.168.1.10`
/// 若同時設了 `API_URL`，以 `API_URL` 為準。
const String kBackendHostEnv = String.fromEnvironment('BACKEND_HOST', defaultValue: '');
const String kBackendPortEnv = String.fromEnvironment('BACKEND_PORT', defaultValue: '3001');

String? devBackendRestBaseFromHostDefine() {
  final host = kBackendHostEnv.trim();
  if (host.isEmpty) return null;
  final port = kBackendPortEnv.trim().isEmpty ? '3001' : kBackendPortEnv.trim();
  return 'http://$host:$port/api';
}

String? devBackendSocketFromHostDefine() {
  final host = kBackendHostEnv.trim();
  if (host.isEmpty) return null;
  final port = kBackendPortEnv.trim().isEmpty ? '3001' : kBackendPortEnv.trim();
  return 'http://$host:$port';
}

/// 本機開發預設後端。Android 模擬器上 `localhost` 指向模擬器自己，需用 [10.0.2.2] 對應宿主機。
/// 實體手機請設 [kBackendHostEnv] 或 `API_URL`／`WS_URL`。
String defaultDevRestBaseUrl() {
  if (kIsWeb) return 'http://localhost:3001/api';
  if (defaultTargetPlatform == TargetPlatform.android) {
    return 'http://10.0.2.2:3001/api';
  }
  return 'http://localhost:3001/api';
}

String defaultDevSocketUrl() {
  if (kIsWeb) return 'http://localhost:3001';
  if (defaultTargetPlatform == TargetPlatform.android) {
    return 'http://10.0.2.2:3001';
  }
  return 'http://localhost:3001';
}
