import 'package:flutter/material.dart';

/// Oidea 視覺 token ── 對齊 prototype (Oidea Prototype.html) 的 CSS 變數。
///
/// 命名沿用 prototype：--accent / --sidebar-bg / --content-bg / --surface 等。
/// 若未來調整強調色或暗色配色，請一併更新兩個 theme 與下方 const。
class OideaTokens {
  OideaTokens._();

  // Accent
  static const accent = Color(0xFF4F46E5); // --accent (indigo)
  static const accent2 = Color(0xFF7C3AED); // --accent2 (violet)
  static const cyan = Color(0xFF06B6D4);

  // Sidebar (固定深色)
  static const sidebarBg = Color(0xFF0E0E1C);
  static const sidebarDivider = Color(0x0DFFFFFF); // rgba(255,255,255,0.05)
  static const sidebarItemHover = Color(0x0FFFFFFF); // rgba(255,255,255,0.06)
  static const sidebarItemActive = Color(0x404F46E5); // rgba(79,70,229,0.25)
  static const sidebarText = Color(0x99FFFFFF); // rgba(255,255,255,0.6)
  static const sidebarTextDim = Color(0x80FFFFFF); // rgba(255,255,255,0.5)
  static const sidebarTextMuted = Color(0x4DFFFFFF); // rgba(255,255,255,0.3)

  // Light
  static const lightContentBg = Color(0xFFF5F5FA);
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightColBg = Color(0xFFF0F0F8);
  static const lightBorder = Color(0x12000000); // rgba(0,0,0,0.07)
  static const lightTextPrimary = Color(0xFF0D0D1F);
  static const lightTextSecondary = Color(0xFF5A5A7A);
  static const lightTextTertiary = Color(0xFF9090A8);
  static const lightMsgHover = Color(0x0A000000); // rgba(0,0,0,0.04)

  // Dark
  static const darkContentBg = Color(0xFF0F0F23);
  static const darkSurface = Color(0xFF1A1A2E);
  static const darkColBg = Color(0xFF16162A);
  static const darkBorder = Color(0x12FFFFFF);
  static const darkTextPrimary = Color(0xFFEEEEFF);
  static const darkTextSecondary = Color(0xFF8888AA);
  static const darkTextTertiary = Color(0xFF555577);
  static const darkMsgHover = Color(0x0AFFFFFF);
}

class AppTheme {
  AppTheme._();

  /// 主字型：prototype 使用 Outfit；系統未安裝時 fallback 到 Noto Sans TC / 預設。
  static const _fontFamily = 'Outfit';
  static const _fontFallback = <String>[
    'Noto Sans TC',
    'PingFang TC',
    'Microsoft JhengHei',
    'Roboto',
    'sans-serif',
  ];

  static final lightTheme = _build(Brightness.light);
  static final darkTheme = _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final contentBg = isDark ? OideaTokens.darkContentBg : OideaTokens.lightContentBg;
    final surface = isDark ? OideaTokens.darkSurface : OideaTokens.lightSurface;
    final textPrimary = isDark ? OideaTokens.darkTextPrimary : OideaTokens.lightTextPrimary;
    final textSecondary = isDark ? OideaTokens.darkTextSecondary : OideaTokens.lightTextSecondary;
    final border = isDark ? OideaTokens.darkBorder : OideaTokens.lightBorder;

    final colorScheme = ColorScheme.fromSeed(
      seedColor: OideaTokens.accent,
      brightness: brightness,
    ).copyWith(
      primary: OideaTokens.accent,
      secondary: OideaTokens.accent2,
      surface: surface,
      onSurface: textPrimary,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: contentBg,
      fontFamily: _fontFamily,
      fontFamilyFallback: _fontFallback,
      dividerTheme: DividerThemeData(color: border, space: 1, thickness: 1),
      appBarTheme: AppBarTheme(
        backgroundColor: contentBg,
        foregroundColor: textPrimary,
        elevation: 0,
        centerTitle: false,
        iconTheme: IconThemeData(color: textPrimary),
        titleTextStyle: TextStyle(
          color: textPrimary,
          fontSize: 16,
          fontWeight: FontWeight.w700,
          fontFamily: _fontFamily,
          fontFamilyFallback: _fontFallback,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: border),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? const Color(0xFF141428) : OideaTokens.lightColBg,
        hintStyle: TextStyle(color: textSecondary),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: OideaTokens.accent, width: 1.5),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: OideaTokens.accent,
        foregroundColor: Colors.white,
      ),
      chipTheme: ChipThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: OideaTokens.accent,
          foregroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontFamily: _fontFamily),
        ),
      ),
    );
  }
}
