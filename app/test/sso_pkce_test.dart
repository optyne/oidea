import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:oidea/features/auth/sso/pkce.dart';
import 'package:oidea/features/auth/sso/sha256.dart';

String _hex(List<int> bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

void main() {
  group('sha256 (FIPS 180-4 vectors)', () {
    test('empty string', () {
      expect(_hex(sha256(const [])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    test('"abc" (one block)', () {
      expect(_hex(sha256(ascii.encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    test('448-bit message (padding spills into a second block)', () {
      expect(
        _hex(sha256(ascii.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      );
    });

    test('one million "a" (many blocks)', () {
      expect(
        _hex(sha256(List<int>.filled(1000000, 0x61))),
        'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
      );
    });
  });

  group('PKCE S256', () {
    test('RFC 7636 Appendix B vector', () {
      expect(
        pkceChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      );
    });

    test('second vector, cross-checked with .NET SHA256', () {
      expect(
        pkceChallengeS256('dBjftJeZ4CVP-mJ0kSnUVtw7a0BGYD-ZXyBmh5l3lfs'),
        '1pWuYd3u7RNAz5dW_WaTKrOQ_4CeK5ECAdFBKBcOA8s',
      );
    });

    test('verifier is 43 base64url chars without padding, and random', () {
      final allowed = RegExp(r'^[A-Za-z0-9_-]{43}$');
      final seen = <String>{};
      for (var i = 0; i < 20; i++) {
        final v = generatePkceVerifier();
        expect(v, matches(allowed));
        seen.add(v);
      }
      expect(seen.length, 20);
    });

    test('challenge has no padding and is deterministic for a seeded verifier', () {
      final v = generatePkceVerifier(random: Random(1));
      expect(v, generatePkceVerifier(random: Random(1)));
      final c = pkceChallengeS256(v);
      expect(c, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
      expect(c.contains('='), isFalse);
    });
  });
}
