/// Excel-style formula engine (純 Dart, 可單元測試).
///
/// 支援：
///   - 數字、字串、布林字面量
///   - 四則運算 `+ - * / ^` 與一元 `-`
///   - 比較 `= <> < <= > >=`
///   - Cell ref `A1`, range `A1:B3`
///   - 函式：SUM, AVG/AVERAGE, MIN, MAX, COUNT, IF, CONCAT, ROUND, ABS
///   - 字串串接 `&`
///
/// 不支援（現階段）：絕對參照 `$A$1`、多 sheet `Sheet!A1`、陣列公式、LOOKUP。
///
/// Values are kept as `num` | `String` | `bool` | `_ErrorValue`.
/// 錯誤以 `FormulaError` 表示；遇錯 evaluate 回 `"#ERR!"` 系列字串供 UI 顯示。
library;

import 'dart:math' as math;

// ────────────────────────── Public API ──────────────────────────────────

class FormulaError implements Exception {
  final String code; // e.g. "#REF!", "#DIV/0!", "#NAME?"
  final String? detail;
  FormulaError(this.code, [this.detail]);
  @override
  String toString() => detail == null ? code : '$code ($detail)';
}

/// 從單格的 raw 字串取出它要評估的公式（`=` 開頭）。
/// 回傳 null 代表不是公式 —— caller 應把值直接當字面量（num 或 string）。
String? asFormula(String raw) {
  if (raw.isEmpty) return null;
  if (raw[0] == '=' && raw.length > 1) return raw.substring(1);
  return null;
}

/// 對一張 sheet 的 cells 做「**所有公式一次 recompute**」並回傳 new map：
/// `{ "A1": {"v": 42}, "B1": {"v": 42, "f": "=A1", "c": 42} ... }`
///
/// - `v` = raw value (original text from user; unchanged for literals, original
///   `=...` for formulas).
/// - `f` = formula string without `=`; only present if raw started with `=`.
/// - `c` = cached computed value; for formulas is the evaluated result.
///
/// 來源 cells map 結構：`{address: {"v": anyLiteral | "=..."}}`
/// 回傳的結構跟 server 預期相同（`v` 是 display-time raw；不攪擾公式字串）。
///
/// 循環參照 → 該 cell cached 值回 `"#CYCLE!"`。
/// 非法公式 → `"#ERR!"` 或 `"#NAME?"` 或 `"#REF!"`.
Map<String, dynamic> recomputeCells(Map<String, dynamic> rawCells) {
  // 先整理：每格分別記錄「字面量 value」或「formula 字串」
  final formulas = <String, String>{};
  final literals = <String, Object?>{};
  for (final entry in rawCells.entries) {
    final cell = entry.value;
    if (cell is! Map) continue;
    final up = entry.key.toUpperCase();
    final v = cell['v'];
    if (v is String) {
      final f = asFormula(v);
      if (f != null) {
        formulas[up] = f;
        continue;
      }
    }
    literals[up] = v;
  }

  // 計算每個 formula cell，用 memoization + 堆疊偵測 cycle
  final cache = <String, Object?>{};
  final inStack = <String>{};

  Object? resolveCell(String addr) {
    final up = addr.toUpperCase();
    if (cache.containsKey(up)) return cache[up];
    if (literals.containsKey(up)) {
      final v = literals[up];
      cache[up] = v;
      return v;
    }
    if (formulas.containsKey(up)) {
      if (inStack.contains(up)) {
        final err = FormulaError('#CYCLE!');
        cache[up] = err;
        return err;
      }
      inStack.add(up);
      try {
        final src = formulas[up]!;
        final ast = _parse(src);
        final val = ast.eval(_Ctx(resolveCell));
        cache[up] = val;
        return val;
      } on FormulaError catch (e) {
        cache[up] = e;
        return e;
      } catch (_) {
        final err = FormulaError('#ERR!');
        cache[up] = err;
        return err;
      } finally {
        inStack.remove(up);
      }
    }
    // 空 cell
    cache[up] = null;
    return null;
  }

  // 觸發全部計算
  for (final k in formulas.keys) {
    resolveCell(k);
  }

  // 組回 output map
  final out = <String, dynamic>{};
  for (final entry in rawCells.entries) {
    final addr = entry.key;
    final cell = entry.value;
    if (cell is! Map) continue;
    final rawV = cell['v'];
    final f = (rawV is String) ? asFormula(rawV) : null;
    if (f != null) {
      final computed = cache[addr.toUpperCase()];
      out[addr] = {
        'v': rawV,
        'f': f,
        'c': _displayValue(computed),
      };
    } else {
      out[addr] = {'v': rawV};
    }
  }
  return out;
}

/// 把 cached value 轉成 server / UI 可接受的型別（num/string/bool）；
/// 錯誤物件回傳其 code 字串。
Object? _displayValue(Object? v) {
  if (v is FormulaError) return v.code;
  return v;
}

// ────────────────────────── Lexer / Tokens ──────────────────────────────

enum _TT {
  number,
  string,
  ident, // function name or TRUE/FALSE
  cell, // A1, AA99
  range, // A1:B3
  plus,
  minus,
  star,
  slash,
  caret,
  amp,
  eq,
  ne,
  lt,
  le,
  gt,
  ge,
  lparen,
  rparen,
  comma,
  eof,
}

class _Tok {
  final _TT type;
  final String text;
  final Object? literal; // pre-parsed for number/string/bool
  _Tok(this.type, this.text, [this.literal]);
}

List<_Tok> _lex(String src) {
  final out = <_Tok>[];
  int i = 0;
  final n = src.length;
  bool isDigit(int c) => c >= 0x30 && c <= 0x39;
  bool isAlpha(int c) =>
      (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F;
  bool isAlnum(int c) => isDigit(c) || isAlpha(c);

  while (i < n) {
    final ch = src.codeUnitAt(i);
    if (ch == 0x20 || ch == 0x09 || ch == 0x0A || ch == 0x0D) {
      i++;
      continue;
    }
    // Number
    if (isDigit(ch) || (ch == 0x2E && i + 1 < n && isDigit(src.codeUnitAt(i + 1)))) {
      int j = i;
      bool sawDot = false;
      while (j < n) {
        final c = src.codeUnitAt(j);
        if (isDigit(c)) {
          j++;
        } else if (c == 0x2E && !sawDot) {
          sawDot = true;
          j++;
        } else {
          break;
        }
      }
      final text = src.substring(i, j);
      final v = num.tryParse(text) ?? 0;
      out.add(_Tok(_TT.number, text, v));
      i = j;
      continue;
    }
    // String "..."
    if (ch == 0x22) {
      int j = i + 1;
      final sb = StringBuffer();
      while (j < n) {
        final c = src.codeUnitAt(j);
        if (c == 0x22) {
          if (j + 1 < n && src.codeUnitAt(j + 1) == 0x22) {
            sb.writeCharCode(0x22);
            j += 2;
            continue;
          }
          break;
        }
        sb.writeCharCode(c);
        j++;
      }
      if (j >= n) throw FormulaError('#ERR!', 'unterminated string');
      out.add(_Tok(_TT.string, src.substring(i, j + 1), sb.toString()));
      i = j + 1;
      continue;
    }
    // Identifier (function name, TRUE/FALSE, or cell ref A1)
    if (isAlpha(ch)) {
      int j = i;
      while (j < n && isAlpha(src.codeUnitAt(j))) {
        j++;
      }
      final letters = src.substring(i, j);
      // Could be cell ref if followed by digits
      if (j < n && isDigit(src.codeUnitAt(j))) {
        int k = j;
        while (k < n && isDigit(src.codeUnitAt(k))) {
          k++;
        }
        final cell = src.substring(i, k).toUpperCase();
        // Peek for `:` range
        if (k < n && src.codeUnitAt(k) == 0x3A) {
          int m = k + 1;
          while (m < n && isAlpha(src.codeUnitAt(m))) {
            m++;
          }
          int mDigits = m;
          while (mDigits < n && isDigit(src.codeUnitAt(mDigits))) {
            mDigits++;
          }
          if (mDigits > m) {
            final rng = src.substring(i, mDigits).toUpperCase();
            out.add(_Tok(_TT.range, rng));
            i = mDigits;
            continue;
          }
        }
        out.add(_Tok(_TT.cell, cell));
        i = k;
        continue;
      }
      // pure ident
      final up = letters.toUpperCase();
      if (up == 'TRUE' || up == 'FALSE') {
        out.add(_Tok(_TT.ident, up, up == 'TRUE'));
      } else {
        out.add(_Tok(_TT.ident, up));
      }
      i = j;
      continue;
    }
    // Operators / punctuation
    switch (ch) {
      case 0x2B:
        out.add(_Tok(_TT.plus, '+'));
        i++;
        continue;
      case 0x2D:
        out.add(_Tok(_TT.minus, '-'));
        i++;
        continue;
      case 0x2A:
        out.add(_Tok(_TT.star, '*'));
        i++;
        continue;
      case 0x2F:
        out.add(_Tok(_TT.slash, '/'));
        i++;
        continue;
      case 0x5E:
        out.add(_Tok(_TT.caret, '^'));
        i++;
        continue;
      case 0x26:
        out.add(_Tok(_TT.amp, '&'));
        i++;
        continue;
      case 0x3D:
        out.add(_Tok(_TT.eq, '='));
        i++;
        continue;
      case 0x3C:
        if (i + 1 < n && src.codeUnitAt(i + 1) == 0x3D) {
          out.add(_Tok(_TT.le, '<='));
          i += 2;
          continue;
        }
        if (i + 1 < n && src.codeUnitAt(i + 1) == 0x3E) {
          out.add(_Tok(_TT.ne, '<>'));
          i += 2;
          continue;
        }
        out.add(_Tok(_TT.lt, '<'));
        i++;
        continue;
      case 0x3E:
        if (i + 1 < n && src.codeUnitAt(i + 1) == 0x3D) {
          out.add(_Tok(_TT.ge, '>='));
          i += 2;
          continue;
        }
        out.add(_Tok(_TT.gt, '>'));
        i++;
        continue;
      case 0x28:
        out.add(_Tok(_TT.lparen, '('));
        i++;
        continue;
      case 0x29:
        out.add(_Tok(_TT.rparen, ')'));
        i++;
        continue;
      case 0x2C:
        out.add(_Tok(_TT.comma, ','));
        i++;
        continue;
    }
    throw FormulaError('#ERR!', 'unexpected char `${String.fromCharCode(ch)}`');
  }
  out.add(_Tok(_TT.eof, ''));
  return out;
}

// ────────────────────────── Parser (recursive descent) ───────────────

abstract class _Node {
  Object? eval(_Ctx ctx);
}

class _NumLit extends _Node {
  final num v;
  _NumLit(this.v);
  @override
  Object? eval(_Ctx ctx) => v;
}

class _StrLit extends _Node {
  final String v;
  _StrLit(this.v);
  @override
  Object? eval(_Ctx ctx) => v;
}

class _BoolLit extends _Node {
  final bool v;
  _BoolLit(this.v);
  @override
  Object? eval(_Ctx ctx) => v;
}

class _CellRef extends _Node {
  final String addr;
  _CellRef(this.addr);
  @override
  Object? eval(_Ctx ctx) {
    final v = ctx.resolve(addr);
    if (v is FormulaError) throw v;
    return v;
  }
}

class _RangeRef extends _Node {
  final String start;
  final String end;
  _RangeRef(this.start, this.end);
  Iterable<Object?> values(_Ctx ctx) sync* {
    final s = _splitAddr(start);
    final e = _splitAddr(end);
    final c1 = math.min(s.col, e.col), c2 = math.max(s.col, e.col);
    final r1 = math.min(s.row, e.row), r2 = math.max(s.row, e.row);
    for (var r = r1; r <= r2; r++) {
      for (var c = c1; c <= c2; c++) {
        final addr = _colLabel(c) + (r + 1).toString();
        final v = ctx.resolve(addr);
        if (v is FormulaError) throw v;
        yield v;
      }
    }
  }

  @override
  Object? eval(_Ctx ctx) {
    throw FormulaError('#ERR!', 'range used outside of function');
  }
}

class _Unary extends _Node {
  final _TT op;
  final _Node rhs;
  _Unary(this.op, this.rhs);
  @override
  Object? eval(_Ctx ctx) {
    final v = _toNum(rhs.eval(ctx));
    return op == _TT.minus ? -v : v;
  }
}

class _Binary extends _Node {
  final _TT op;
  final _Node lhs;
  final _Node rhs;
  _Binary(this.op, this.lhs, this.rhs);
  @override
  Object? eval(_Ctx ctx) {
    final l = lhs.eval(ctx);
    final r = rhs.eval(ctx);
    switch (op) {
      case _TT.plus:
        return _toNum(l) + _toNum(r);
      case _TT.minus:
        return _toNum(l) - _toNum(r);
      case _TT.star:
        return _toNum(l) * _toNum(r);
      case _TT.slash:
        final d = _toNum(r);
        if (d == 0) throw FormulaError('#DIV/0!');
        return _toNum(l) / d;
      case _TT.caret:
        return math.pow(_toNum(l), _toNum(r));
      case _TT.amp:
        return '${_toStr(l)}${_toStr(r)}';
      case _TT.eq:
        return _eq(l, r);
      case _TT.ne:
        return !_eq(l, r);
      case _TT.lt:
        return _cmp(l, r) < 0;
      case _TT.le:
        return _cmp(l, r) <= 0;
      case _TT.gt:
        return _cmp(l, r) > 0;
      case _TT.ge:
        return _cmp(l, r) >= 0;
      default:
        throw FormulaError('#ERR!');
    }
  }
}

class _Call extends _Node {
  final String name;
  final List<_Node> args;
  _Call(this.name, this.args);

  @override
  Object? eval(_Ctx ctx) {
    switch (name) {
      case 'SUM':
        return _reduceNum(args, ctx, 0, (acc, v) => acc + v);
      case 'AVG':
      case 'AVERAGE':
        {
          num total = 0;
          int count = 0;
          for (final v in _expandNums(args, ctx)) {
            total += v;
            count++;
          }
          if (count == 0) throw FormulaError('#DIV/0!');
          return total / count;
        }
      case 'MIN':
        return _reduceNum(args, ctx, double.infinity, math.min).toDouble();
      case 'MAX':
        return _reduceNum(args, ctx, double.negativeInfinity, math.max).toDouble();
      case 'COUNT':
        {
          int c = 0;
          for (final v in _expandAll(args, ctx)) {
            if (v is num) c++;
            else if (v is String && num.tryParse(v) != null) c++;
          }
          return c;
        }
      case 'IF':
        if (args.length < 2 || args.length > 3) throw FormulaError('#ERR!', 'IF args');
        final cond = args[0].eval(ctx);
        final truthy = cond == true ||
            (cond is num && cond != 0) ||
            (cond is String && cond.isNotEmpty);
        if (truthy) return args[1].eval(ctx);
        return args.length == 3 ? args[2].eval(ctx) : false;
      case 'CONCAT':
      case 'CONCATENATE':
        {
          final sb = StringBuffer();
          for (final v in _expandAll(args, ctx)) {
            sb.write(_toStr(v));
          }
          return sb.toString();
        }
      case 'ROUND':
        if (args.isEmpty || args.length > 2) throw FormulaError('#ERR!', 'ROUND args');
        final x = _toNum(args[0].eval(ctx));
        final digits = args.length == 2 ? _toNum(args[1].eval(ctx)).toInt() : 0;
        final f = math.pow(10, digits);
        return ((x * f).round() / f);
      case 'ABS':
        if (args.length != 1) throw FormulaError('#ERR!', 'ABS args');
        return _toNum(args[0].eval(ctx)).abs();
      default:
        throw FormulaError('#NAME?', name);
    }
  }
}

// ────────────────────────── Parser ─────────────────────────────────────

class _Parser {
  final List<_Tok> toks;
  int i = 0;
  _Parser(this.toks);

  _Tok get cur => toks[i];
  _Tok _consume(_TT t) {
    if (cur.type != t) throw FormulaError('#ERR!', 'expected ${t.name} got ${cur.type.name}');
    return toks[i++];
  }

  _Node parse() {
    final node = _expr();
    if (cur.type != _TT.eof) throw FormulaError('#ERR!', 'trailing tokens');
    return node;
  }

  // comparison at bottom, then concat, then add, mul, pow, unary, primary
  _Node _expr() {
    var lhs = _concat();
    while (cur.type == _TT.eq ||
        cur.type == _TT.ne ||
        cur.type == _TT.lt ||
        cur.type == _TT.le ||
        cur.type == _TT.gt ||
        cur.type == _TT.ge) {
      final op = cur.type;
      i++;
      lhs = _Binary(op, lhs, _concat());
    }
    return lhs;
  }

  _Node _concat() {
    var lhs = _add();
    while (cur.type == _TT.amp) {
      i++;
      lhs = _Binary(_TT.amp, lhs, _add());
    }
    return lhs;
  }

  _Node _add() {
    var lhs = _mul();
    while (cur.type == _TT.plus || cur.type == _TT.minus) {
      final op = cur.type;
      i++;
      lhs = _Binary(op, lhs, _mul());
    }
    return lhs;
  }

  _Node _mul() {
    var lhs = _pow();
    while (cur.type == _TT.star || cur.type == _TT.slash) {
      final op = cur.type;
      i++;
      lhs = _Binary(op, lhs, _pow());
    }
    return lhs;
  }

  _Node _pow() {
    var lhs = _unary();
    if (cur.type == _TT.caret) {
      i++;
      return _Binary(_TT.caret, lhs, _pow()); // right-assoc
    }
    return lhs;
  }

  _Node _unary() {
    if (cur.type == _TT.minus) {
      i++;
      return _Unary(_TT.minus, _unary());
    }
    if (cur.type == _TT.plus) {
      i++;
      return _unary();
    }
    return _primary();
  }

  _Node _primary() {
    final t = cur;
    switch (t.type) {
      case _TT.number:
        i++;
        return _NumLit(t.literal as num);
      case _TT.string:
        i++;
        return _StrLit(t.literal as String);
      case _TT.cell:
        i++;
        return _CellRef(t.text);
      case _TT.range:
        i++;
        final parts = t.text.split(':');
        return _RangeRef(parts[0], parts[1]);
      case _TT.ident:
        final name = t.text;
        i++;
        if (t.literal is bool) return _BoolLit(t.literal as bool);
        // must be function call
        _consume(_TT.lparen);
        final args = <_Node>[];
        if (cur.type != _TT.rparen) {
          args.add(_expr());
          while (cur.type == _TT.comma) {
            i++;
            args.add(_expr());
          }
        }
        _consume(_TT.rparen);
        return _Call(name, args);
      case _TT.lparen:
        i++;
        final inner = _expr();
        _consume(_TT.rparen);
        return inner;
      default:
        throw FormulaError('#ERR!', 'unexpected ${t.type.name}');
    }
  }
}

_Node _parse(String src) => _Parser(_lex(src)).parse();

// ────────────────────────── Evaluation ctx + helpers ────────────────────

class _Ctx {
  final Object? Function(String) resolve;
  _Ctx(this.resolve);
}

num _toNum(Object? v) {
  if (v == null) return 0;
  if (v is num) return v;
  if (v is bool) return v ? 1 : 0;
  if (v is String) {
    if (v.isEmpty) return 0;
    final n = num.tryParse(v);
    if (n != null) return n;
    throw FormulaError('#VALUE!', 'not a number: "$v"');
  }
  throw FormulaError('#VALUE!');
}

String _toStr(Object? v) {
  if (v == null) return '';
  if (v is String) return v;
  if (v is num) {
    if (v is int || v == v.truncate()) return v.toInt().toString();
    return v.toString();
  }
  return v.toString();
}

bool _eq(Object? a, Object? b) {
  if (a is num && b is num) return a == b;
  if (a is bool && b is bool) return a == b;
  return _toStr(a) == _toStr(b);
}

int _cmp(Object? a, Object? b) {
  if (a is num && b is num) return a.compareTo(b);
  return _toStr(a).compareTo(_toStr(b));
}

Iterable<Object?> _expandAll(List<_Node> args, _Ctx ctx) sync* {
  for (final a in args) {
    if (a is _RangeRef) {
      yield* a.values(ctx);
    } else {
      yield a.eval(ctx);
    }
  }
}

Iterable<num> _expandNums(List<_Node> args, _Ctx ctx) sync* {
  for (final v in _expandAll(args, ctx)) {
    if (v == null || (v is String && v.isEmpty)) continue;
    yield _toNum(v);
  }
}

num _reduceNum(List<_Node> args, _Ctx ctx, num seed, num Function(num, num) fn) {
  final isSentinel = seed == double.infinity || seed == double.negativeInfinity;
  num acc = seed;
  bool first = true;
  for (final v in _expandNums(args, ctx)) {
    if (first) {
      acc = isSentinel ? v : fn(seed, v);
      first = false;
    } else {
      acc = fn(acc, v);
    }
  }
  if (first) {
    if (isSentinel) throw FormulaError('#VALUE!', 'empty range');
    return seed; // SUM 空集合 = 0
  }
  return acc;
}

// ────────────────────────── Cell address helpers ────────────────────────

class _RC {
  final int col;
  final int row;
  _RC(this.col, this.row);
}

_RC _splitAddr(String s) {
  int i = 0;
  while (i < s.length && _isLetter(s.codeUnitAt(i))) {
    i++;
  }
  if (i == 0 || i == s.length) throw FormulaError('#REF!', s);
  final colLetters = s.substring(0, i);
  final rowStr = s.substring(i);
  final row = int.tryParse(rowStr);
  if (row == null || row <= 0) throw FormulaError('#REF!', s);
  int col = 0;
  for (var j = 0; j < colLetters.length; j++) {
    col = col * 26 + (colLetters.codeUnitAt(j) - 0x40);
  }
  return _RC(col - 1, row - 1);
}

bool _isLetter(int c) => (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);

String _colLabel(int c) {
  if (c < 0) return '';
  if (c < 26) return String.fromCharCode(0x41 + c);
  return _colLabel(c ~/ 26 - 1) + String.fromCharCode(0x41 + c % 26);
}
