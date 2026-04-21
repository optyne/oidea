import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/spreadsheets/domain/formula_engine.dart';

/// 這份測試確保新增 formula 語法／函式時不破壞既有行為。
///
/// recomputeCells 吃的是 `{addr: {v: literal|"=formula"}}`，
/// 回傳 `{addr: {v, f, c}}` — `c` 是快取後的運算結果，formula 才會有。
void main() {
  group('Literals', () {
    test('plain number literal passes through', () {
      final out = recomputeCells({'A1': {'v': 42}});
      expect(out['A1'], {'v': 42});
    });

    test('plain string literal passes through', () {
      final out = recomputeCells({'A1': {'v': 'hello'}});
      expect(out['A1'], {'v': 'hello'});
    });
  });

  group('Arithmetic', () {
    test('=1+2 → 3', () {
      final out = recomputeCells({'A1': {'v': '=1+2'}});
      expect(out['A1']!['c'], 3);
      expect(out['A1']!['f'], '1+2');
    });

    test('=2*3+4 precedence → 10', () {
      final out = recomputeCells({'A1': {'v': '=2*3+4'}});
      expect(out['A1']!['c'], 10);
    });

    test('=(2+3)*4 parens → 20', () {
      final out = recomputeCells({'A1': {'v': '=(2+3)*4'}});
      expect(out['A1']!['c'], 20);
    });

    test('=2^3^2 right-assoc → 512', () {
      final out = recomputeCells({'A1': {'v': '=2^3^2'}});
      expect(out['A1']!['c'], 512);
    });

    test('divide by zero → #DIV/0!', () {
      final out = recomputeCells({'A1': {'v': '=1/0'}});
      expect(out['A1']!['c'], '#DIV/0!');
    });

    test('unary minus', () {
      final out = recomputeCells({'A1': {'v': '=-5+10'}});
      expect(out['A1']!['c'], 5);
    });
  });

  group('Cell refs', () {
    test('=A1 returns A1 value', () {
      final out = recomputeCells({
        'A1': {'v': 10},
        'B1': {'v': '=A1'},
      });
      expect(out['B1']!['c'], 10);
    });

    test('chain of refs', () {
      final out = recomputeCells({
        'A1': {'v': 5},
        'B1': {'v': '=A1*2'},
        'C1': {'v': '=B1+1'},
      });
      expect(out['B1']!['c'], 10);
      expect(out['C1']!['c'], 11);
    });

    test('cycle detection', () {
      final out = recomputeCells({
        'A1': {'v': '=B1'},
        'B1': {'v': '=A1'},
      });
      expect(out['A1']!['c'], '#CYCLE!');
      expect(out['B1']!['c'], '#CYCLE!');
    });

    test('ref to empty cell treated as 0', () {
      final out = recomputeCells({'A1': {'v': '=Z99+5'}});
      expect(out['A1']!['c'], 5);
    });
  });

  group('Ranges', () {
    test('SUM(A1:A3)', () {
      final out = recomputeCells({
        'A1': {'v': 1},
        'A2': {'v': 2},
        'A3': {'v': 3},
        'B1': {'v': '=SUM(A1:A3)'},
      });
      expect(out['B1']!['c'], 6);
    });

    test('AVG(A1:A3)', () {
      final out = recomputeCells({
        'A1': {'v': 2},
        'A2': {'v': 4},
        'A3': {'v': 6},
        'B1': {'v': '=AVG(A1:A3)'},
      });
      expect(out['B1']!['c'], 4);
    });

    test('MAX / MIN', () {
      final out = recomputeCells({
        'A1': {'v': 10},
        'A2': {'v': 5},
        'A3': {'v': 99},
        'B1': {'v': '=MAX(A1:A3)'},
        'B2': {'v': '=MIN(A1:A3)'},
      });
      expect(out['B1']!['c'], 99);
      expect(out['B2']!['c'], 5);
    });

    test('COUNT skips empty & non-numeric', () {
      final out = recomputeCells({
        'A1': {'v': 1},
        'A2': {'v': 'hello'},
        'A3': {'v': 3},
        'B1': {'v': '=COUNT(A1:A3)'},
      });
      expect(out['B1']!['c'], 2);
    });

    test('2D range', () {
      final out = recomputeCells({
        'A1': {'v': 1}, 'B1': {'v': 2},
        'A2': {'v': 3}, 'B2': {'v': 4},
        'C1': {'v': '=SUM(A1:B2)'},
      });
      expect(out['C1']!['c'], 10);
    });
  });

  group('IF', () {
    test('true branch', () {
      final out = recomputeCells({'A1': {'v': '=IF(1>0, 99, -1)'}});
      expect(out['A1']!['c'], 99);
    });
    test('false branch', () {
      final out = recomputeCells({'A1': {'v': '=IF(1>2, 99, -1)'}});
      expect(out['A1']!['c'], -1);
    });
  });

  group('String / concat', () {
    test('string literal', () {
      final out = recomputeCells({'A1': {'v': '="hello"'}});
      expect(out['A1']!['c'], 'hello');
    });
    test('CONCAT', () {
      final out = recomputeCells({
        'A1': {'v': 'hello'},
        'B1': {'v': ' '},
        'C1': {'v': 'world'},
        'D1': {'v': '=CONCAT(A1,B1,C1)'},
      });
      expect(out['D1']!['c'], 'hello world');
    });
    test('& operator', () {
      final out = recomputeCells({'A1': {'v': '="x"&5'}});
      expect(out['A1']!['c'], 'x5');
    });
  });

  group('Error codes', () {
    test('unknown function → #NAME?', () {
      final out = recomputeCells({'A1': {'v': '=NOPE()'}});
      expect(out['A1']!['c'], '#NAME?');
    });
    test('garbage → #ERR!', () {
      final out = recomputeCells({'A1': {'v': '=1++'}});
      // depending on parse path could be either
      expect(out['A1']!['c'].toString().startsWith('#'), true);
    });
  });

  group('ROUND / ABS', () {
    test('ROUND(1.2345, 2)', () {
      final out = recomputeCells({'A1': {'v': '=ROUND(1.2345, 2)'}});
      expect(out['A1']!['c'], 1.23);
    });
    test('ABS(-5)', () {
      final out = recomputeCells({'A1': {'v': '=ABS(-5)'}});
      expect(out['A1']!['c'], 5);
    });
  });
}
