import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/admin/admin_access.dart';
import 'package:oidea/features/admin/admin_errors.dart';
import 'package:oidea/features/admin/models/admin_models.dart';
import 'package:oidea/features/admin/presentation/pages/admin_home_page.dart';
import 'package:oidea/features/admin/presentation/pages/employees_page.dart';
import 'package:oidea/features/admin/presentation/pages/holidays_page.dart';
import 'package:oidea/features/admin/presentation/widgets/admin_widgets.dart';

import 'support/admin_fakes.dart';

Finder inDialog(Finder f) => find.descendant(of: find.byType(AlertDialog), matching: f);

/// 調整對話框中央顯示的天數（外層餘額對話框的調整紀錄也有類似文字，所以用 key 取）。
String? daysShown(WidgetTester tester) => tester.widget<Text>(find.byKey(const Key('adjust-days'))).data;

final int thisYear = DateTime.now().year;

Widget holidaysApp(FakeAdminApi api, List<String> perms) => adminApp(
      const AdminGuard(anyOf: [AdminPerm.leavePolicyManage], child: HolidaysPage()),
      api: api,
      me: companyMe(perms, role: 'hr'),
    );

void main() {
  group('沒有 leave.policy.manage 就看不到假日與特休調整', () {
    testWidgets('後台首頁：沒有「國定假日」；有權限才出現', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const AdminHomePage(), api: FakeAdminApi(), me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      expect(find.text('員工名冊'), findsOneWidget);
      expect(find.text('國定假日'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink()); // 換一組權限：丟掉舊的 provider 快取
      await tester.pumpWidget(adminApp(const AdminHomePage(), api: FakeAdminApi(), me: companyMe(hrPolicyPerms, role: 'hr')));
      await tester.pumpAndSettle();
      expect(find.text('國定假日'), findsOneWidget);
    });

    testWidgets('國定假日頁：沒有權限只看到說明，沒有清單也沒有「貼上清單」', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()..holidays = {thisYear: [{'date': '$thisYear-01-01', 'name': '元旦'}]};
      await tester.pumpWidget(holidaysApp(api, hrPerms));
      await tester.pumpAndSettle();
      expect(find.text('您沒有權限查看此頁面'), findsOneWidget);
      expect(find.text('貼上清單'), findsNothing);
      expect(find.text('元旦'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(holidaysApp(api, hrPolicyPerms));
      await tester.pumpAndSettle();
      expect(find.text('貼上清單'), findsOneWidget);
      expect(find.text('元旦'), findsOneWidget);
    });

    testWidgets('員工名冊：hr 沒有 leave.policy.manage 時選單沒有「特休」；有才有', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: FakeAdminApi(), me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      expect(find.text('編輯'), findsOneWidget);
      expect(find.text('特休'), findsNothing);
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: FakeAdminApi(), me: companyMe(hrPolicyPerms, role: 'hr')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      expect(find.text('特休'), findsOneWidget);
      expect(find.text('編輯'), findsOneWidget);
    });

    testWidgets('員工名冊：只有 read_all（唯讀）仍然沒有操作欄', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: FakeAdminApi(), me: companyMe(readOnlyPerms)));
      await tester.pumpAndSettle();
      expect(find.text('操作'), findsNothing);
      expect(find.byTooltip('操作'), findsNothing);
    });

    test('路由守門：/admin/holidays 需要 leave.policy.manage', () {
      expect(adminRequiredPerms('/admin/holidays'), ['leave.policy.manage']);
      expect(adminRedirect('/admin/holidays', hrPerms.toSet()), '/chat');
      expect(adminRedirect('/admin/holidays', adminPerms.toSet()), '/chat'); // admin 角色沒有這個權限
      expect(adminRedirect('/admin/holidays', hrPolicyPerms.toSet()), isNull);
    });
  });

  group('國定假日頁', () {
    testWidgets('列出那一年的假日；換年份會重抓', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..holidays = {
          thisYear: [
            {'date': '$thisYear-01-01', 'name': '元旦'},
            {'date': '$thisYear-10-10', 'name': '國慶日'},
          ],
        };
      await tester.pumpWidget(holidaysApp(api, hrPolicyPerms));
      await tester.pumpAndSettle();
      expect(find.text('國慶日'), findsOneWidget);
      expect(find.text('$thisYear-10-10'), findsOneWidget);

      await tester.tap(find.byType(DropdownButton<int>));
      await tester.pumpAndSettle();
      await tester.tap(find.text('${thisYear + 1}').last);
      await tester.pumpAndSettle();
      expect(find.text('國慶日'), findsNothing);
      expect(find.textContaining('${thisYear + 1} 年還沒有設定假日'), findsOneWidget);
    });

    testWidgets('貼上清單：有問題的行標紅、不能送出；改正後整年取代', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()..holidays = {thisYear: [{'date': '$thisYear-02-02', 'name': '舊的'}]};
      await tester.pumpWidget(holidaysApp(api, hrPolicyPerms));
      await tester.pumpAndSettle();

      await tester.tap(find.text('貼上清單'));
      await tester.pumpAndSettle();
      expect(inDialog(find.textContaining('取代 $thisYear 年現有的 1 筆')), findsOneWidget);
      FilledButton submit() => tester.widget<FilledButton>(inDialog(find.byType(FilledButton)));
      expect(submit().onPressed, isNull); // 還沒貼東西

      await tester.enterText(
        find.byType(TextField),
        '$thisYear/10/10\t國慶日\n'
        '$thisYear-02-30 不存在\n'
        '${thisYear - 1}-12-31 去年\n'
        '$thisYear-10-10 重複\n'
        '\n'
        '$thisYear-01-01,元旦',
      );
      await tester.pumpAndSettle();
      expect(inDialog(find.text('2 筆可用、3 行有問題')), findsOneWidget);
      expect(inDialog(find.textContaining('不是有效的日期')), findsOneWidget);
      expect(inDialog(find.textContaining('日期不在 $thisYear 年')), findsOneWidget);
      expect(inDialog(find.textContaining('日期重複')), findsOneWidget);
      expect(submit().onPressed, isNull);

      await tester.enterText(find.byType(TextField), '$thisYear/10/10\t國慶日\n\n$thisYear-01-01,元旦');
      await tester.pumpAndSettle();
      expect(inDialog(find.text('2 筆可用')), findsOneWidget);
      expect(submit().onPressed, isNotNull);

      await tester.tap(inDialog(find.byType(FilledButton)));
      await tester.pumpAndSettle();
      expect(api.replacedHolidays, hasLength(1));
      expect(api.replacedHolidays.single.year, thisYear);
      expect(api.replacedHolidays.single.items, [
        {'date': '$thisYear-01-01', 'name': '元旦'},
        {'date': '$thisYear-10-10', 'name': '國慶日'},
      ]);
      // 送出後列表重抓，顯示新的內容
      expect(find.text('國慶日'), findsOneWidget);
      expect(find.text('舊的'), findsNothing);
    });

    testWidgets('後端拒絕（holiday_invalid）：用對話框顯示訊息', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..replaceHolidaysError = apiError(400, {'code': 'holiday_invalid', 'message': '假日清單有重複的日期'});
      await tester.pumpWidget(holidaysApp(api, hrPolicyPerms));
      await tester.pumpAndSettle();
      await tester.tap(find.text('貼上清單'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '$thisYear-01-01 元旦');
      await tester.pumpAndSettle();
      await tester.tap(inDialog(find.byType(FilledButton)));
      await tester.pumpAndSettle();
      expect(find.text('操作失敗'), findsOneWidget);
      expect(find.text('假日清單有重複的日期'), findsOneWidget);
    });
  });

  group('員工特休（後台）', () {
    Future<void> openBalance(WidgetTester tester, FakeAdminApi api) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPolicyPerms, role: 'hr')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('特休'));
      await tester.pumpAndSettle();
    }

    FakeAdminApi withBalance() => FakeAdminApi()
      ..employeeLeaveBalance = {
        'current': annualJson(entitled: 10, adjusted: 1, used: 2, remaining: 9),
        'previous': annualJson(
          periodStart: '2025-03-01',
          periodEnd: '2026-02-28',
          entitled: 7,
          adjusted: 0,
          used: 7,
          remaining: 0,
        ),
        'adjustments': [
          adjustmentJson('a2', days: 1, reason: '加班補休'),
          adjustmentJson('a1', periodStart: '2025-03-01', days: -0.5, reason: '更正'),
        ],
      };

    testWidgets('顯示目前與上一期間的餘額與調整紀錄', (tester) async {
      await openBalance(tester, withBalance());
      expect(find.text('特休：王小明'), findsOneWidget);
      expect(inDialog(find.textContaining('目前期間　2026/03/01 – 2027/02/28')), findsOneWidget);
      expect(inDialog(find.text('已給 10 天　調整 1 天　已用 2 天')), findsOneWidget);
      expect(inDialog(find.text('剩餘 9 天')), findsOneWidget);
      expect(inDialog(find.textContaining('上一期間　2025/03/01 – 2026/02/28')), findsOneWidget);
      expect(inDialog(find.text('+1 天')), findsOneWidget);
      expect(inDialog(find.text('-0.5 天')), findsOneWidget);
      expect(inDialog(find.textContaining('加班補休')), findsOneWidget);
    });

    testWidgets('未滿 6 個月（沒有期間）：顯示說明，「調整」不能按', (tester) async {
      await openBalance(tester, FakeAdminApi());
      expect(inDialog(find.textContaining('未滿 6 個月')), findsOneWidget);
      expect(tester.widget<FilledButton>(inDialog(find.widgetWithText(FilledButton, '調整'))).onPressed, isNull);
    });

    testWidgets('調整：選期間、以 0.5 天加減、填原因，送出後帶正確內容並重抓', (tester) async {
      final api = withBalance();
      await openBalance(tester, api);
      await tester.tap(inDialog(find.widgetWithText(FilledButton, '調整')));
      await tester.pumpAndSettle();
      expect(find.text('調整特休：王小明'), findsOneWidget);

      FilledButton submit() => tester.widget<FilledButton>(find.widgetWithText(FilledButton, '送出'));
      expect(daysShown(tester), '+1 天');
      expect(submit().onPressed, isNull); // 沒填原因

      await tester.tap(find.byTooltip('加 0.5 天'));
      await tester.pump();
      expect(daysShown(tester), '+1.5 天');
      await tester.enterText(find.byType(TextField).last, '補發去年的');
      await tester.pump();
      expect(submit().onPressed, isNotNull);

      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('上一期間（2025/03/01 起）').last);
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, '送出'));
      await tester.pumpAndSettle();
      expect(api.adjustments, hasLength(1));
      final a = api.adjustments.single;
      expect((a.id, a.periodStart, a.days, a.reason), ('1', '2025-03-01', 1.5, '補發去年的'));
      expect(find.text('調整特休：王小明'), findsNothing); // 成功就關閉，回到餘額對話框
      expect(find.text('特休：王小明'), findsOneWidget);
    });

    testWidgets('減到 0 會直接跳過（0 不是合法的調整）；後端拒絕時訊息顯示在對話框裡', (tester) async {
      final api = withBalance()..adjustmentError = apiError(403, {'code': 'cannot_edit_self'});
      await openBalance(tester, api);
      await tester.tap(inDialog(find.widgetWithText(FilledButton, '調整')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('減 0.5 天'));
      await tester.pump();
      expect(daysShown(tester), '+0.5 天');
      await tester.tap(find.byTooltip('減 0.5 天'));
      await tester.pump();
      expect(daysShown(tester), '-0.5 天');

      await tester.enterText(find.byType(TextField).last, '扣');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, '送出'));
      await tester.pumpAndSettle();
      expect(find.text('不能在後台修改自己的員工資料，請由其他管理者處理'), findsOneWidget);
      expect(find.text('調整特休：王小明'), findsOneWidget);
    });
  });

  group('H3 錯誤碼對照', () {
    String msg(int status, Map<String, dynamic> body) => adminErrorMessage(apiError(status, body));

    test('沒有後端 message 時用本地備用文字', () {
      expect(msg(409, {'code': 'leave_overlap'}), '跟你已申請的假重疊');
      expect(msg(400, {'code': 'leave_invalid_range'}), '請假日期範圍不正確');
      expect(msg(400, {'code': 'leave_no_workdays'}), '這段期間沒有需要請假的工作日');
      expect(msg(400, {'code': 'leave_spans_period'}), contains('週年'));
      expect(msg(400, {'code': 'no_employee_profile'}), contains('員工資料'));
      expect(msg(400, {'code': 'holiday_invalid'}), '假日清單不正確');
      expect(msg(400, {'code': 'leave_adjustment_invalid'}), '特休調整內容不正確');
      expect(msg(400, {'code': 'leave_insufficient_balance'}), '特休餘額不足');
    });

    test('餘額不足帶 remaining：顯示剩餘天數（整數不帶小數）', () {
      expect(msg(400, {'code': 'leave_insufficient_balance', 'message': '特休餘額不足', 'remaining': 1.5}), '特休餘額不足，只剩 1.5 天');
      expect(msg(400, {'code': 'leave_insufficient_balance', 'message': '特休餘額不足', 'remaining': 0}), '特休餘額不足，只剩 0 天');
      expect(msg(400, {'code': 'leave_insufficient_balance', 'message': '特休餘額不足', 'remaining': 3.0}), '特休餘額不足，只剩 3 天');
    });

    test('有後端 message 時優先用 message', () {
      expect(msg(409, {'code': 'leave_overlap', 'message': '這段期間跟你另一張待審核或已核准的假單重疊'}), '這段期間跟你另一張待審核或已核准的假單重疊');
    });
  });
}
