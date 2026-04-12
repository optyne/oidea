import 'package:shared_preferences/shared_preferences.dart';

class WorkspaceStorage {
  static const _key = 'current_workspace_id';

  static Future<String?> read() async {
    final p = await SharedPreferences.getInstance();
    return p.getString(_key);
  }

  static Future<void> write(String? id) async {
    final p = await SharedPreferences.getInstance();
    if (id == null || id.isEmpty) {
      await p.remove(_key);
    } else {
      await p.setString(_key, id);
    }
  }
}
