import 'package:dio/dio.dart';

/// 後端沒帶 message 時的備用文字（正常情況後端的 message 已是繁體中文）。
const Map<String, String> _fallbackByCode = {
  'company_not_configured': '尚未設定公司工作空間',
  'cannot_terminate_self': '不能辦理自己的離職',
  'already_terminated': '這位員工已經離職',
  'not_terminated': '這位員工目前不是離職狀態',
  'employee_no_taken': '員工編號已被使用',
  'email_taken': 'Email 已被使用',
  'email_locked_bound': '已綁定登入帳號的員工不能修改 Email，請先解除綁定',
  'manager_cycle': '主管不能是自己或自己的下屬',
  'manager_not_found': '找不到指定的主管',
  'department_not_found': '找不到指定的部門',
  'department_cycle': '部門不能移到自己或自己的子部門底下',
  'department_name_taken': '同一層已有同名的部門',
  'department_not_empty': '部門底下還有員工或子部門，不能刪除（可改為封存）',
  'department_archived': '部門已封存，不能指派員工',
  'not_bound': '這位員工尚未綁定登入帳號',
  'invalid_date': '日期格式不正確，請使用 YYYY-MM-DD',
  'invalid_csv': 'CSV 格式不正確：第一行必須是欄位名稱，且至少要有一筆資料',
};
// 後端 backend/src/employees/h2-app-contract.spec.ts 會讀這個檔，確認上面的鍵（加上下面特別處理的
// owner_transfer_required）跟後端會送的 H2 錯誤碼完全相同。新增或移除錯誤碼時兩邊要一起改。

/// 把 API 例外轉成給使用者看的繁體中文訊息。
///
/// - `owner_transfer_required`：列出還需要先移交的工作空間。
/// - 其他有 `code` 的錯誤：優先顯示後端 `message`，沒有才用本地備用文字。
/// - 沒有 `code`：403 / 404 / 連線問題給固定說明，其餘顯示後端 `message`。
String adminErrorMessage(Object error) {
  if (error is! DioException) return error.toString();

  final data = error.response?.data;
  final status = error.response?.statusCode;
  // 只有 CSV 匯入會遇到。超過 express 的請求大小上限時回應不是 JSON、訊息是英文，一律給固定說明。
  if (status == 413) return '內容太大（上限 1 MB），請分批匯入';
  if (data is Map) {
    final code = data['code'];
    final message = _messageOf(data['message']);

    if (code == 'owner_transfer_required') {
      final names = <String>[];
      final ws = data['workspaces'];
      if (ws is List) {
        for (final w in ws) {
          if (w is Map && w['name'] is String) names.add(w['name'] as String);
        }
      }
      final list = names.isEmpty ? '' : '：${names.join('、')}';
      return '這位員工是下列工作空間的擁有者$list。請先到「成員與角色」移交擁有者身分，再辦理離職。';
    }

    if (code is String) {
      return message ?? _fallbackByCode[code] ?? '操作失敗（$code）';
    }
    if (message != null) return message;
  }

  switch (status) {
    case 401:
      return '登入已過期，請重新登入';
    case 403:
      return '權限不足';
    case 404:
      return '找不到資料';
  }
  switch (error.type) {
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.receiveTimeout:
    case DioExceptionType.sendTimeout:
    case DioExceptionType.connectionError:
      return '無法連線到伺服器，請稍後再試';
    default:
      return error.message ?? '操作失敗';
  }
}

String? _messageOf(Object? m) {
  if (m is String && m.isNotEmpty) return m;
  if (m is List && m.isNotEmpty) return m.whereType<String>().join('；');
  return null;
}
