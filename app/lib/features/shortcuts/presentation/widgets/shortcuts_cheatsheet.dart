import 'package:flutter/material.dart';

/// 鍵盤快捷鍵總覽。Ctrl/⌘+/ 觸發，也可從命令面板叫出。
///
/// 純靜態資料（硬編）。當之後加了新 shortcut，就來這裡加一行；不走自動偵測，
/// 免得「看起來像 shortcut 的 key binding」和「真的可用的 shortcut」對不起來。
Future<void> showShortcutsCheatsheet(BuildContext context) {
  return showDialog<void>(
    context: context,
    builder: (_) => const Dialog(
      insetPadding: EdgeInsets.symmetric(horizontal: 40, vertical: 60),
      child: _CheatsheetBody(),
    ),
  );
}

class _ShortcutEntry {
  final String label;
  final List<String> keys; // e.g. ["Ctrl", "K"]
  const _ShortcutEntry(this.label, this.keys);
}

class _Section {
  final String title;
  final List<_ShortcutEntry> entries;
  const _Section(this.title, this.entries);
}

const _sections = <_Section>[
  _Section('全域', [
    _ShortcutEntry('開啟命令面板 / 全域搜尋', ['Ctrl', 'K']),
    _ShortcutEntry('開啟命令面板 (macOS)', ['⌘', 'K']),
    _ShortcutEntry('顯示快捷鍵清單（本視窗）', ['Ctrl', '/']),
  ]),
  _Section('筆記 · Notes', [
    _ShortcutEntry('叫出 slash 指令選單', ['/']),
    _ShortcutEntry('slash 選單：上下移動', ['↑', '↓']),
    _ShortcutEntry('slash 選單：套用目前項目', ['Enter']),
    _ShortcutEntry('slash 選單：關閉', ['Esc']),
    _ShortcutEntry('block 拖移排序', ['按住左側手柄']),
    _ShortcutEntry('轉換 / 刪除 block', ['點右側 ⋯']),
    _ShortcutEntry('折疊 / 展開 toggle', ['點 chevron']),
  ]),
  _Section('白板 · Whiteboard', [
    _ShortcutEntry('放大', ['Ctrl', '=']),
    _ShortcutEntry('縮小', ['Ctrl', '−']),
    _ShortcutEntry('重設檢視 (100%)', ['Ctrl', '0']),
    _ShortcutEntry('於游標位置縮放', ['Ctrl', '滾輪']),
    _ShortcutEntry('平移畫布', ['兩指 / 觸控板']),
  ]),
  _Section('試算表 · Spreadsheet', [
    _ShortcutEntry('確認並下移 active cell', ['Enter']),
    _ShortcutEntry('確認並右移 active cell', ['Tab']),
    _ShortcutEntry('放棄編輯（還原當格）', ['Esc']),
    _ShortcutEntry('輸入公式（任何 cell 內）', ['= ...']),
  ]),
  _Section('命令面板', [
    _ShortcutEntry('導覽建議列表', ['↑', '↓']),
    _ShortcutEntry('打開選中的項目', ['Enter']),
    _ShortcutEntry('關閉', ['Esc']),
  ]),
];

class _CheatsheetBody extends StatelessWidget {
  const _CheatsheetBody();

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 720, maxHeight: 640),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _header(context),
          const Divider(height: 1),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: LayoutBuilder(
                builder: (_, cons) {
                  final twoCol = cons.maxWidth > 560;
                  return twoCol ? _twoColumnLayout() : _singleColumnLayout();
                },
              ),
            ),
          ),
          _footer(context),
        ],
      ),
    );
  }

  Widget _header(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 12, 12),
        child: Row(
          children: [
            const Icon(Icons.keyboard_outlined, size: 20),
            const SizedBox(width: 10),
            const Text(
              '鍵盤快捷鍵',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
            const Spacer(),
            IconButton(
              icon: const Icon(Icons.close),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ],
        ),
      );

  Widget _footer(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, size: 14, color: Colors.grey.shade600),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'macOS 請用 ⌘ 取代 Ctrl。觸控裝置上大部分操作可用長按或點擊達成。',
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
              ),
            ),
          ],
        ),
      );

  Widget _twoColumnLayout() {
    // 均衡左右兩欄行數：靠 section 粒度分配，不硬切。
    final mid = (_sections.length / 2).ceil();
    final left = _sections.sublist(0, mid);
    final right = _sections.sublist(mid);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [for (final s in left) _sectionWidget(s)],
          ),
        ),
        const SizedBox(width: 24),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [for (final s in right) _sectionWidget(s)],
          ),
        ),
      ],
    );
  }

  Widget _singleColumnLayout() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [for (final s in _sections) _sectionWidget(s)],
    );
  }

  Widget _sectionWidget(_Section s) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.title,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          for (final e in s.entries) _entryRow(e),
        ],
      ),
    );
  }

  Widget _entryRow(_ShortcutEntry e) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Text(e.label, style: const TextStyle(fontSize: 13)),
          ),
          for (var i = 0; i < e.keys.length; i++) ...[
            if (i > 0)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 4),
                child: Text('+', style: TextStyle(fontSize: 11, color: Colors.grey)),
              ),
            _keyChip(e.keys[i]),
          ],
        ],
      ),
    );
  }

  Widget _keyChip(String label) {
    return Builder(
      builder: (ctx) {
        final isDark = Theme.of(ctx).brightness == Brightness.dark;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          margin: const EdgeInsets.symmetric(horizontal: 2),
          decoration: BoxDecoration(
            color: isDark ? Colors.grey.shade800 : Colors.grey.shade200,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(
              color: isDark ? Colors.grey.shade700 : Colors.grey.shade300,
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontFamily: 'monospace',
              color: isDark ? Colors.grey.shade200 : Colors.grey.shade800,
            ),
          ),
        );
      },
    );
  }
}
