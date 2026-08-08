import Flutter
import UIKit
import PencilKit

public class PencilCanvasPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    let factory = PencilCanvasViewFactory(messenger: registrar.messenger())
    registrar.register(factory, withId: "oidea/pencil_canvas")
  }
}

class PencilCanvasViewFactory: NSObject, FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }

  func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
    PencilCanvasNativeView(
      frame: frame, viewId: viewId,
      args: args as? [String: Any], messenger: messenger)
  }
}

class PencilCanvasNativeView: NSObject, FlutterPlatformView, PKCanvasViewDelegate {
  private let canvasView = PKCanvasView()
  private let toolPicker = PKToolPicker()
  private let channel: FlutterMethodChannel

  init(frame: CGRect, viewId: Int64, args: [String: Any]?, messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "oidea/pencil_canvas_\(viewId)", binaryMessenger: messenger)
    super.init()

    canvasView.frame = frame
    canvasView.delegate = self
    canvasView.backgroundColor = .white
    // pencilOnly = 系統級防手掌（手指不落墨）；fingerDrawing=true 供模擬器/無筆情境
    canvasView.drawingPolicy = (args?["fingerDrawing"] as? Bool ?? false) ? .anyInput : .pencilOnly

    if let typed = args?["drawing"] as? FlutterStandardTypedData,
       let drawing = try? PKDrawing(data: typed.data) {
      canvasView.drawing = drawing
    }

    toolPicker.setVisible(true, forFirstResponder: canvasView)
    toolPicker.addObserver(canvasView)
    // becomeFirstResponder 需要 view 已進 hierarchy；下一個 runloop 再叫
    DispatchQueue.main.async { [weak self] in _ = self?.canvasView.becomeFirstResponder() }

    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(FlutterError(code: "disposed", message: "畫布已釋放", details: nil))
        return
      }
      self.handle(call, result: result)
    }
  }

  deinit {
    channel.setMethodCallHandler(nil)
    toolPicker.setVisible(false, forFirstResponder: canvasView)
    toolPicker.removeObserver(canvasView)
    canvasView.resignFirstResponder()
  }

  func view() -> UIView { canvasView }

  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    channel.invokeMethod("onDrawingChanged", arguments: nil)
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "getDrawing":
      result(FlutterStandardTypedData(bytes: canvasView.drawing.dataRepresentation()))
    case "setDrawing":
      guard let typed = call.arguments as? FlutterStandardTypedData,
            let drawing = try? PKDrawing(data: typed.data) else {
        result(FlutterError(code: "bad_drawing", message: "無法解析筆跡資料", details: nil))
        return
      }
      canvasView.drawing = drawing
      result(nil)
    case "undo":
      canvasView.undoManager?.undo()
      result(nil)
    case "redo":
      canvasView.undoManager?.redo()
      result(nil)
    case "setFingerDrawing":
      canvasView.drawingPolicy = (call.arguments as? Bool ?? false) ? .anyInput : .pencilOnly
      result(nil)
    case "renderThumbnail":
      let maxWidth = CGFloat(((call.arguments as? [String: Any])?["maxWidth"] as? NSNumber)?.doubleValue ?? 512)
      let drawingBounds = canvasView.drawing.bounds
      let bounds = drawingBounds.isEmpty
        ? CGRect(x: 0, y: 0, width: 1024, height: 768)
        : drawingBounds.insetBy(dx: -20, dy: -20)
      let scale = maxWidth / max(bounds.width, 1)
      let image = canvasView.drawing.image(from: bounds, scale: scale)
      result(FlutterStandardTypedData(bytes: image.pngData() ?? Data()))
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
