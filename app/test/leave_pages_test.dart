import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/erp/presentation/pages/leaves_page.dart';
import 'package:oidea/features/workspace/providers/workspace_provider.dart';

import 'support/admin_fakes.dart';

Future<void> pumpLeaves(WidgetTester tester, FakeAdminApi api) async {
  useWideScreen(tester, width: 900, height: 1000);
  await tester.pumpWidget(adminApp(
    const LeavesPage(),
    api: api,
    me: companyMe(memberPerms),
    extra: [currentWorkspaceIdProvider.overrideWith((ref) => 'ws-co')],
  ));
  await tester.pumpAndSettle();
}

Future<void> openDialog(WidgetTester tester) async {
  await tester.tap(find.text('申請請假').last);
  await tester.pumpAndSettle();
}

Future<void> chooseType(WidgetTester tester, String label) async {
  await tester.tap(find.text('事假')); // 預設值，點開下拉
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

Finder inDialog(Finder f) => find.descendant(of: find.byType(AlertDialog), matching: f);

void main() {
  group('請假頁：列表與特休餘額', () {
    testWidgets('有特休餘額時顯示在最上方；沒有（null）就不顯示', (tester) async {
      final api = FakeAdminApi()..leaveBalance = annualJson(remaining: 7.5, entitled: 10, adjusted: 0.5, used: 3);
      await pumpLeaves(tester, api);
      expect(find.text('特休剩餘 7.5 天'), findsOneWidget);
      expect(find.textContaining('2026/03/01 – 2027/02/28'), findsOneWidget);
      expect(find.textContaining('已給 10、調整 0.5、已用 3'), findsOneWidget);

      await pumpLeaves(tester, FakeAdminApi()..leaveBalance = null);
      expect(find.textContaining('特休剩餘'), findsNothing);
    });

    testWidgets('列表顯示天數與半天標示：多天、起日下午起、迄日上午止、單日半天', (tester) async {
      final api = FakeAdminApi()
        ..leaves = [
          leaveJson('1', days: 3),
          leaveJson('2', startPart: 'pm', endPart: 'am', days: 2, type: 'sick'),
          leaveJson('3', startDate: '2026-11-09T00:00:00.000Z', endDate: '2026-11-09T00:00:00.000Z', endPart: 'am', days: 0.5),
          leaveJson('4', startDate: '2026-11-10T00:00:00.000Z', endDate: '2026-11-10T00:00:00.000Z', startPart: 'pm', days: 0.5),
          leaveJson('5', startPart: 'pm', days: 2.5, status: 'approved'),
        ];
      await pumpLeaves(tester, api);

      expect(find.text('2026/11/02 → 2026/11/04　3 天'), findsOneWidget);
      expect(find.text('2026/11/02 → 2026/11/04（起日下午起、迄日上午止）　2 天'), findsOneWidget);
      expect(find.text('2026/11/09（上午）　0.5 天'), findsOneWidget);
      expect(find.text('2026/11/10（下午）　0.5 天'), findsOneWidget);
      expect(find.text('2026/11/02 → 2026/11/04（起日下午起）　2.5 天'), findsOneWidget);
    });

    testWidgets('舊資料沒有 days／startPart 欄位也不會壞', (tester) async {
      final row = leaveJson('1')..remove('days')..remove('startPart')..remove('endPart');
      await pumpLeaves(tester, FakeAdminApi()..leaves = [row]);
      expect(find.text('2026/11/02 → 2026/11/04'), findsOneWidget);
    });
  });

  group('請假表單', () {
    testWidgets('顯示預覽的「共 N 天」；特休另外顯示剩餘天數', (tester) async {
      final api = FakeAdminApi()
        ..previewResult = (type, _, __) => {
              'days': 2.5,
              'annual': type == 'annual' ? annualJson(remaining: 8, entitled: 10, used: 2) : null,
            };
      await pumpLeaves(tester, api);
      await openDialog(tester);

      // 一打開就先預覽一次（預設事假、今天）
      expect(api.previewQueries, hasLength(1));
      expect(api.previewQueries.single['type'], 'personal');
      expect(inDialog(find.text('共 2.5 天')), findsOneWidget);
      expect(inDialog(find.textContaining('特休剩餘')), findsNothing);

      await chooseType(tester, '特休');
      expect(api.previewQueries.last['type'], 'annual');
      expect(inDialog(find.text('共 2.5 天')), findsOneWidget);
      expect(inDialog(find.text('特休剩餘 8 天')), findsOneWidget);
      expect(inDialog(find.textContaining('超過剩餘')), findsNothing);
    });

    testWidgets('特休天數超過剩餘：出現警告', (tester) async {
      final api = FakeAdminApi()
        ..previewResult = (_, __, ___) => {'days': 3, 'annual': annualJson(remaining: 1.5, entitled: 10, used: 8.5)};
      await pumpLeaves(tester, api);
      await openDialog(tester);
      await chooseType(tester, '特休');

      expect(inDialog(find.text('特休剩餘 1.5 天')), findsOneWidget);
      expect(inDialog(find.text('申請 3 天，超過剩餘的 1.5 天')), findsOneWidget);
    });

    testWidgets('預覽失敗：錯誤顯示在表單裡，不能送出；改了欄位會重新預覽', (tester) async {
      var fail = true;
      final api = FakeAdminApi()
        ..previewResult = (type, _, __) => fail
            ? apiError(400, {'code': 'leave_no_workdays', 'message': '這段期間沒有需要請假的工作日'})
            : {'days': 1, 'annual': null};
      await pumpLeaves(tester, api);
      await openDialog(tester);

      expect(inDialog(find.text('這段期間沒有需要請假的工作日')), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '送出')).onPressed, isNull);

      fail = false;
      await tester.tap(find.text('上午'));
      await tester.pumpAndSettle();
      expect(inDialog(find.text('共 1 天')), findsOneWidget);
      expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '送出')).onPressed, isNotNull);
    });

    testWidgets('快速連續改動只會在停下來之後預覽一次（debounce）', (tester) async {
      final api = FakeAdminApi();
      await pumpLeaves(tester, api);
      await openDialog(tester);
      expect(api.previewQueries, hasLength(1));

      await tester.tap(find.text('上午'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.text('下午'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.text('全天'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(api.previewQueries, hasLength(1)); // 還在等
      await tester.pumpAndSettle();
      expect(api.previewQueries, hasLength(2));
      expect(api.previewQueries.last['startPart'], 'full');
      expect(api.previewQueries.last['endPart'], 'full');
    });

    testWidgets('單日的上午／下午對應 endPart=am／startPart=pm，送出時一併帶上', (tester) async {
      final api = FakeAdminApi();
      await pumpLeaves(tester, api);
      await openDialog(tester);

      await tester.tap(find.text('下午'));
      await tester.pumpAndSettle();
      expect(api.previewQueries.last['startPart'], 'pm');
      expect(api.previewQueries.last['endPart'], 'full');

      await tester.tap(find.text('上午'));
      await tester.pumpAndSettle();
      expect(api.previewQueries.last['startPart'], 'full');
      expect(api.previewQueries.last['endPart'], 'am');

      await tester.tap(find.text('下午'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '看醫生');
      await tester.tap(find.widgetWithText(FilledButton, '送出'));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsNothing); // 成功就關閉
      expect(api.createdLeaves, hasLength(1));
      final body = api.createdLeaves.single;
      expect(body['workspaceId'], 'ws-co');
      expect(body['type'], 'personal');
      expect(body['startDate'], body['endDate']);
      expect(body['startPart'], 'pm');
      expect(body['endPart'], 'full');
      expect(body['reason'], '看醫生');
    });

    testWidgets('多天：起日可選「下午起」、迄日可選「上午止」（單日用的上午／下午選項消失）', (tester) async {
      final api = FakeAdminApi();
      await pumpLeaves(tester, api);
      await openDialog(tester);

      // 迄日改成隔天（日曆在下個月就先翻頁）
      final next = DateTime.now().add(const Duration(days: 1));
      await tester.tap(find.textContaining('迄：'));
      await tester.pumpAndSettle();
      if (next.month != DateTime.now().month) {
        await tester.tap(find.byTooltip('Next month'));
        await tester.pumpAndSettle();
      }
      await tester.tap(find.descendant(of: find.byType(DatePickerDialog), matching: find.text('${next.day}')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();

      expect(find.text('下午起'), findsOneWidget);
      expect(find.text('上午止'), findsOneWidget);
      expect(find.text('上午'), findsNothing);

      await tester.tap(find.text('下午起'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('上午止'));
      await tester.pumpAndSettle();
      expect(api.previewQueries.last['startPart'], 'pm');
      expect(api.previewQueries.last['endPart'], 'am');
      expect(api.previewQueries.last['startDate'] == api.previewQueries.last['endDate'], isFalse);
    });

    testWidgets('送出失敗：重疊與餘額不足的訊息顯示在表單裡，表單不關閉', (tester) async {
      final api = FakeAdminApi()..createLeaveError = apiError(409, {'code': 'leave_overlap'});
      await pumpLeaves(tester, api);
      await openDialog(tester);

      await tester.tap(find.widgetWithText(FilledButton, '送出'));
      await tester.pumpAndSettle();
      expect(inDialog(find.text('跟你已申請的假重疊')), findsOneWidget);

      api.createLeaveError = apiError(400, {'code': 'leave_insufficient_balance', 'message': '特休餘額不足', 'remaining': 1.5});
      await tester.tap(find.widgetWithText(FilledButton, '送出'));
      await tester.pumpAndSettle();
      expect(inDialog(find.text('特休餘額不足，只剩 1.5 天')), findsOneWidget);
      expect(inDialog(find.text('跟你已申請的假重疊')), findsNothing);
    });
  });
}
