import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/features/admin/admin_access.dart';
import 'package:oidea/features/admin/models/admin_models.dart';
import 'package:oidea/features/admin/providers/admin_providers.dart';
import 'package:oidea/features/erp/presentation/pages/members_page.dart';
import 'package:oidea/features/workspace/providers/workspace_provider.dart';

import 'support/admin_fakes.dart';

/// `/erp/members`：員工自建的工作空間可以邀請、改角色；公司工作空間（成員只由員工生命週期決定）
/// 導到後台的 `/admin/roles`。
/// 公司工作空間是 [workspaceId] 的 /company/me（一般成員，沒有後台權限）。
CompanyMe companyMeFor(String workspaceId) => CompanyMe.fromJson({
      'workspaceId': workspaceId,
      'role': 'member',
      'permissions': <String>[],
      'profile': null,
    });

void main() {
  /// 跟 app_router 一樣：`/erp/members` 先過 [membersRedirect]，再進 [MembersPage]。
  Widget app({
    required FakeAdminApi api,
    required String currentWorkspaceId,
    Future<CompanyMe> Function()? companyMe,
    List<dynamic> workspaces = const [],
  }) {
    late final ProviderContainer container;
    final router = GoRouter(
      initialLocation: '/erp/members',
      routes: [
        GoRoute(
          path: '/erp/members',
          redirect: (context, state) => membersRedirect(
            container.read(currentWorkspaceIdProvider),
            me: container.read(companyMeProvider).valueOrNull,
            workspaces: container.read(workspacesProvider).valueOrNull,
          ),
          builder: (context, state) => const MembersPage(),
        ),
        GoRoute(path: '/admin/roles', builder: (context, state) => const Scaffold(body: Text('ADMIN ROLES PAGE'))),
      ],
    );
    container = ProviderContainer(overrides: [
      apiClientProvider.overrideWithValue(api),
      currentWorkspaceIdProvider.overrideWith((ref) => currentWorkspaceId),
      workspacesProvider.overrideWith((ref) async => workspaces),
      companyMeProvider.overrideWith((ref) => companyMe == null ? Future.value(companyMeFor('ws-co')) : companyMe()),
    ]);
    addTearDown(container.dispose);
    return UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: router),
    );
  }

  group('員工自建的工作空間', () {
    final api = FakeAdminApi();
    setUp(() {
      api.calls.clear();
      api.members = [
        memberJson('u-me', '我自己', role: 'owner', workspaceId: 'ws-side'),
        memberJson('u-1', '王小明', workspaceId: 'ws-side'),
      ];
    });

    testWidgets('列出成員，可以用 email 邀請、建立邀請連結、改角色；沒有移除成員', (tester) async {
      await tester.pumpWidget(app(api: api, currentWorkspaceId: 'ws-side'));
      await tester.pumpAndSettle();

      expect(find.text('ADMIN ROLES PAGE'), findsNothing);
      expect(find.text('成員與權限'), findsOneWidget);
      expect(find.text('王小明'), findsOneWidget);
      expect(find.text('邀請成員'), findsOneWidget);
      expect(find.byTooltip('建立邀請連結'), findsOneWidget);

      // 用 email 邀請
      await tester.tap(find.text('邀請成員'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'bob@corp.example');
      await tester.tap(find.widgetWithText(FilledButton, '邀請'));
      await tester.pumpAndSettle();
      expect(api.calls, ['invite:ws-side:bob@corp.example:member']);

      // 邀請連結
      await tester.tap(find.byTooltip('建立邀請連結'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '產生連結'));
      await tester.pumpAndSettle();
      expect(api.calls.last, 'inviteLink:ws-side:member:7');
      expect(find.textContaining('/invite/tok-123'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, '關閉'));
      await tester.pumpAndSettle();

      // 改角色（選單裡只有角色，沒有移除）
      await tester.tap(find.byType(PopupMenuButton<String>));
      await tester.pumpAndSettle();
      expect(find.textContaining('移除'), findsNothing);
      await tester.tap(find.text('HR').last);
      await tester.pumpAndSettle();
      expect(api.calls.last, 'role:u-1:hr');
      expect(api.calls.where((c) => c.startsWith('remove:')), isEmpty);
    });

    testWidgets('/company/me 失敗（沒有公司工作空間）：照常顯示邀請', (tester) async {
      await tester.pumpWidget(app(
        api: api,
        currentWorkspaceId: 'ws-side',
        companyMe: () async => throw apiError(404, {'code': 'company_not_configured'}),
      ));
      await tester.pumpAndSettle();
      expect(find.text('邀請成員'), findsOneWidget);
      expect(find.text('ADMIN ROLES PAGE'), findsNothing);
    });
  });

  group('公司工作空間', () {
    testWidgets('目前的工作空間 = /company/me 的 workspaceId → 導到 /admin/roles，沒有邀請畫面', (tester) async {
      final api = FakeAdminApi()..members = [memberJson('u-1', '王小明')];
      await tester.pumpWidget(app(api: api, currentWorkspaceId: 'ws-co'));
      await tester.pumpAndSettle();

      expect(find.text('ADMIN ROLES PAGE'), findsOneWidget);
      expect(find.text('邀請成員'), findsNothing);
      expect(api.calls, isEmpty);
    });

    testWidgets('/company/me 失敗時，用工作空間清單的 isCompany 判斷，一樣導走', (tester) async {
      final api = FakeAdminApi();
      await tester.pumpWidget(app(
        api: api,
        currentWorkspaceId: 'ws-co',
        companyMe: () async => throw apiError(500, {'message': 'boom'}),
        workspaces: [
          {'id': 'ws-co', 'name': '公司', 'isCompany': true},
          {'id': 'ws-side', 'name': '專案', 'isCompany': false},
        ],
      ));
      await tester.pumpAndSettle();
      expect(find.text('ADMIN ROLES PAGE'), findsOneWidget);
      expect(find.text('邀請成員'), findsNothing);
    });

    testWidgets('/company/me 在進頁之後才載入完成：頁面自己導走', (tester) async {
      final api = FakeAdminApi();
      final gate = Completer<CompanyMe>();
      await tester.pumpWidget(app(api: api, currentWorkspaceId: 'ws-co', companyMe: () => gate.future));
      await tester.pump();
      // 還在載入：不露出邀請
      expect(find.text('邀請成員'), findsNothing);
      gate.complete(companyMeFor('ws-co'));
      await tester.pumpAndSettle();
      expect(find.text('ADMIN ROLES PAGE'), findsOneWidget);
    });
  });

  test('membersRedirect／isCompanyWorkspace', () {
    final me = companyMeFor('ws-co');
    expect(membersRedirect('ws-co', me: me), '/admin/roles');
    expect(membersRedirect('ws-side', me: me), isNull);
    expect(membersRedirect(null, me: me), isNull);
    expect(membersRedirect('ws-co'), isNull);
    expect(
      membersRedirect('ws-co', workspaces: [
        {'id': 'ws-co', 'isCompany': true},
      ]),
      '/admin/roles',
    );
    expect(
      membersRedirect('ws-side', workspaces: [
        {'id': 'ws-side', 'isCompany': false},
      ]),
      isNull,
    );
  });
}
