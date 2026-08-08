import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';

// ─── Hero Panels ─────────────────────────────────────────────────────────────

/// Full-height hero panel for wide (desktop/tablet) layout.
class AuthHeroPanel extends StatelessWidget {
  const AuthHeroPanel({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF4338CA), Color(0xFF6D28D9), Color(0xFF0891B2)],
          stops: [0.0, 0.55, 1.0],
        ),
      ),
      child: Stack(
        children: [
          // Decorative blobs
          const Positioned(
            top: -80,
            right: -80,
            child: _Blob(size: 260, opacity: 0.10),
          ),
          const Positioned(
            bottom: -100,
            left: -60,
            child: _Blob(size: 340, opacity: 0.07),
          ),
          const Positioned(
            bottom: 200,
            left: 60,
            child: _Blob(size: 120, opacity: 0.08),
          ),
          Center(
            // Scrolls rather than overflows when the viewport is short — at
            // 800x600 the un-scrollable version clipped by 17px.
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(OideaSpace.space12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Logo
                  Container(
                    width: OideaSpace.space16 + OideaSpace.space3,
                    height: OideaSpace.space16 + OideaSpace.space3,
                    decoration: BoxDecoration(
                      color: Colors.white.withValues(alpha: 0.18),
                      borderRadius: OideaRadius.xlAll,
                    ),
                    child: const Icon(
                      Icons.hub_rounded,
                      size: OideaSpace.space10 + OideaSpace.space1,
                      color: Colors.white,
                    ),
                  ),
                  const SizedBox(height: OideaSpace.space6),
                  Text(
                    'Oidea',
                    style: OideaType.display.copyWith(color: Colors.white),
                  ),
                  const SizedBox(height: OideaSpace.space3),
                  Text(
                    '整合通訊、專案管理、\n會議排程與白板協作的\n全方位工作平台。',
                    style: OideaType.bodyLg.copyWith(
                      color: Colors.white.withValues(alpha: 0.82),
                    ),
                  ),
                  const SizedBox(height: OideaSpace.space12),
                  ..._features.map((f) => _FeatureRow(icon: f.$1, label: f.$2)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

const _features = [
  (Icons.chat_bubble_outline_rounded, '即時訊息、Thread 討論串'),
  (Icons.dashboard_customize_outlined, '拖曳看板專案管理'),
  (Icons.videocam_outlined, '會議排程與視訊通話'),
  (Icons.draw_outlined, '無限白板即時協作'),
];

class _FeatureRow extends StatelessWidget {
  final IconData icon;
  final String label;
  const _FeatureRow({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: OideaSpace.space2),
      child: Row(
        children: [
          Container(
            width: OideaSpace.space10,
            height: OideaSpace.space10,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.16),
              borderRadius: OideaRadius.mdAll,
            ),
            child: Icon(
              icon,
              color: Colors.white,
              size: OideaSize.iconMd,
            ),
          ),
          const SizedBox(width: OideaSpace.space3),
          // Expanded, otherwise a long Chinese label overflows the row — the
          // panel is only 216px wide at the narrow breakpoint.
          Expanded(
            child: Text(
              label,
              style: OideaType.body.copyWith(
                color: Colors.white.withValues(alpha: 0.9),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Blob extends StatelessWidget {
  final double size;
  final double opacity;
  const _Blob({required this.size, required this.opacity});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: Colors.white.withValues(alpha: opacity),
      ),
    );
  }
}

/// Compact hero for narrow (phone) layout.
class AuthCompactHero extends StatelessWidget {
  const AuthCompactHero({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 200,
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF4338CA), Color(0xFF6D28D9)],
        ),
        borderRadius: BorderRadius.vertical(
          bottom: Radius.circular(OideaRadius.xl),
        ),
      ),
      child: Stack(
        children: [
          const Positioned(
            top: -40,
            right: -40,
            child: _Blob(size: 160, opacity: 0.1),
          ),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: OideaSpace.space16,
                  height: OideaSpace.space16,
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.2),
                    borderRadius: OideaRadius.lgAll,
                  ),
                  child: const Icon(
                    Icons.hub_rounded,
                    size: OideaSpace.space8,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: OideaSpace.space3),
                Text(
                  'Oidea',
                  style: OideaType.h1.copyWith(color: Colors.white),
                ),
                const SizedBox(height: OideaSpace.space1),
                Text(
                  '全方位協作平台',
                  style: OideaType.body.copyWith(
                    color: Colors.white.withValues(alpha: 0.8),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Form components ──────────────────────────────────────────────────────────

/// A labelled text field.
///
/// The label sits *above* the input rather than floating inside it, and there
/// is no leading icon. Both are deliberate: a floating label reflows on focus
/// and an icon inside the box eats horizontal room that Chinese labels need.
/// Together they are most of what separates this from a stock Material form.
class AuthTextField extends StatelessWidget {
  final TextEditingController controller;
  final String label;
  final String? hint;
  final bool obscureText;
  final Widget? suffixIcon;
  final TextInputType? keyboardType;
  final Iterable<String>? autofillHints;
  final String? Function(String?)? validator;
  final void Function(String)? onFieldSubmitted;
  final void Function(String)? onChanged;

  const AuthTextField({
    super.key,
    required this.controller,
    required this.label,
    this.hint,
    this.obscureText = false,
    this.suffixIcon,
    this.keyboardType,
    this.autofillHints,
    this.validator,
    this.onFieldSubmitted,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final textPrimary =
        isDark ? OideaTokens.darkTextPrimary : OideaTokens.lightTextPrimary;
    final tertiary =
        isDark ? OideaTokens.darkTextTertiary : OideaTokens.lightTextTertiary;
    final fieldBorder =
        isDark ? OideaTokens.darkInputBorder : OideaTokens.lightInputBorder;
    final fieldFill =
        isDark ? const Color(0xFF16162A) : OideaTokens.lightSurface;

    OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
          borderRadius: OideaRadius.mdAll,
          borderSide: BorderSide(color: color, width: width),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: OideaType.label.copyWith(color: textPrimary)),
        const SizedBox(height: OideaSpace.space2),
        TextFormField(
          controller: controller,
          obscureText: obscureText,
          keyboardType: keyboardType,
          autofillHints: autofillHints,
          validator: validator,
          onFieldSubmitted: onFieldSubmitted,
          onChanged: onChanged,
          style: OideaType.body.copyWith(color: textPrimary),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: OideaType.body.copyWith(color: tertiary),
            suffixIcon: suffixIcon,
            filled: true,
            fillColor: fieldFill,
            border: border(fieldBorder, 1),
            enabledBorder: border(fieldBorder, 1),
            focusedBorder: border(OideaTokens.accent, 1.5),
            errorBorder: border(OideaTokens.danger, 1),
            focusedErrorBorder: border(OideaTokens.danger, 1.5),
            errorStyle: OideaType.caption.copyWith(color: OideaTokens.danger),
            contentPadding: const EdgeInsets.symmetric(
              horizontal: OideaSpace.space4,
              vertical: OideaSpace.space3,
            ),
          ),
        ),
      ],
    );
  }
}

/// The primary call to action on the auth screens.
///
/// Solid accent rather than the previous indigo-to-violet gradient with a
/// glow. The gradient read as a consumer app; a single flat brand colour reads
/// as a tool, and it keeps the button legible against the tinted hero panel.
class AuthPrimaryButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final bool loading;
  final String label;

  const AuthPrimaryButton({
    super.key,
    required this.onPressed,
    required this.label,
    this.loading = false,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final disabledBg =
        isDark ? OideaTokens.darkColBg : const Color(0xFFE2E2EC);
    final disabledFg =
        isDark ? OideaTokens.darkTextTertiary : OideaTokens.lightTextTertiary;
    final disabled = onPressed == null;

    return SizedBox(
      height: OideaSize.controlHeight + OideaSpace.space2,
      child: FilledButton(
        onPressed: loading ? null : onPressed,
        style: FilledButton.styleFrom(
          backgroundColor: disabled ? disabledBg : OideaTokens.accent,
          foregroundColor: disabled ? disabledFg : Colors.white,
          disabledBackgroundColor: disabledBg,
          disabledForegroundColor: disabledFg,
          elevation: 0,
          shape: const RoundedRectangleBorder(borderRadius: OideaRadius.mdAll),
        ),
        child: loading
            ? const SizedBox(
                width: OideaSize.iconMd,
                height: OideaSize.iconMd,
                child: CircularProgressIndicator(
                  color: Colors.white,
                  strokeWidth: 2.5,
                ),
              )
            : Text(label, style: OideaType.button),
      ),
    );
  }
}

class AuthErrorBanner extends StatelessWidget {
  final String message;
  const AuthErrorBanner({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final bg = isDark ? OideaTokens.dangerBgDark : OideaTokens.dangerBg;
    final borderColor =
        isDark ? OideaTokens.dangerBorderDark : OideaTokens.dangerBorder;
    final fg = isDark ? OideaTokens.dangerTextDark : OideaTokens.dangerText;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: OideaSpace.space3,
        vertical: OideaSpace.space3,
      ),
      decoration: BoxDecoration(
        color: bg,
        border: Border.all(color: borderColor),
        borderRadius: OideaRadius.mdAll,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.error_outline_rounded,
            color: fg,
            size: OideaSize.iconSm + 2,
          ),
          const SizedBox(width: OideaSpace.space2),
          Expanded(
            child: Text(message, style: OideaType.bodySm.copyWith(color: fg)),
          ),
        ],
      ),
    );
  }
}
