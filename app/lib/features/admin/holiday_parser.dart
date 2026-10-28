/// 國定假日「貼上清單」的解析（純 Dart，沒有 Flutter 相依，方便單元測試）。
///
/// 每行 `YYYY-MM-DD 名稱`；日期也可寫 `YYYY/MM/DD`，日期與名稱之間可以是空白、Tab、逗號（半形或全形）。
/// 空白行略過。規則跟後端 `validateHolidayItems` 一致：日期要在選定的年份、不可重複、名稱 1–50 字、
/// 一年最多 60 筆。
library;

const int holidayMaxItems = 60;
const int holidayNameMax = 50;

/// 解析後的一行。[error] 為 null 代表這行可以用。
class ParsedHolidayLine {
  const ParsedHolidayLine({required this.lineNo, required this.raw, this.date, this.name, this.error});

  /// 原文的行號（從 1 開始，空白行也算）。
  final int lineNo;
  final String raw;

  /// 正規化後的 `YYYY-MM-DD`；日期讀不出來時是 null。
  final String? date;
  final String? name;
  final String? error;

  bool get ok => error == null;
}

class HolidayParseResult {
  const HolidayParseResult({required this.lines, required this.items, this.overallError});

  /// 所有非空白行（含錯誤的），依原文順序。
  final List<ParsedHolidayLine> lines;

  /// 沒有錯誤的行，依日期排序。
  final List<({String date, String name})> items;

  /// 整份清單的問題（例如超過 60 筆）；null 代表沒有。
  final String? overallError;

  bool get hasErrors => overallError != null || lines.any((l) => !l.ok);

  /// 可以送出：至少一行、沒有任何錯誤。
  bool get canSubmit => lines.isNotEmpty && !hasErrors;
}

final RegExp _lineRe = RegExp(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[\s,，]+(.*))?$');

String _pad(int n, int width) => n.toString().padLeft(width, '0');

/// 解析貼上的文字。[year] 是目前選的年份。
HolidayParseResult parseHolidayList(String text, {required int year}) {
  final lines = <ParsedHolidayLine>[];
  final firstLineOfDate = <String, int>{};
  final rawLines = text.split(RegExp(r'\r\n|\r|\n'));

  for (var i = 0; i < rawLines.length; i++) {
    final raw = rawLines[i];
    final line = raw.trim();
    if (line.isEmpty) continue;
    final lineNo = i + 1;

    final m = _lineRe.firstMatch(line);
    if (m == null) {
      lines.add(ParsedHolidayLine(lineNo: lineNo, raw: raw, error: '格式不對，應為「YYYY-MM-DD 名稱」'));
      continue;
    }

    final y = int.parse(m.group(1)!);
    final mo = int.parse(m.group(2)!);
    final d = int.parse(m.group(3)!);
    final probe = DateTime.utc(y, mo, d);
    if (probe.year != y || probe.month != mo || probe.day != d) {
      lines.add(ParsedHolidayLine(lineNo: lineNo, raw: raw, error: '不是有效的日期'));
      continue;
    }
    final date = '${_pad(y, 4)}-${_pad(mo, 2)}-${_pad(d, 2)}';
    final name = (m.group(4) ?? '').trim();

    String? error;
    if (y != year) {
      error = '日期不在 $year 年';
    } else if (name.isEmpty) {
      error = '缺少名稱';
    } else if (name.length > holidayNameMax) {
      error = '名稱最多 $holidayNameMax 字';
    } else if (firstLineOfDate.containsKey(date)) {
      error = '日期重複（第 ${firstLineOfDate[date]} 行已有 $date）';
    }
    if (error == null) firstLineOfDate[date] = lineNo;

    lines.add(ParsedHolidayLine(lineNo: lineNo, raw: raw, date: date, name: name, error: error));
  }

  final items = [
    for (final l in lines)
      if (l.ok) (date: l.date!, name: l.name!),
  ]..sort((a, b) => a.date.compareTo(b.date));

  final overall = items.length > holidayMaxItems ? '一年最多 $holidayMaxItems 個假日，目前有 ${items.length} 筆' : null;
  return HolidayParseResult(lines: lines, items: items, overallError: overall);
}
