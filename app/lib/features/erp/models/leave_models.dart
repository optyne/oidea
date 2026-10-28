/// 請假規則（H3）用到的資料模型。欄位對應 notes/h3-design.md「As built」。
///
/// 只做防禦性解析：缺欄位給預設值，不丟例外。
/// 後端 `backend/src/attendance/h3-app-contract.spec.ts` 會讀這個檔，確認 `fromJson` 讀的鍵
/// 真的都在後端回應裡。
library;

String? _strOrNull(Object? v) => v is String && v.isNotEmpty ? v : null;
String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;
double _num(Object? v) => v is num ? v.toDouble() : 0;

/// 天數顯示：整數不帶小數（`2`），半天帶一位（`2.5`）。
String formatDayCount(num days) {
  final d = days.toDouble();
  return d == d.roundToDouble() ? d.toInt().toString() : d.toStringAsFixed(1);
}

/// 「2.5 天」。
String formatDays(num days) => '${formatDayCount(days)} 天';

/// 調整用的有號天數：`+1`、`-0.5`。
String formatSignedDays(num days) => '${days > 0 ? '+' : ''}${formatDayCount(days)} 天';

/// 特休餘額（preview、`GET /attendance/leaves/balance`、後台 current／previous 共用）。
/// 日期是 `YYYY-MM-DD`，[periodEnd] 含當天；[periodStart]／[periodEnd] 只有在未滿 6 個月（preview）時是 null。
class AnnualBalance {
  const AnnualBalance({
    this.periodStart,
    this.periodEnd,
    this.entitled = 0,
    this.adjusted = 0,
    this.used = 0,
    this.remaining = 0,
  });

  final String? periodStart;
  final String? periodEnd;
  final double entitled;
  final double adjusted;
  final double used;
  final double remaining;

  bool get hasPeriod => periodStart != null && periodEnd != null;

  /// 「2026/03/01 – 2027/02/28」。
  String get periodLabel =>
      hasPeriod ? '${periodStart!.replaceAll('-', '/')} – ${periodEnd!.replaceAll('-', '/')}' : '';

  factory AnnualBalance.fromJson(Map<String, dynamic> j) {
    return AnnualBalance(
      periodStart: _strOrNull(j['periodStart']),
      periodEnd: _strOrNull(j['periodEnd']),
      entitled: _num(j['entitled']),
      adjusted: _num(j['adjusted']),
      used: _num(j['used']),
      remaining: _num(j['remaining']),
    );
  }

  static AnnualBalance? maybe(Object? v) => v is Map<String, dynamic> ? AnnualBalance.fromJson(v) : null;
}

/// `GET /attendance/leaves/preview`。
class LeavePreview {
  const LeavePreview({required this.days, this.annual});

  final double days;
  final AnnualBalance? annual;

  factory LeavePreview.fromJson(Map<String, dynamic> j) {
    return LeavePreview(
      days: _num(j['days']),
      annual: AnnualBalance.maybe(j['annual']),
    );
  }
}

/// `GET /admin/employees/:id/leave-balance` 的 `adjustments` 一列（也是 POST adjustments 的回應）。
class LeaveAdjustment {
  const LeaveAdjustment({
    required this.id,
    required this.periodStart,
    required this.days,
    required this.reason,
    this.createdAt,
  });

  final String id;
  final String periodStart;
  final double days;
  final String reason;
  final String? createdAt;

  factory LeaveAdjustment.fromJson(Map<String, dynamic> j) {
    return LeaveAdjustment(
      id: _str(j['id']),
      periodStart: _str(j['periodStart']),
      days: _num(j['days']),
      reason: _str(j['reason']),
      createdAt: _strOrNull(j['createdAt']),
    );
  }
}

/// `GET /admin/employees/:id/leave-balance`。
class EmployeeLeaveBalance {
  const EmployeeLeaveBalance({this.current, this.previous, this.adjustments = const []});

  final AnnualBalance? current;
  final AnnualBalance? previous;
  final List<LeaveAdjustment> adjustments;

  /// 可以調整的期間起始日（目前與上一個期間）。
  List<String> get adjustablePeriodStarts => [
        if (current?.periodStart != null) current!.periodStart!,
        if (previous?.periodStart != null) previous!.periodStart!,
      ];

  factory EmployeeLeaveBalance.fromJson(Map<String, dynamic> j) {
    final adj = j['adjustments'];
    return EmployeeLeaveBalance(
      current: AnnualBalance.maybe(j['current']),
      previous: AnnualBalance.maybe(j['previous']),
      adjustments: adj is List ? adj.whereType<Map<String, dynamic>>().map(LeaveAdjustment.fromJson).toList() : const [],
    );
  }
}

/// 國定假日一列。
class HolidayItem {
  const HolidayItem({required this.date, required this.name});

  final String date;
  final String name;

  Map<String, dynamic> toJson() => {'date': date, 'name': name};

  factory HolidayItem.fromJson(Map<String, dynamic> j) {
    return HolidayItem(date: _str(j['date']), name: _str(j['name']));
  }
}

/// `GET /admin/holidays?year=` 與 `PUT /admin/holidays/:year` 的回應。
class HolidayYear {
  const HolidayYear({required this.year, this.items = const []});

  final int year;
  final List<HolidayItem> items;

  factory HolidayYear.fromJson(Map<String, dynamic> j) {
    final items = j['items'];
    return HolidayYear(
      year: j['year'] is num ? (j['year'] as num).toInt() : 0,
      items: items is List ? items.whereType<Map<String, dynamic>>().map(HolidayItem.fromJson).toList() : const [],
    );
  }
}

// ───────────────────────── 假單的半天標示 ─────────────────────────

/// 假單列表上的半天標示（[startPart]：`full` | `pm`；[endPart]：`full` | `am`）：多天 → `（下午起）`／`（上午止）`；同一天 → `上午`／`下午`；全天回空字串。
String leavePartsNote({required bool sameDay, required String startPart, required String endPart}) {
  if (sameDay) {
    if (startPart == 'pm') return '下午';
    if (endPart == 'am') return '上午';
    return '';
  }
  final parts = <String>[
    if (startPart == 'pm') '起日下午起',
    if (endPart == 'am') '迄日上午止',
  ];
  return parts.join('、');
}
