import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/admin/admin_access.dart';
import 'package:oidea/features/admin/models/admin_models.dart';
import 'package:oidea/features/admin/presentation/pages/admin_home_page.dart';
import 'package:oidea/features/admin/presentation/widgets/admin_widgets.dart';
import 'package:oidea/shared/pages/main_shell.dart';
import 'package:oidea/shared/widgets/oidea_sidebar.dart';

import 'support/admin_fakes.dart';

void main() {
  group('「後台」導覽項目', () {
    // 側欄（寬版）
    Future<void> pumpSidebar(WidgetTester tester, CompanyMe me) async {
      useWideScreen(tester, width: 1000, height: 800);
      await tester.pumpWidget(adminApp(
        const Scaffold(body: Row(children: [OideaSidebar()])),
        api: FakeAdminApi(),
        me: me,
        extra: shellOverrides(),
      ));
      await tester.pumpAndSettle();
    }

    // 底部導覽（窄版）
    Future<void> pumpCompactShell(WidgetTester tester, CompanyMe me) async {
      useWideScreen(tester, width: 420, height: 800);
      await tester.pumpWidget(adminApp(
        const MainShell(child: SizedBox.shrink()),
        api: FakeAdminApi(),
        me: me,
        extra: shellOverrides(),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets('一般成員：側欄沒有「後台」', (tester) async {
      await pumpSidebar(tester, companyMe(memberPerms));
      expect(find.text('ERP'), findsOneWidget); // 側欄確實渲染了
      expect(find.text('後台'), findsNothing);
    });

    testWidgets('一般成員：底部導覽沒有「後台」', (tester) async {
      await pumpCompactShell(tester, companyMe(memberPerms));
      expect(find.text('ERP'), findsOneWidget);
      expect(find.text('後台'), findsNothing);
    });

    testWidgets('不是公司成員（permissions 空、role null）：兩份清單都沒有「後台」', (tester) async {
      await pumpSidebar(tester, companyMe(const []));
      expect(find.text('後台'), findsNothing);
      await pumpCompactShell(tester, companyMe(const []));
      expect(find.text('後台'), findsNothing);
    });

    testWidgets('hr：側欄有「後台」', (tester) async {
      await pumpSidebar(tester, companyMe(hrPerms, role: 'hr'));
      expect(find.text('後台'), findsOneWidget);
    });

    testWidgets('hr：底部導覽有「後台」', (tester) async {
      await pumpCompactShell(tester, companyMe(hrPerms, role: 'hr'));
      expect(find.text('後台'), findsOneWidget);
    });

    testWidgets('只有 audit.read 也看得到（任一後台權限即可）', (tester) async {
      await pumpSidebar(tester, companyMe(const ['audit.read']));
      expect(find.text('後台'), findsOneWidget);
    });

    testWidgets('權限載入失敗：不顯示「後台」', (tester) async {
      useWideScreen(tester, width: 1000, height: 800);
      await tester.pumpWidget(ProviderScope(
        overrides: [
          ...shellOverrides(),
          adminApiOverride(FakeAdminApi()),
          companyMeFailsOverride(),
        ],
        child: const MaterialApp(home: Scaffold(body: Row(children: [OideaSidebar()]))),
      ));
      await tester.pumpAndSettle();
      expect(find.text('ERP'), findsOneWidget);
      expect(find.text('後台'), findsNothing);
    });
  });

  group('後台首頁與守門', () {
    testWidgets('hr 只看到員工名冊與部門，沒有成員與角色、審計日誌', (tester) async {
      await tester.pumpWidget(adminApp(const AdminHomePage(), api: FakeAdminApi(), me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      expect(find.text('員工名冊'), findsOneWidget);
      expect(find.text('部門'), findsOneWidget);
      expect(find.text('成員與角色'), findsNothing);
      expect(find.text('審計日誌'), findsNothing);
    });

    testWidgets('admin 看到全部四項', (tester) async {
      await tester.pumpWidget(adminApp(const AdminHomePage(), api: FakeAdminApi(), me: companyMe(adminPerms, role: 'admin')));
      await tester.pumpAndSettle();
      for (final t in ['員工名冊', '部門', '成員與角色', '審計日誌']) {
        expect(find.text(t), findsOneWidget, reason: t);
      }
    });

    testWidgets('AdminGuard：沒有 member.role.manage 的 hr 看不到角色頁內容', (tester) async {
      await tester.pumpWidget(adminApp(
        const AdminGuard(anyOf: [AdminPerm.memberRoleManage], child: Text('角色頁內容')),
        api: FakeAdminApi(),
        me: companyMe(hrPerms, role: 'hr'),
      ));
      await tester.pumpAndSettle();
      expect(find.text('角色頁內容'), findsNothing);
      expect(find.text('您沒有權限查看此頁面'), findsOneWidget);
    });

    testWidgets('AdminGuard：有權限就顯示內容', (tester) async {
      await tester.pumpWidget(adminApp(
        const AdminGuard(anyOf: [AdminPerm.memberRoleManage], child: Text('角色頁內容')),
        api: FakeAdminApi(),
        me: companyMe(adminPerms, role: 'admin'),
      ));
      await tester.pumpAndSettle();
      expect(find.text('角色頁內容'), findsOneWidget);
    });

    test('adminRedirect：未載入先放行；已載入且權限不足導回 /chat；非 /admin 不管', () {
      expect(adminRedirect('/admin/roles', null), isNull);
      expect(adminRedirect('/admin/roles', const {'employee.read_all'}), '/chat');
      expect(adminRedirect('/admin/roles', const {'member.role.manage'}), isNull);
      expect(adminRedirect('/admin/audit', const {'employee.read_all'}), '/chat');
      expect(adminRedirect('/admin', const <String>{}), '/chat');
      expect(adminRedirect('/admin', const {'audit.read'}), isNull);
      expect(adminRedirect('/admin/employees', const {'department.manage'}), '/chat');
      expect(adminRedirect('/chat', const <String>{}), isNull);
      expect(adminRedirect('/administrator', const <String>{}), isNull);
    });
  });
}
