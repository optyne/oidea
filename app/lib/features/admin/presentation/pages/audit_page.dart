import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/common_widgets.dart';
import '../../../erp/providers/erp_providers.dart';
import '../../admin_errors.dart';
import '../../models/admin_models.dart';
import '../../providers/admin_providers.dart';

/// 審計日誌（需要 `audit.read`）。
class AuditPage extends ConsumerWidget {
  const AuditPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(companyMeProvider);
    return me.when(
      loading: () => const Scaffold(body: LoadingWidget()),
      error: (e, _) => Scaffold(
        appBar: AppBar(title: const Text('審計日誌')),
        body: AppErrorWidget(message: adminErrorMessage(e), onRetry: () => ref.invalidate(companyMeProvider)),
      ),
      data: (m) => _AuditBody(workspaceId: m.workspaceId),
    );
  }
}

/// 常用的 action 前綴，給篩選欄的快速選單。
const _actionPresets = <String, String>{
  'employee.*': '員工',
  'department.*': '部門',
  'workspace.*': '工作空間／角色',
  'owner.*': '擁有者移交',
  'auth.*': '登入',
};

class _AuditBody extends ConsumerStatefulWidget {
  const _AuditBody({required this.workspaceId});
  final String workspaceId;

  @override
  ConsumerState<_AuditBody> createState() => _AuditBodyState();
}

class _AuditBodyState extends ConsumerState<_AuditBody> {
  final _from = TextEditingController();
  final _to = TextEditingController();
  final _action = TextEditingController();
  String? _actorId;
  String? _filterError;
  int _resetCount = 0;

  @override
  void initState() {
    super.initState();
    // 第一頁在畫面建好後載入。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(auditControllerProvider(widget.workspaceId).notifier).load();
    });
  }

  @override
  void dispose() {
    _from.dispose();
    _to.dispose();
    _action.dispose();
    super.dispose();
  }

  void _apply() {
    final from = _from.text.trim();
    final to = _to.text.trim();
    for (final v in [from, to]) {
      if (v.isNotEmpty && !isValidDateString(v)) {
        setState(() => _filterError = '日期格式須為 YYYY-MM-DD');
        return;
      }
    }
    setState(() => _filterError = null);
    ref.read(auditControllerProvider(widget.workspaceId).notifier).load(
          AuditFilter(
            from: from.isEmpty ? null : from,
            to: to.isEmpty ? null : to,
            action: _action.text.trim(),
            actorId: _actorId,
          ),
        );
  }

  void _clear() {
    _from.clear();
    _to.clear();
    _action.clear();
    setState(() {
      _actorId = null;
      _filterError = null;
      _resetCount++;
    });
    ref.read(auditControllerProvider(widget.workspaceId).notifier).load(const AuditFilter());
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(auditControllerProvider(widget.workspaceId));
    final members = ref.watch(workspaceMembersProvider(widget.workspaceId)).valueOrNull ?? const [];
    final actors = <MapEntry<String, String>>[
      for (final m in members.whereType<Map<String, dynamic>>())
        if ((m['user'] is Map ? (m['user'] as Map)['id'] : m['userId']) is String)
          MapEntry(
            (m['user'] is Map ? (m['user'] as Map)['id'] : m['userId']) as String,
            (m['user'] is Map ? (m['user'] as Map)['displayName'] : null) as String? ?? '（未命名）',
          ),
    ];

    return Scaffold(
      appBar: AppBar(
        title: const Text('審計日誌'),
        actions: [
          IconButton(
            tooltip: '重新載入',
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.read(auditControllerProvider(widget.workspaceId).notifier).load(),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(OideaSpace.space3),
            child: Wrap(
              spacing: OideaSpace.space3,
              runSpacing: OideaSpace.space2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                SizedBox(width: 170, child: _dateField(_from, '起（含）')),
                SizedBox(width: 170, child: _dateField(_to, '迄（含）')),
                SizedBox(
                  width: 240,
                  child: TextField(
                    controller: _action,
                    decoration: InputDecoration(
                      labelText: '動作（可用 employee.* 這種前綴）',
                      border: const OutlineInputBorder(),
                      isDense: true,
                      suffixIcon: PopupMenuButton<String>(
                        tooltip: '常用動作',
                        icon: const Icon(Icons.arrow_drop_down),
                        onSelected: (v) => setState(() => _action.text = v),
                        itemBuilder: (_) => [
                          for (final e in _actionPresets.entries)
                            PopupMenuItem(value: e.key, child: Text('${e.value}（${e.key}）')),
                        ],
                      ),
                    ),
                    onSubmitted: (_) => _apply(),
                  ),
                ),
                SizedBox(
                  width: 200,
                  child: DropdownButtonFormField<String?>(
                    // 「清除」會把操作人重設成空，換 key 讓欄位重建。
                    key: ValueKey('actor-$_resetCount'),
                    initialValue: _actorId,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: '操作人', border: OutlineInputBorder(), isDense: true),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('全部')),
                      for (final a in actors) DropdownMenuItem<String?>(value: a.key, child: Text(a.value)),
                    ],
                    onChanged: (v) => setState(() => _actorId = v),
                  ),
                ),
                FilledButton(onPressed: _apply, child: const Text('套用篩選')),
                TextButton(onPressed: _clear, child: const Text('清除')),
              ],
            ),
          ),
          if (_filterError != null)
            Padding(
              padding: const EdgeInsets.only(left: OideaSpace.space3, bottom: OideaSpace.space2),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(_filterError!, style: const TextStyle(color: Colors.red, fontSize: OideaFontSize.size12)),
              ),
            ),
          const Divider(height: 1),
          Expanded(child: _list(context, state)),
        ],
      ),
    );
  }

  Widget _dateField(TextEditingController c, String label) {
    return TextField(
      controller: c,
      keyboardType: TextInputType.datetime,
      decoration: InputDecoration(
        labelText: label,
        hintText: 'YYYY-MM-DD',
        border: const OutlineInputBorder(),
        isDense: true,
        suffixIcon: IconButton(
          tooltip: '選擇日期',
          icon: const Icon(Icons.calendar_today, size: 16),
          onPressed: () async {
            final picked = await showDatePicker(
              context: context,
              initialDate: DateTime.tryParse(c.text.trim()) ?? DateTime.now(),
              firstDate: DateTime(2020),
              lastDate: DateTime(2100),
            );
            if (picked != null) c.text = formatDate(picked);
          },
        ),
      ),
    );
  }

  Widget _list(BuildContext context, AuditState state) {
    if (state.items.isEmpty) {
      if (state.loading) return const LoadingWidget();
      if (state.error != null) {
        return AppErrorWidget(
          message: state.error!,
          onRetry: () => ref.read(auditControllerProvider(widget.workspaceId).notifier).load(),
        );
      }
      return const EmptyStateWidget(icon: Icons.fact_check_outlined, title: '沒有符合條件的紀錄');
    }
    return ListView.separated(
      itemCount: state.items.length + 1,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (ctx, i) {
        if (i == state.items.length) return _footer(state);
        return _AuditTile(entry: state.items[i]);
      },
    );
  }

  Widget _footer(AuditState state) {
    if (state.loading) {
      return const Padding(
        padding: EdgeInsets.all(OideaSpace.space4),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (state.error != null) {
      return Padding(
        padding: const EdgeInsets.all(OideaSpace.space4),
        child: Center(child: Text(state.error!, style: const TextStyle(color: Colors.red))),
      );
    }
    if (!state.hasMore) {
      return const Padding(
        padding: EdgeInsets.all(OideaSpace.space4),
        child: Center(child: Text('已經是最後一筆', style: TextStyle(color: Colors.black45))),
      );
    }
    return Padding(
      padding: const EdgeInsets.all(OideaSpace.space3),
      child: Center(
        child: OutlinedButton(
          onPressed: () => ref.read(auditControllerProvider(widget.workspaceId).notifier).loadMore(),
          child: const Text('載入更多'),
        ),
      ),
    );
  }
}

class _AuditTile extends StatelessWidget {
  const _AuditTile({required this.entry});
  final AuditEntry entry;

  @override
  Widget build(BuildContext context) {
    final target = [
      if (entry.targetType != null) entry.targetType!,
      if (entry.targetId != null) entry.targetId!,
    ].join(' ');
    return ListTile(
      dense: true,
      title: Text(entry.action, style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Text(
        '${formatTimestamp(entry.createdAt)}　・　${entry.actorName ?? entry.actorId ?? '系統'}'
        '${target.isEmpty ? '' : '　・　對象：$target'}',
      ),
      trailing: entry.metadata == null ? null : const Icon(Icons.chevron_right, size: 18),
      onTap: entry.metadata == null
          ? null
          : () => showDialog<void>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: Text(entry.action),
                  content: SingleChildScrollView(
                    child: SelectableText(
                      const JsonEncoder.withIndent('  ').convert(entry.metadata),
                      style: const TextStyle(fontFamily: 'monospace', fontSize: OideaFontSize.size12),
                    ),
                  ),
                  actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('關閉'))],
                ),
              ),
    );
  }
}
