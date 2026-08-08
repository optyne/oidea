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

  // Input borders. Deliberately stronger than [lightBorder] / [darkBorder]:
  // a divider may be barely-there, but a field edge has to read as a target.
  static const lightInputBorder = Color(0xFFDCDCE8);
  static const darkInputBorder = Color(0xFF2E2E4A);

  // Feedback (error / warning / success)
  static const danger = Color(0xFFDC2626);
  static const dangerBg = Color(0xFFFEF2F2);
  static const dangerBorder = Color(0xFFFECACA);
  static const dangerText = Color(0xFF991B1B);
  static const dangerBgDark = Color(0x1FDC2626);
  static const dangerBorderDark = Color(0x4DDC2626);
  static const dangerTextDark = Color(0xFFFCA5A5);
}

/// Spacing scale ── every gap in the UI is one of these.
///
/// Built on a 4px grid: `spaceN` is `N * 4` logical pixels. The names match
/// the multiplier so `space6` is unambiguously 24, which is what makes an
/// off-scale value obvious when it shows up in review.
///
/// Nothing outside this class should write a raw number into an [EdgeInsets],
/// a [SizedBox], or a gap. If a design genuinely needs a value that is not on
/// the scale, add it here rather than inlining it.
class OideaSpace {
  OideaSpace._();

  // Half steps. Not decoration: a sweep of the existing code found 6px used
  // 62 times, 10px 38 times and 2px 33 times — tight gaps inside a control
  // (icon to label, chip padding, hairline offsets) genuinely need a finer
  // grain than 4px, and rounding them to 4 or 8 would have been a visual
  // change disguised as a refactor.
  static const space05 = 2.0;
  static const space15 = 6.0;
  static const space25 = 10.0;
  static const space35 = 14.0;

  static const space1 = 4.0;
  static const space2 = 8.0;
  static const space3 = 12.0;
  static const space4 = 16.0;
  static const space5 = 20.0;
  static const space6 = 24.0;
  static const space8 = 32.0;
  static const space10 = 40.0;
  static const space12 = 48.0;
  static const space16 = 64.0;
}

/// Corner radius scale.
///
/// Before this existed the codebase used 8, 10, 11, 12 and 22 more or less
/// interchangeably, which is why surfaces never looked like a set. Four steps
/// plus [full] cover everything: [sm] for chips and badges, [md] for inputs
/// and buttons, [lg] for cards, [xl] for panels and sheets.
///
/// The steps sit on the same 4px grid as [OideaSpace], which is not an
/// aesthetic preference — a count of the existing call sites found 8px used
/// 25 times, 4px 15 times, 12px 13 times and 16px 5 times. The grid was
/// already there; this only names it.
class OideaRadius {
  OideaRadius._();

  static const sm = 4.0;
  static const md = 8.0;
  static const lg = 12.0;
  static const xl = 16.0;
  static const full = 999.0;

  static const smAll = BorderRadius.all(Radius.circular(sm));
  static const mdAll = BorderRadius.all(Radius.circular(md));
  static const lgAll = BorderRadius.all(Radius.circular(lg));
  static const xlAll = BorderRadius.all(Radius.circular(xl));
}

/// Font size steps.
///
/// The layer below [OideaType]: raw sizes with no weight, height or colour
/// attached. [OideaType] is built from these, and so is any one-off
/// [TextStyle] that does not fit a named role.
///
/// Prefer [OideaType]. Reach for a bare size only when you need a size and
/// nothing else — swapping a literal for a token here is safe in a way that
/// swapping it for a full named style is not, because a named style also
/// carries weight and line height.
///
/// The steps are the sizes this app actually uses, counted from the source.
/// Two of them come with a warning:
///
/// - [size11] (46 uses) and [size10] (18 uses) are below what Traditional
///   Chinese stays comfortably readable at on a normal display. They are
///   listed so the existing call sites can be named rather than hidden, not
///   because new code should reach for them. New metadata text should start
///   at [size12].
///
/// Sizes outside this list are left as literals on purpose, so that an
/// off-scale value stays visible in review instead of blending in.
class OideaFontSize {
  OideaFontSize._();

  /// Too small for body text — see the class doc before using.
  static const size10 = 10.0;

  /// Too small for body text — see the class doc before using.
  static const size11 = 11.0;

  static const size12 = 12.0;
  static const size13 = 13.0;
  static const size14 = 14.0;
  static const size15 = 15.0;
  static const size16 = 16.0;
  static const size18 = 18.0;
  static const size20 = 20.0;
  static const size22 = 22.0;
  static const size24 = 24.0;
  static const size28 = 28.0;
  static const size32 = 32.0;
  static const size40 = 40.0;
}

/// Type scale.
///
/// Deliberately carries only size, weight, height and tracking — never a
/// font family or colour. Family comes from [AppTheme] so the Outfit fallback
/// chain stays in one place, and colour comes from the surrounding
/// [ColorScheme] so the same style works in both themes.
///
/// Apply with `.copyWith(color: ...)` at the call site.
class OideaType {
  OideaType._();

  /// 40 / w800 — the one-per-screen hero number or title.
  static const display = TextStyle(
    fontSize: OideaFontSize.size40,
    fontWeight: FontWeight.w800,
    height: 1.15,
    letterSpacing: -1.0,
  );

  /// 32 / w800 — page title.
  static const h1 = TextStyle(
    fontSize: OideaFontSize.size32,
    fontWeight: FontWeight.w800,
    height: 1.2,
    letterSpacing: -0.6,
  );

  /// 24 / w700 — section heading.
  static const h2 = TextStyle(
    fontSize: OideaFontSize.size24,
    fontWeight: FontWeight.w700,
    height: 1.25,
    letterSpacing: -0.3,
  );

  /// 20 / w700 — card or dialog heading.
  static const h3 = TextStyle(
    fontSize: OideaFontSize.size20,
    fontWeight: FontWeight.w700,
    height: 1.3,
  );

  /// 16 / w400 — lead paragraph.
  static const bodyLg = TextStyle(fontSize: OideaFontSize.size16, height: 1.6);

  /// 14 / w400 — default body copy.
  static const body = TextStyle(fontSize: OideaFontSize.size14, height: 1.6);

  /// 13 / w400 — secondary copy, timestamps, helper text.
  static const bodySm = TextStyle(fontSize: OideaFontSize.size13, height: 1.5);

  /// 13 / w600 — form field labels sitting above their input.
  static const label = TextStyle(
    fontSize: OideaFontSize.size13,
    fontWeight: FontWeight.w600,
    height: 1.4,
  );

  /// 15 / w600 — button text.
  static const button = TextStyle(
    fontSize: OideaFontSize.size15,
    fontWeight: FontWeight.w600,
    height: 1.2,
  );

  /// 12 / w400 — captions and metadata.
  static const caption = TextStyle(fontSize: OideaFontSize.size12, height: 1.4);
}

/// Elevation scale. Two steps is enough: [sm] lifts a control off its
/// surface, [md] lifts a surface off the page.
class OideaShadow {
  OideaShadow._();

  static const sm = <BoxShadow>[
    BoxShadow(color: Color(0x0F000000), blurRadius: 3, offset: Offset(0, 1)),
  ];

  static const md = <BoxShadow>[
    BoxShadow(color: Color(0x14000000), blurRadius: 12, offset: Offset(0, 4)),
  ];
}

/// Field heights, so inputs and the buttons next to them line up.
class OideaSize {
  OideaSize._();

  static const controlHeight = 44.0;
  static const iconSm = 16.0;
  static const iconMd = 20.0;
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
        titleTextStyle: OideaType.bodyLg.copyWith(
          color: textPrimary,
          fontWeight: FontWeight.w700,
          fontFamily: _fontFamily,
          fontFamilyFallback: _fontFallback,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: surface,
        shape: RoundedRectangleBorder(
          borderRadius: OideaRadius.lgAll,
          side: BorderSide(color: border),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: isDark ? const Color(0xFF141428) : OideaTokens.lightColBg,
        hintStyle: TextStyle(color: textSecondary),
        border: const OutlineInputBorder(
          borderRadius: OideaRadius.mdAll,
          borderSide: BorderSide.none,
        ),
        focusedBorder: const OutlineInputBorder(
          borderRadius: OideaRadius.mdAll,
          borderSide: BorderSide(color: OideaTokens.accent, width: 1.5),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: OideaSpace.space4,
          vertical: OideaSpace.space3,
        ),
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: OideaTokens.accent,
        foregroundColor: Colors.white,
      ),
      chipTheme: const ChipThemeData(
        shape: RoundedRectangleBorder(borderRadius: OideaRadius.smAll),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: OideaTokens.accent,
          foregroundColor: Colors.white,
          minimumSize: const Size(0, OideaSize.controlHeight),
          shape: const RoundedRectangleBorder(borderRadius: OideaRadius.mdAll),
          textStyle: OideaType.button.copyWith(fontFamily: _fontFamily),
        ),
      ),
    );
  }
}
