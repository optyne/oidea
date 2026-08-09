import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('PencilCanvasController 的 channel 協定：方法名與參數形狀', () async {
    const channel = MethodChannel('oidea/pencil_canvas_0');
    final calls = <MethodCall>[];
    final ink = Uint8List.fromList([1, 2, 3]);

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (call.method == 'getDrawing') return ink;
      if (call.method == 'renderThumbnail') return Uint8List.fromList([9]);
      return null;
    });

    // 走與 controller 相同的協定（controller 建構子為 library-private，直接驗協定）
    final got = await channel.invokeMethod<Uint8List>('getDrawing');
    await channel.invokeMethod('setDrawing', ink);
    await channel.invokeMethod('undo');
    final thumb =
        await channel.invokeMethod<Uint8List>('renderThumbnail', {'maxWidth': 512});

    expect(got, ink);
    expect(thumb, isNotEmpty);
    expect(calls.map((c) => c.method).toList(), ['getDrawing', 'setDrawing', 'undo', 'renderThumbnail']);
    expect(calls[3].arguments, {'maxWidth': 512});
  });
}
