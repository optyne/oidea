import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/admin/admin_errors.dart';
import 'package:oidea/features/admin/models/admin_models.dart';
import 'package:oidea/features/admin/presentation/pages/audit_page.dart';
import 'package:oidea/features/admin/presentation/pages/departments_page.dart';
import 'package:oidea/features/admin/presentation/pages/employees_page.dart';
import 'package:oidea/features/admin/presentation/pages/my_profile_page.dart';
import 'package:oidea/features/admin/presentation/pages/roles_page.dart';

import 'support/admin_fakes.dart';

Finder inDialog(Finder f) => find.descendant(of: find.byType(AlertDialog), matching: f);

FilledButton filledButton(WidgetTester tester, String label) =>
    tester.widget<FilledButton>(find.widgetWithText(FilledButton, label));

void main() {
  group('員工名冊', () {
    testWidgets('唯讀（只有 employee.read_all）：看得到資料，沒有新增／匯入／操作按鈕', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: FakeAdminApi(), me: companyMe(readOnlyPerms)));
      await tester.pumpAndSettle();

      expect(find.text('王小明'), findsOneWidget);
      expect(find.text('李小華'), findsOneWidget);
      expect(find.text('E-1'), findsOneWidget);
      expect(find.text('新增員工'), findsNothing);
      expect(find.byTooltip('匯入 CSV'), findsNothing);
      expect(find.byType(PopupMenuButton<Object?>), findsNothing);
      expect(find.byTooltip('操作'), findsNothing);
      expect(find.text('操作'), findsNothing);
    });

    testWidgets('有 employee.manage：出現新增、匯入與每列的操作選單', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: FakeAdminApi(), me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();

      expect(find.text('新增員工'), findsOneWidget);
      expect(find.byTooltip('匯入 CSV'), findsOneWidget);
      expect(find.byTooltip('操作'), findsNWidgets(2));
    });

    testWidgets('選單項目依狀態變化：在職且已綁定有離職與解除綁定；已離職只有復職', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..employees = [
          employeeJson('1'),
          employeeJson('2', name: '離職者', status: 'terminated', userId: null, terminationDate: '2026-09-30'),
        ];
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      expect(find.text('編輯'), findsOneWidget);
      expect(find.text('離職'), findsOneWidget);
      expect(find.text('復職'), findsNothing);
      expect(find.text('解除綁定'), findsOneWidget);
      await tester.tapAt(const Offset(5, 5)); // 關選單
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('操作').last);
      await tester.pumpAndSettle();
      expect(find.text('復職'), findsOneWidget);
      expect(find.text('離職'), findsNothing);
      expect(find.text('解除綁定'), findsNothing);
    });

    testWidgets('離職對話框：沒有合法離職日就不能確認；填了才送出', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi();
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('離職'));
      await tester.pumpAndSettle();

      expect(find.text('辦理離職：王小明'), findsOneWidget);
      // 空白：不能確認
      expect(filledButton(tester, '確認離職').onPressed, isNull);

      // 格式錯誤或不存在的日期：不能確認
      final dateField = inDialog(find.byType(TextFormField));
      for (final bad in ['abc', '2026/10/27', '2026-13-01', '2026-02-30']) {
        await tester.enterText(dateField, bad);
        await tester.pump();
        expect(filledButton(tester, '確認離職').onPressed, isNull, reason: bad);
      }

      // 合法日期：可以確認
      await tester.enterText(dateField, '2026-10-27');
      await tester.pump();
      expect(filledButton(tester, '確認離職').onPressed, isNotNull);
      expect(api.terminated, isEmpty);

      await tester.tap(find.widgetWithText(FilledButton, '確認離職'));
      await tester.pumpAndSettle();
      expect(api.terminated, [(id: '1', date: '2026-10-27')]);
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('離職對話框：取消不會呼叫 API', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi();
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('離職'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(api.terminated, isEmpty);
    });

    testWidgets('離職被 owner_transfer_required 擋下：列出工作空間名稱', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..terminateError = apiError(400, {
          'statusCode': 400,
          'message': '此員工是工作空間擁有者',
          'code': 'owner_transfer_required',
          'workspaces': [
            {'id': 'w1', 'name': '研發團隊'},
            {'id': 'w2', 'name': '行銷專案'},
          ],
        });
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('離職'));
      await tester.pumpAndSettle();
      await tester.enterText(inDialog(find.byType(TextFormField)), '2026-10-27');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, '確認離職'));
      await tester.pumpAndSettle();

      expect(find.text('操作失敗'), findsOneWidget);
      expect(find.textContaining('研發團隊、行銷專案'), findsOneWidget);
      expect(find.textContaining('移交'), findsOneWidget);
    });

    testWidgets('新增表單：必填、Email 格式、日期格式都會擋；填對後送出完整欄位', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi();
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();

      await tester.tap(find.text('新增員工'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '儲存'));
      await tester.pumpAndSettle();
      expect(find.text('必填'), findsNWidgets(4)); // 編號、姓名、Email、到職日
      expect(api.createdEmployees, isEmpty);

      Finder field(String label) => inDialog(find.widgetWithText(TextFormField, label));
      await tester.enterText(field('員工編號 *'), 'E100');
      await tester.enterText(field('姓名 *'), '陳小美');
      await tester.enterText(field('Email *'), 'not-an-email');
      await tester.enterText(field('到職日 *'), '2026-02-30');
      await tester.tap(find.widgetWithText(FilledButton, '儲存'));
      await tester.pumpAndSettle();
      expect(find.text('Email 格式不正確'), findsOneWidget);
      expect(find.text('日期格式須為 YYYY-MM-DD'), findsOneWidget);
      expect(api.createdEmployees, isEmpty);

      await tester.enterText(field('Email *'), 'Mei@Corp.example');
      await tester.enterText(field('到職日 *'), '2026-10-01');
      await tester.tap(find.widgetWithText(FilledButton, '儲存'));
      await tester.pumpAndSettle();
      expect(api.createdEmployees, hasLength(1));
      expect(api.createdEmployees.single, {
        'employeeNo': 'E100',
        'email': 'mei@corp.example',
        'fullName': '陳小美',
        'hireDate': '2026-10-01',
        'employmentType': 'full_time',
      });
    });

    testWidgets('CSV 匯入：先預覽（dry-run）看到結果，才能正式匯入', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..importPreview = {'created': 2, 'updated': 1, 'unchanged': 3, 'errors': <dynamic>[]};
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('匯入 CSV'));
      await tester.pumpAndSettle();
      expect(find.text('匯入員工 CSV'), findsOneWidget);

      // 還沒預覽：不能正式匯入
      expect(filledButton(tester, '正式匯入').onPressed, isNull);

      await tester.enterText(
        inDialog(find.byType(TextField)),
        'employeeNo,email,fullName,hireDate\nE1,a@corp.example,甲,2026-01-01\n',
      );
      await tester.pump();
      expect(filledButton(tester, '正式匯入').onPressed, isNull);

      await tester.tap(find.widgetWithText(OutlinedButton, '預覽'));
      await tester.pumpAndSettle();

      // 預覽只打一次 dry-run，沒有寫入
      expect(api.importDryRuns, [true]);
      expect(find.textContaining('預覽結果'), findsOneWidget);
      expect(find.textContaining('新增 2 位'), findsOneWidget);
      expect(find.textContaining('更新 1 位'), findsOneWidget);
      expect(find.textContaining('錯誤 0 行'), findsOneWidget);
      expect(filledButton(tester, '正式匯入').onPressed, isNotNull);

      // 改了內容，之前的預覽就失效
      await tester.enterText(inDialog(find.byType(TextField)), 'employeeNo,email,fullName,hireDate\n');
      await tester.pump();
      expect(filledButton(tester, '正式匯入').onPressed, isNull);
      expect(find.textContaining('預覽結果'), findsNothing);

      await tester.tap(find.widgetWithText(OutlinedButton, '預覽'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '正式匯入'));
      await tester.pumpAndSettle();
      expect(api.importDryRuns, [true, true, false]);
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('CSV 匯入：預覽有錯誤時列出行號與訊息，且不能正式匯入', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..importPreview = {
          'created': 1,
          'updated': 0,
          'unchanged': 0,
          'errors': [
            {'line': 3, 'message': 'hireDate 格式不正確'},
          ],
        };
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('匯入 CSV'));
      await tester.pumpAndSettle();
      await tester.enterText(inDialog(find.byType(TextField)), 'x');
      await tester.pump();
      await tester.tap(find.widgetWithText(OutlinedButton, '預覽'));
      await tester.pumpAndSettle();

      expect(find.textContaining('第 3 行：hireDate 格式不正確'), findsOneWidget);
      expect(filledButton(tester, '正式匯入').onPressed, isNull);
      expect(api.importDryRuns, [true]);
    });

    testWidgets('篩選與分頁：用關鍵字、狀態查詢，下一頁帶 page=2', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()..employeesTotal = 120;
      await tester.pumpWidget(adminApp(const EmployeesPage(), api: api, me: companyMe(readOnlyPerms)));
      await tester.pumpAndSettle();
      expect(find.text('第 1 / 3 頁'), findsOneWidget);
      expect(find.text('共 120 位'), findsOneWidget);

      await tester.enterText(find.widgetWithText(TextField, '搜尋編號、姓名、Email'), '小明');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      expect(api.employeeQueries.last['q'], '小明');
      expect(api.employeeQueries.last['page'], 1);

      await tester.tap(find.byTooltip('下一頁'));
      await tester.pumpAndSettle();
      expect(api.employeeQueries.last['page'], 2);
      expect(api.employeeQueries.last['q'], '小明');
    });
  });

  group('部門', () {
    FakeAdminApi apiWithTree() => FakeAdminApi()
      ..departments = [
        deptJson('d2', '前端組', parentId: 'd1', members: 3),
        deptJson('d1', '研發部', managerName: '李主管', members: 5, children: 1),
        deptJson('d3', '行政部'),
      ];

    testWidgets('由扁平清單建出樹：子部門縮排在父部門下面', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const DepartmentsPage(), api: apiWithTree(), me: companyMe(readOnlyPerms)));
      await tester.pumpAndSettle();

      double y(String s) => tester.getTopLeft(find.text(s)).dy;
      double x(String s) => tester.getTopLeft(find.text(s)).dx;
      // 子部門排在父部門正下方，且往右縮排
      expect(y('前端組'), greaterThan(y('研發部')));
      expect(x('前端組'), greaterThan(x('研發部')));
      expect(y('前端組'), lessThan(y('行政部')));
      expect(find.textContaining('主管：李主管'), findsOneWidget);
    });

    testWidgets('唯讀（只有 employee.read_all）：沒有新增與操作選單', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const DepartmentsPage(), api: apiWithTree(), me: companyMe(readOnlyPerms)));
      await tester.pumpAndSettle();
      expect(find.text('研發部'), findsOneWidget);
      expect(find.text('新增根部門'), findsNothing);
      expect(find.byTooltip('操作'), findsNothing);
    });

    testWidgets('有 department.manage：有新增與每列的操作選單', (tester) async {
      useWideScreen(tester);
      await tester.pumpWidget(adminApp(const DepartmentsPage(), api: apiWithTree(), me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();
      expect(find.text('新增根部門'), findsOneWidget);
      expect(find.byTooltip('操作'), findsNWidgets(3));
    });

    testWidgets('刪除被 409 擋下：顯示後端的原因', (tester) async {
      useWideScreen(tester);
      final api = apiWithTree()
        ..deleteDepartmentError = apiError(409, {
          'statusCode': 409,
          'message': '部門底下還有 5 位員工，請改用封存',
          'code': 'department_not_empty',
        });
      await tester.pumpWidget(adminApp(const DepartmentsPage(), api: api, me: companyMe(hrPerms, role: 'hr')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('操作').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('刪除'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '刪除'));
      await tester.pumpAndSettle();

      expect(api.calls.single, startsWith('deleteDepartment:'));
      expect(find.text('操作失敗'), findsOneWidget);
      expect(find.text('部門底下還有 5 位員工，請改用封存'), findsOneWidget);
    });

    test('buildDepartmentTree / departmentSubtreeIds', () {
      final flat = [
        const DepartmentDto(id: 'a', name: 'A'),
        const DepartmentDto(id: 'b', name: 'B', parentId: 'a'),
        const DepartmentDto(id: 'c', name: 'C', parentId: 'b'),
        const DepartmentDto(id: 'x', name: 'X', parentId: 'missing'), // 父節點不在清單：當根
      ];
      final tree = buildDepartmentTree(flat);
      expect(tree.map((n) => n.dept.id).toSet(), {'a', 'x'});
      final a = tree.firstWhere((n) => n.dept.id == 'a');
      expect(a.children.single.dept.id, 'b');
      expect(a.children.single.children.single.dept.id, 'c');
      // 移動 a 時，a、b、c 都不能當新的上層
      expect(departmentSubtreeIds(flat, 'a'), {'a', 'b', 'c'});
      expect(departmentSubtreeIds(flat, 'c'), {'c'});
    });
  });

  group('成員與角色', () {
    final members = [
      {
        'role': 'owner',
        'user': {'id': 'u-owner', 'displayName': '老闆', 'email': 'boss@corp.example'},
      },
      {
        'role': 'member',
        'user': {'id': 'u-1', 'displayName': '王小明', 'email': 'ming@corp.example'},
      },
    ];

    testWidgets('admin：可改角色，看不到移交擁有者', (tester) async {
      final api = FakeAdminApi()..members = members;
      await tester.pumpWidget(adminApp(const RolesPage(), api: api, me: companyMe(adminPerms, role: 'admin')));
      await tester.pumpAndSettle();

      expect(find.text('王小明'), findsOneWidget);
      expect(find.text('老闆'), findsOneWidget);
      expect(find.byTooltip('變更角色'), findsOneWidget); // owner 那列只有「擁有者」標籤
      await tester.tap(find.byTooltip('變更角色'));
      await tester.pumpAndSettle();
      expect(find.text('移交擁有者給此人'), findsNothing);
      await tester.tap(find.text('改為HR'));
      await tester.pumpAndSettle();
      expect(api.calls, ['role:u-1:hr']);
    });

    testWidgets('owner：多一個「移交擁有者」，要先確認才呼叫', (tester) async {
      final api = FakeAdminApi()..members = members;
      await tester.pumpWidget(adminApp(const RolesPage(), api: api, me: companyMe(ownerPerms, role: 'owner')));
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('變更角色'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('移交擁有者給此人'));
      await tester.pumpAndSettle();
      expect(api.calls, isEmpty); // 還沒確認
      await tester.tap(find.widgetWithText(FilledButton, '移交'));
      await tester.pumpAndSettle();
      expect(api.calls, ['transfer:u-1']);
    });
  });

  group('審計日誌', () {
    Map<String, dynamic> entry(String id, String action, String actor) => {
          'id': id,
          'action': action,
          'actorId': 'u-$actor',
          'actor': {'id': 'u-$actor', 'displayName': actor, 'avatarUrl': null},
          'targetType': 'employee',
          'targetId': 'e-$id',
          'metadata': null,
          'ipAddress': '10.0.0.1',
          'createdAt': '2026-10-26T08:30:00.000Z',
        };

    testWidgets('列出時間、操作人、動作、對象；「載入更多」帶上 nextCursor', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..auditPages = {
          null: {
            'items': [entry('1', 'employee.create', '小美'), entry('2', 'employee.terminate', '阿華')],
            'nextCursor': 'cursor-abc',
          },
          'cursor-abc': {
            'items': [entry('3', 'department.create', '小美')],
            'nextCursor': null,
          },
        };
      await tester.pumpWidget(adminApp(const AuditPage(), api: api, me: companyMe(adminPerms, role: 'admin')));
      await tester.pumpAndSettle();

      expect(api.auditCursors, [null]);
      expect(find.text('employee.create'), findsOneWidget);
      expect(find.text('employee.terminate'), findsOneWidget);
      expect(find.textContaining('阿華'), findsOneWidget);
      expect(find.textContaining('對象：employee e-2'), findsOneWidget);
      expect(find.text('department.create'), findsNothing);

      await tester.tap(find.text('載入更多'));
      await tester.pumpAndSettle();

      expect(api.auditCursors, [null, 'cursor-abc']);
      // 第一頁還在，第二頁接在後面
      expect(find.text('employee.create'), findsOneWidget);
      expect(find.text('department.create'), findsOneWidget);
      // 沒有下一頁了
      expect(find.text('載入更多'), findsNothing);
      expect(find.text('已經是最後一筆'), findsOneWidget);
    });

    testWidgets('篩選：動作前綴與日期送到 API，且從第一頁重新開始', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi()
        ..auditPages = {
          null: {
            'items': [entry('1', 'employee.create', '小美')],
            'nextCursor': 'c1',
          },
        };
      await tester.pumpWidget(adminApp(const AuditPage(), api: api, me: companyMe(adminPerms, role: 'admin')));
      await tester.pumpAndSettle();

      await tester.enterText(find.widgetWithText(TextField, '動作（可用 employee.* 這種前綴）'), 'employee.*');
      await tester.enterText(find.widgetWithText(TextField, '起（含）'), '2026-10-01');
      await tester.enterText(find.widgetWithText(TextField, '迄（含）'), '2026-10-26');
      await tester.tap(find.text('套用篩選'));
      await tester.pumpAndSettle();

      final q = api.auditQueries.last;
      expect(q['action'], 'employee.*');
      expect(q['cursor'], isNull);
      expect(q['from'], isNotNull);
      // `to` 是「不含」，所以送選到那天的隔天 00:00
      final to = DateTime.parse(q['to'] as String).toLocal();
      expect(formatDate(to), '2026-10-27');
      expect(to.hour, 0);
    });

    testWidgets('日期格式錯誤：不送出查詢', (tester) async {
      useWideScreen(tester);
      final api = FakeAdminApi();
      await tester.pumpWidget(adminApp(const AuditPage(), api: api, me: companyMe(adminPerms, role: 'admin')));
      await tester.pumpAndSettle();
      final before = api.auditCursors.length;
      await tester.enterText(find.widgetWithText(TextField, '起（含）'), '10/01');
      await tester.tap(find.text('套用篩選'));
      await tester.pumpAndSettle();
      expect(find.text('日期格式須為 YYYY-MM-DD'), findsOneWidget);
      expect(api.auditCursors.length, before);
    });
  });

  group('我的資料', () {
    testWidgets('有員工資料：顯示部門、主管、到職日', (tester) async {
      final me = companyMe(memberPerms, profile: {
        'id': 'p1',
        'employeeNo': 'E001',
        'email': 'ming@corp.example',
        'fullName': '王小明',
        'jobTitle': '工程師',
        'employmentType': 'full_time',
        'employmentStatus': 'active',
        'hireDate': '2024-03-01',
        'phone': '',
        'department': {'id': 'd1', 'name': '研發部'},
        'manager': {'id': 'm1', 'fullName': '李主管'},
      });
      await tester.pumpWidget(adminApp(const MyProfilePage(), api: FakeAdminApi(), me: me));
      await tester.pumpAndSettle();

      expect(find.text('王小明'), findsOneWidget);
      expect(find.text('研發部'), findsOneWidget);
      expect(find.text('李主管'), findsOneWidget);
      expect(find.text('2024-03-01'), findsOneWidget);
      expect(find.text('正職'), findsOneWidget);
      expect(find.text('在職'), findsOneWidget);
    });

    testWidgets('profile 是 null：顯示說明，不會壞掉', (tester) async {
      await tester.pumpWidget(adminApp(const MyProfilePage(), api: FakeAdminApi(), me: companyMe(memberPerms)));
      await tester.pumpAndSettle();
      expect(find.text('尚未建立員工資料'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('沒有主管、沒有部門：顯示破折號', (tester) async {
      final me = companyMe(memberPerms, profile: {
        'id': 'p1',
        'employeeNo': 'E002',
        'email': 'x@corp.example',
        'fullName': '無主管',
        'hireDate': '2025-01-02',
        'department': null,
        'manager': null,
      });
      await tester.pumpWidget(adminApp(const MyProfilePage(), api: FakeAdminApi(), me: me));
      await tester.pumpAndSettle();
      expect(find.text('—'), findsWidgets);
      expect(find.text('2025-01-02'), findsOneWidget);
    });
  });

  group('錯誤訊息', () {
    test('owner_transfer_required 列出所有工作空間', () {
      final msg = adminErrorMessage(apiError(400, {
        'code': 'owner_transfer_required',
        'message': 'x',
        'workspaces': [
          {'id': '1', 'name': 'A 團隊'},
          {'id': '2', 'name': 'B 團隊'},
        ],
      }));
      expect(msg, contains('A 團隊、B 團隊'));
      expect(msg, contains('移交'));
    });

    test('有 code 時優先顯示後端 message；沒有 message 才用備用文字', () {
      expect(adminErrorMessage(apiError(409, {'code': 'email_taken', 'message': '此 Email 已被 E005 使用'})), '此 Email 已被 E005 使用');
      expect(adminErrorMessage(apiError(409, {'code': 'email_taken'})), contains('Email'));
      expect(adminErrorMessage(apiError(403, {'message': 'Forbidden resource'})), 'Forbidden resource');
      expect(adminErrorMessage(apiError(403, {})), '權限不足');
    });

    test('日期與 Email 驗證', () {
      expect(isValidDateString('2026-10-27'), isTrue);
      expect(isValidDateString('2024-02-29'), isTrue);
      expect(isValidDateString('2026-02-29'), isFalse);
      expect(isValidDateString('2026-1-1'), isFalse);
      expect(isValidDateString('20261027'), isFalse);
      expect(isValidEmail('a@b.co'), isTrue);
      expect(isValidEmail('a@b'), isFalse);
      expect(isValidEmail('a b@c.com'), isFalse);
      expect(formatDate(DateTime(2026, 1, 5)), '2026-01-05');
    });
  });
}
