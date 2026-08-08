import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/theme/app_theme.dart';
import '../../providers/auth_provider.dart';
import 'shared_auth_widgets.dart';

/// Slightly wider than the login column: this form has five fields plus a
/// strength meter, so it needs the extra room to avoid feeling cramped.
const _formColumnWidth = 520.0;

class RegisterPage extends ConsumerStatefulWidget {
  const RegisterPage({super.key});

  @override
  ConsumerState<RegisterPage> createState() => _RegisterPageState();
}

class _RegisterPageState extends ConsumerState<RegisterPage>
    with SingleTickerProviderStateMixin {
  final _emailController = TextEditingController();
  final _usernameController = TextEditingController();
  final _displayNameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _obscurePassword = true;
  bool _obscureConfirm = true;
  late final AnimationController _animCtrl;
  late final Animation<double> _fadeAnim;

  @override
  void initState() {
    super.initState();
    _animCtrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 500));
    _fadeAnim =
        CurvedAnimation(parent: _animCtrl, curve: Curves.easeOut);
    _animCtrl.forward();
  }

  @override
  void dispose() {
    _animCtrl.dispose();
    _emailController.dispose();
    _usernameController.dispose();
    _displayNameController.dispose();
    _passwordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  double get _passwordStrength {
    final pw = _passwordController.text;
    if (pw.isEmpty) return 0;
    double s = 0;
    if (pw.length >= 8) s += 0.25;
    if (pw.length >= 12) s += 0.15;
    if (RegExp(r'[A-Z]').hasMatch(pw)) s += 0.2;
    if (RegExp(r'[0-9]').hasMatch(pw)) s += 0.2;
    if (RegExp(r'[!@#\$%^&*(),.?]').hasMatch(pw)) s += 0.2;
    return s.clamp(0.0, 1.0);
  }

  Color get _strengthColor {
    final s = _passwordStrength;
    if (s < 0.4) return Colors.red.shade600;
    if (s < 0.7) return Colors.orange.shade700;
    return Colors.green.shade600;
  }

  String get _strengthLabel {
    final s = _passwordStrength;
    if (s == 0) return '';
    if (s < 0.4) return '弱';
    if (s < 0.7) return '中';
    return '強';
  }

  void _submit() {
    if (_formKey.currentState!.validate()) {
      ref.read(authStateProvider.notifier).register(
            _emailController.text.trim(),
            _usernameController.text.trim(),
            _displayNameController.text.trim(),
            _passwordController.text,
          );
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authStateProvider);
    final scheme = Theme.of(context).colorScheme;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final secondary = isDark
        ? OideaTokens.darkTextSecondary
        : OideaTokens.lightTextSecondary;
    final tertiary = isDark
        ? OideaTokens.darkTextTertiary
        : OideaTokens.lightTextTertiary;
    final isWide = MediaQuery.sizeOf(context).width > 768;

    Widget form = Form(
      key: _formKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Logo + title
          Row(
            children: [
              Container(
                width: OideaSize.controlHeight,
                height: OideaSize.controlHeight,
                decoration: const BoxDecoration(
                  color: OideaTokens.accent,
                  borderRadius: OideaRadius.mdAll,
                ),
                child: const Icon(Icons.hub_rounded,
                    color: Colors.white, size: OideaSize.iconMd + 4),
              ),
              const SizedBox(width: OideaSpace.space3),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Oidea',
                      style: OideaType.h3.copyWith(color: scheme.onSurface)),
                  Text('建立新帳號',
                      style: OideaType.bodySm.copyWith(color: secondary)),
                ],
              ),
              const Spacer(),
              TextButton(
                onPressed: () => context.go('/login'),
                child: const Text('已有帳號？登入'),
              ),
            ],
          ),
          const SizedBox(height: OideaSpace.space6),

          // Fields
          AuthTextField(
            controller: _displayNameController,
            label: '顯示名稱',
            hint: '您希望別人怎麼稱呼您？',
            autofillHints: const [AutofillHints.name],
            validator: (v) =>
                v == null || v.trim().isEmpty ? '請輸入顯示名稱' : null,
          ),
          const SizedBox(height: OideaSpace.space4),

          AuthTextField(
            controller: _usernameController,
            label: '使用者名稱',
            hint: '3-20 字元，僅英數與底線',
            autofillHints: const [AutofillHints.username],
            validator: (v) {
              if (v == null || v.trim().length < 3) return '至少 3 字元';
              if (!RegExp(r'^[a-zA-Z0-9_]+$').hasMatch(v.trim())) {
                return '只能包含英數字和底線';
              }
              return null;
            },
          ),
          const SizedBox(height: OideaSpace.space4),

          AuthTextField(
            controller: _emailController,
            label: '電子信箱',
            hint: 'you@example.com',
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            validator: (v) {
              if (v == null || v.trim().isEmpty) return '請輸入電子信箱';
              if (!RegExp(r'^[\w.-]+@[\w.-]+\.\w{2,}$')
                  .hasMatch(v.trim())) {
                return '格式不正確';
              }
              return null;
            },
          ),
          const SizedBox(height: OideaSpace.space4),

          AuthTextField(
            controller: _passwordController,
            label: '密碼',
            obscureText: _obscurePassword,
            autofillHints: const [AutofillHints.newPassword],
            suffixIcon: IconButton(
              icon: Icon(_obscurePassword
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined),
              onPressed: () =>
                  setState(() => _obscurePassword = !_obscurePassword),
            ),
            validator: (v) =>
                (v?.length ?? 0) < 8 ? '密碼至少 8 字元' : null,
            onChanged: (_) => setState(() {}),
          ),

          // Strength bar
          if (_passwordController.text.isNotEmpty) ...[
            const SizedBox(height: OideaSpace.space2),
            Row(
              children: [
                Expanded(
                  child: ClipRRect(
                    borderRadius: OideaRadius.smAll,
                    child: LinearProgressIndicator(
                      value: _passwordStrength,
                      backgroundColor: isDark ? OideaTokens.darkColBg : OideaTokens.lightColBg,
                      valueColor:
                          AlwaysStoppedAnimation<Color>(_strengthColor),
                      minHeight: 5,
                    ),
                  ),
                ),
                const SizedBox(width: OideaSpace.space3),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 200),
                  child: Text(
                    '強度：$_strengthLabel',
                    key: ValueKey(_strengthLabel),
                    style: OideaType.caption.copyWith(
                        color: _strengthColor, fontWeight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: OideaSpace.space4),

          AuthTextField(
            controller: _confirmPasswordController,
            label: '確認密碼',
            obscureText: _obscureConfirm,
            autofillHints: const [AutofillHints.newPassword],
            suffixIcon: IconButton(
              icon: Icon(_obscureConfirm
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined),
              onPressed: () =>
                  setState(() => _obscureConfirm = !_obscureConfirm),
            ),
            validator: (v) =>
                v != _passwordController.text ? '兩次密碼不一致' : null,
            onFieldSubmitted: (_) => _submit(),
          ),

          if (authState.error != null) ...[
            const SizedBox(height: OideaSpace.space3),
            AuthErrorBanner(message: authState.error!),
          ],

          const SizedBox(height: OideaSpace.space6),

          AuthPrimaryButton(
            onPressed: authState.isLoading ? null : _submit,
            loading: authState.isLoading,
            label: '建立帳號',
          ),

          const SizedBox(height: OideaSpace.space4),

          Text(
            '按下「建立帳號」即表示您同意本平台的服務條款與隱私政策。',
            textAlign: TextAlign.center,
            style: OideaType.caption.copyWith(color: tertiary),
          ),
          const SizedBox(height: OideaSpace.space2),
        ],
      ),
    );

    if (isWide) {
      return Scaffold(
        body: Row(
          children: [
            Expanded(child: const AuthHeroPanel()),
            SizedBox(
              width: _formColumnWidth,
              child: SafeArea(
                child: Center(
                  child: FadeTransition(
                    opacity: _fadeAnim,
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.symmetric(
                          horizontal: OideaSpace.space12, vertical: OideaSpace.space8),
                      child: form,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: FadeTransition(
          opacity: _fadeAnim,
          child: SingleChildScrollView(
            padding:
                const EdgeInsets.symmetric(
                horizontal: OideaSpace.space6, vertical: OideaSpace.space4),
            child: form,
          ),
        ),
      ),
    );
  }
}
