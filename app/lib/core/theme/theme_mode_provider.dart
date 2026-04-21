import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// 使用者自訂主題模式（system / light / dark）。
///
/// 持久化到 flutter_secure_storage（已經在 api_client 使用），避免多一個相依
/// （如 shared_preferences）。key = `theme_mode`，值是 `"system" | "light" | "dark"`。
///
/// App 啟動時以 `ThemeMode.system` 先起跑；非同步讀完後才覆寫 —— 載入期間的
/// 閃爍只有首次啟動會有，通常感覺不到。
class ThemeModeController extends StateNotifier<ThemeMode> {
  ThemeModeController() : super(ThemeMode.system) {
    _loadFromStorage();
  }

  static const _storage = FlutterSecureStorage();
  static const _key = 'theme_mode';

  Future<void> _loadFromStorage() async {
    try {
      final raw = await _storage.read(key: _key);
      switch (raw) {
        case 'light':
          state = ThemeMode.light;
          break;
        case 'dark':
          state = ThemeMode.dark;
          break;
        case 'system':
        default:
          state = ThemeMode.system;
      }
    } catch (_) {
      // 讀不到就維持 system，不阻塞 UI
    }
  }

  Future<void> setMode(ThemeMode mode) async {
    state = mode;
    final raw = switch (mode) {
      ThemeMode.light => 'light',
      ThemeMode.dark => 'dark',
      ThemeMode.system => 'system',
    };
    try {
      await _storage.write(key: _key, value: raw);
    } catch (_) {
      // 寫失敗就算了，下次啟動會回到 system
    }
  }
}

final themeModeProvider = StateNotifierProvider<ThemeModeController, ThemeMode>(
  (ref) => ThemeModeController(),
);
