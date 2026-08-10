import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/core/network/api_client.dart';
import 'package:oidea/features/meeting/presentation/pages/calendar_page.dart';
import 'package:oidea/features/workspace/providers/workspace_provider.dart';

class _FakeApi extends Fake implements ApiClient {
  @override
  Future<List<dynamic>> getCalendarTasks(String workspaceId,
      {DateTime? from, DateTime? to}) async => [
        {
          'id': 't-1',
          'title': '任務A',
          'dueDate': '2026-08-10T00:00:00.000Z',
          'priority': 'high',
          'projectId': 'p-1',
          'projectName': 'P1',
          'columnId': 'c1',
          'completed': false,
        },
      ];
  @override
  Future<List<dynamic>> getMeetings(String workspaceId) async => [
        {
          'id': 'm-1',
          'title': '會議X',
          'startTime': '2026-08-10T10:00:00.000Z',
          'endTime': '2026-08-10T11:00:00.000Z',
          'status': 'scheduled',
        },
      ];
  @override
  Future<List<dynamic>> getProjects(String workspaceId) async => [];
}

Future<void> _pump(WidgetTester tester, {ApiClient? api}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api ?? _FakeApi()),
        workspacesProvider.overrideWith((ref) async => [
              {'id': 'w-1', 'name': 'WS'},
            ]),
        currentWorkspaceIdProvider.overrideWith((ref) => 'w-1'),
      ],
      child: const MaterialApp(home: CalendarPage()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('日曆：同時顯示任務與會議', (tester) async {
    await _pump(tester);
    expect(find.text('行事曆'), findsWidgets);
    expect(find.text('任務A'), findsWidgets); // 下方日清單
    expect(find.text('會議X'), findsWidgets);
  });

  testWidgets('關閉「顯示任務」後任務消失', (tester) async {
    await _pump(tester);
    await tester.tap(find.byTooltip('顯示任務'));
    await tester.pumpAndSettle();
    expect(find.text('任務A'), findsNothing);
  });

  testWidgets('關閉「顯示會議」後會議消失', (tester) async {
    await _pump(tester);
    await tester.tap(find.byTooltip('顯示會議'));
    await tester.pumpAndSettle();
    expect(find.text('會議X'), findsNothing);
  });

  testWidgets('點 FAB 建任務：呼叫 createTask', (tester) async {
    final created = <Map<String, dynamic>>[];
    await _pump(tester, api: _FakeApiForCreate(created));
    // 點 FAB（預設建任務；長按才是建會議）
    await tester.tap(find.byType(FloatingActionButton));
    await tester.pumpAndSettle();
    // 輸入標題
    await tester.enterText(find.byType(TextField), '新任務');
    // 選擇專案
    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('P1').last);
    await tester.pumpAndSettle();
    // 建立
    await tester.tap(find.widgetWithText(FilledButton, '建立'));
    await tester.pumpAndSettle();
    expect(created, isNotEmpty);
    expect(created.first['title'], '新任務');
  });
}

class _FakeApiForCreate extends _FakeApi {
  final List<Map<String, dynamic>> created;
  _FakeApiForCreate(this.created);

  @override
  Future<List<dynamic>> getCalendarTasks(String workspaceId,
      {DateTime? from, DateTime? to}) async => [];

  @override
  Future<List<dynamic>> getProjects(String workspaceId) async => [
        {'id': 'p-1', 'name': 'P1'},
      ];

  @override
  Future<Map<String, dynamic>> getProject(String id) async => {
        'id': 'p-1',
        'name': 'P1',
        'columns': [
          {'id': 'c1', 'name': '待辦', 'position': 0},
        ],
      };

  @override
  Future<Map<String, dynamic>> createTask(Map<String, dynamic> body) async {
    created.add(body);
    return {'id': 't-new', ...body};
  }
}
