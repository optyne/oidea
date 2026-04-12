import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../providers/auth_provider.dart';
import 'shared_auth_widgets.dart';

class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage>
    with SingleTickerProviderStateMixin {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _obscurePassword = true;
  late final AnimationController _animCtrl;
  late final Animation<double> _fadeAnim;
  late final Animation<Offset> _slideAnim;

  @override
  void initState() {
    super.initState();
    _animCtrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 600));
    _fadeAnim =
        CurvedAnimation(parent: _animCtrl, curve: Curves.easeOut);
    _slideAnim =
        Tween<Offset>(begin: const Offset(0, 0.06), end: Offset.zero)
            .animate(CurvedAnimation(parent: _animCtrl, curve: Curves.easeOut));
    _animCtrl.forward();
  }

  @override
  void dispose() {
    _animCtrl.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _submit() {
    if (_formKey.currentState!.validate()) {
      ref.read(authStateProvider.notifier).login(
            _emailController.text.trim(),
            _passwordController.text,
          );
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authStateProvider);
    final isWide = MediaQuery.sizeOf(context).width > 768;

    return Scaffold(
      body: isWide
          ? _buildWideLayout(authState)
          : _buildNarrowLayout(authState),
    );
  }

  Widget _buildWideLayout(AuthState authState) {
    return Row(
      children: [
        Expanded(child: const AuthHeroPanel()),
        SizedBox(
          width: 480,
          child: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.symmetric(
                    horizontal: 48, vertical: 32),
                child: FadeTransition(
                  opacity: _fadeAnim,
                  child: SlideTransition(
                    position: _slideAnim,
                    child: _buildForm(authState),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildNarrowLayout(AuthState authState) {
    return SafeArea(
      child: SingleChildScrollView(
        child: Column(
          children: [
            const AuthCompactHero(),
            FadeTransition(
              opacity: _fadeAnim,
              child: SlideTransition(
                position: _slideAnim,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 24, vertical: 16),
                  child: _buildForm(authState),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildForm(AuthState authState) {
    final theme = Theme.of(context);
    return Form(
      key: _formKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '歡迎回來',
            style: theme.textTheme.headlineMedium
                ?.copyWith(fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          Text(
            '登入帳號以繼續使用 Oidea',
            style: theme.textTheme.bodyMedium
                ?.copyWith(color: Colors.grey.shade600),
          ),
          const SizedBox(height: 32),

          AuthTextField(
            controller: _emailController,
            label: '電子信箱',
            hint: 'you@example.com',
            icon: Icons.email_outlined,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            validator: (v) {
              if (v == null || v.trim().isEmpty) return '請輸入電子信箱';
              if (!v.trim().contains('@')) return '請輸入有效的信箱';
              return null;
            },
          ),
          const SizedBox(height: 16),

          AuthTextField(
            controller: _passwordController,
            label: '密碼',
            icon: Icons.lock_outline_rounded,
            obscureText: _obscurePassword,
            autofillHints: const [AutofillHints.password],
            suffixIcon: IconButton(
              icon: Icon(_obscurePassword
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined),
              onPressed: () =>
                  setState(() => _obscurePassword = !_obscurePassword),
            ),
            validator: (v) =>
                (v?.length ?? 0) < 8 ? '密碼至少 8 字元' : null,
            onFieldSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 8),

          if (authState.error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: AuthErrorBanner(message: authState.error!),
            ),

          const SizedBox(height: 16),

          AuthGradientButton(
            onPressed: authState.isLoading ? null : _submit,
            loading: authState.isLoading,
            label: '登入',
          ),

          const SizedBox(height: 24),

          Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('還沒有帳號？',
                    style: TextStyle(color: Colors.grey.shade600)),
                TextButton(
                  onPressed: () => context.go('/register'),
                  style: TextButton.styleFrom(
                      foregroundColor: const Color(0xFF4F46E5)),
                  child: const Text('免費建立帳號',
                      style: TextStyle(fontWeight: FontWeight.w600)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
