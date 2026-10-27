import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';

/// 員工自己的「我的資料」：唯讀，每位員工都能看。
class MyProfilePage extends ConsumerWidget {
  const MyProfilePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(companyMeProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('我的資料')),
      body: async.when(
        loading: () => const LoadingWidget(),
        error: (e, _) => AppErrorWidget(
          message: adminErrorMessage(e),
          onRetry: () => ref.invalidate(companyMeProvider),
        ),
        data: (me) {
          final p = me.profile;
          if (p == null) {
            return const EmptyStateWidget(
              icon: Icons.badge_outlined,
              title: '尚未建立員工資料',
              subtitle: '你的帳號還沒有對應的員工主檔，請聯絡 HR。',
            );
          }
          return ListView(
            padding: const EdgeInsets.all(OideaSpace.space4),
            children: [
              Text(p.fullName, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: OideaSpace.space1),
              Text(
                [p.employeeNo, if (p.jobTitle.isNotEmpty) p.jobTitle].join('　・　'),
                style: Theme.of(context).textTheme.bodyMedium,
              ),
              const SizedBox(height: OideaSpace.space4),
              Card(
                child: Column(
                  children: [
                    _Row('部門', p.departmentName),
                    _Row('直屬主管', p.managerName),
                    _Row('到職日', p.hireDate),
                    _Row('僱用類型', employmentTypeLabels[p.employmentType] ?? p.employmentType),
                    _Row('在職狀態', employmentStatusLabels[p.employmentStatus] ?? p.employmentStatus),
                    _Row('Email', p.email),
                    _Row('電話', p.phone),
                    if (me.role != null) _Row('系統角色', workspaceRoleLabels[me.role] ?? me.role),
                  ],
                ),
              ),
              const SizedBox(height: OideaSpace.space3),
              const Text(
                '資料有誤請聯絡 HR 更正。',
                style: TextStyle(fontSize: OideaFontSize.size12, color: Colors.black54),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value);
  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    final v = (value == null || value!.isEmpty) ? '—' : value!;
    return ListTile(
      dense: true,
      title: Text(label, style: const TextStyle(color: Colors.black54)),
      trailing: Text(v, style: const TextStyle(fontWeight: FontWeight.w500)),
    );
  }
}
