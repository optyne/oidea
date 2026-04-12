import 'dart:math';

/// 產生符合後端 `^[a-z0-9][a-z0-9-]*[a-z0-9]$`、長度 2–30 的 slug。
String workspaceSlugFromName(String name, {String? randomSuffix}) {
  var s = name.toLowerCase().trim().replaceAll(RegExp(r'\s+'), '-');
  s = s.replaceAll(RegExp(r'[^a-z0-9-]'), '');
  s = s.replaceAll(RegExp(r'-+'), '-');
  s = s.replaceAll(RegExp(r'^-+|-+$'), '');
  if (s.isEmpty) s = 'workspace';
  if (!RegExp(r'^[a-z0-9]').hasMatch(s)) {
    s = 'w$s';
  }
  if (!RegExp(r'[a-z0-9]$').hasMatch(s)) {
    s = '${s}x';
  }
  if (s.length < 2) {
    s = '${s}a';
  }
  if (randomSuffix != null && randomSuffix.isNotEmpty) {
    s = '$s-$randomSuffix';
  }
  if (s.length > 30) {
    s = s.substring(0, 30).replaceAll(RegExp(r'-+$'), '');
    if (s.length < 2) s = 'ws';
    if (!RegExp(r'[a-z0-9]$').hasMatch(s)) {
      s = '${s}a';
    }
    if (s.length > 30) s = s.substring(0, 30);
  }
  final valid = RegExp(r'^[a-z0-9][a-z0-9-]*[a-z0-9]$');
  if (!valid.hasMatch(s)) {
    s = 'ws${Random().nextInt(900000) + 100000}';
    if (s.length > 30) s = s.substring(0, 30);
    s = s.replaceAll(RegExp(r'-+$'), '');
    if (s.length < 2) s = 'ws1';
    if (!RegExp(r'[a-z0-9]$').hasMatch(s)) s = '${s}a';
  }
  return s;
}
