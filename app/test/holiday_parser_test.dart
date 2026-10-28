import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/admin/holiday_parser.dart';

void main() {
  group('parseHolidayList', () {
    test('有效的行：日期、名稱照原樣取出，結果依日期排序', () {
      final r = parseHolidayList('2026-10-10 國慶日\n2026-01-01 元旦\n', year: 2026);
      expect(r.hasErrors, isFalse);
      expect(r.canSubmit, isTrue);
      expect(r.lines.map((l) => l.lineNo), [1, 2]);
      expect(r.items, [(date: '2026-01-01', name: '元旦'), (date: '2026-10-10', name: '國慶日')]);
    });

    test('兩種日期格式與各種分隔（空白、Tab、半形與全形逗號）都接受，日期補零', () {
      final r = parseHolidayList(
        '2026/2/17\t春節\r\n'
        '2026-02-18,春節\n'
        '2026/02/19，春節\n'
        '2026-2-20   春節　補假', // 名稱內的空白保留
        year: 2026,
      );
      expect(r.hasErrors, isFalse);
      expect(r.items.map((i) => i.date), ['2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20']);
      expect(r.items.last.name, '春節　補假');
    });

    test('空白行略過，但行號仍照原文計算', () {
      final r = parseHolidayList('\n   \n2026-05-01 勞動節\n\n2026-06-19 端午節\n', year: 2026);
      expect(r.lines.map((l) => l.lineNo), [3, 5]);
      expect(r.items.length, 2);
      expect(parseHolidayList('   \n\n', year: 2026).lines, isEmpty);
      expect(parseHolidayList('   \n\n', year: 2026).canSubmit, isFalse);
    });

    test('不存在的日期（2/30、13 月）與格式不對的行標錯，其他行不受影響', () {
      final r = parseHolidayList('2026-02-30 假日\n2026-13-01 假日\n10 月 10 日 國慶\n2026-10-10 國慶日', year: 2026);
      expect(r.lines.map((l) => l.ok), [false, false, false, true]);
      expect(r.lines[0].error, '不是有效的日期');
      expect(r.lines[1].error, '不是有效的日期');
      expect(r.lines[2].error, contains('格式不對'));
      expect(r.items, [(date: '2026-10-10', name: '國慶日')]);
      expect(r.hasErrors, isTrue);
      expect(r.canSubmit, isFalse);
    });

    test('閏日：2028-02-29 有效，2026-02-29 無效', () {
      expect(parseHolidayList('2028-02-29 閏日', year: 2028).hasErrors, isFalse);
      expect(parseHolidayList('2026-02-29 閏日', year: 2026).lines.single.error, '不是有效的日期');
    });

    test('重複的日期：後面那行標錯，第一次出現的照常保留（兩種格式寫同一天也算重複）', () {
      final r = parseHolidayList('2026-10-10 國慶日\n2026/10/10 國慶日補假\n2026-10-11 另一天', year: 2026);
      expect(r.lines.map((l) => l.ok), [true, false, true]);
      expect(r.lines[1].error, contains('日期重複'));
      expect(r.lines[1].error, contains('第 1 行'));
      expect(r.items.map((i) => i.date), ['2026-10-10', '2026-10-11']);
      expect(r.canSubmit, isFalse);
    });

    test('日期不在選定的年份：標錯', () {
      final r = parseHolidayList('2025-12-31 去年\n2027-01-01 明年\n2026-01-01 元旦', year: 2026);
      expect(r.lines[0].error, '日期不在 2026 年');
      expect(r.lines[1].error, '日期不在 2026 年');
      expect(r.lines[2].ok, isTrue);
      // 同樣的內容換年份就合法
      expect(parseHolidayList('2027-01-01 元旦', year: 2027).canSubmit, isTrue);
    });

    test('只有日期沒有名稱：標錯；名稱超過 50 字：標錯，剛好 50 字可以', () {
      final r = parseHolidayList('2026-01-01\n2026-01-02 ${'字' * 51}\n2026-01-03 ${'字' * 50}', year: 2026);
      expect(r.lines[0].error, '缺少名稱');
      expect(r.lines[1].error, contains('50'));
      expect(r.lines[2].ok, isTrue);
    });

    test('超過 60 筆：整份清單標錯，不能送出', () {
      final lines = [
        for (var i = 0; i < 61; i++)
          '2026-${(i ~/ 28 + 1).toString().padLeft(2, '0')}-${(i % 28 + 1).toString().padLeft(2, '0')} 假日$i',
      ];
      final r = parseHolidayList(lines.join('\n'), year: 2026);
      expect(r.lines.every((l) => l.ok), isTrue);
      expect(r.items.length, 61);
      expect(r.overallError, contains('60'));
      expect(r.canSubmit, isFalse);
      expect(parseHolidayList(lines.take(60).join('\n'), year: 2026).canSubmit, isTrue);
    });
  });
}
