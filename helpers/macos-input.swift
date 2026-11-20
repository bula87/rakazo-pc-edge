import Cocoa
import Foundation

/// Minimal macOS input helper for rakazo-pc-edge (compile once with swiftc).
/// Usage:
///   macos-input size
///   macos-input move <x> <y>
///   macos-input click [left|right|double] [x y]
///   macos-input down|up [left|right]
///   macos-input drag <x1> <y1> <x2> <y2> [left|right]
///   macos-input scroll <dy> [dx]
///   macos-input type <text...>
///   macos-input key <name> [down|up|tap]

func screenSize() -> (Int, Int) {
  let r = CGDisplayBounds(CGMainDisplayID())
  return (Int(r.width), Int(r.height))
}

func clampPoint(_ x: Double, _ y: Double) -> CGPoint {
  let (w, h) = screenSize()
  let cx = min(max(x, 0), Double(w - 1))
  let cy = min(max(y, 0), Double(h - 1))
  return CGPoint(x: cx, y: cy)
}

func postMouse(_ type: CGEventType, _ pos: CGPoint, button: CGMouseButton = .left, clickCount: Int64 = 1) {
  let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: pos, mouseButton: button)
  event?.setIntegerValueField(.mouseEventClickState, value: clickCount)
  event?.post(tap: .cghidEventTap)
}

func moveTo(_ x: Double, _ y: Double) {
  let p = clampPoint(x, y)
  postMouse(.mouseMoved, p)
}

func click(_ button: String, x: Double?, y: Double?, double: Bool) {
  let pos: CGPoint
  if let x, let y {
    pos = clampPoint(x, y)
    postMouse(.mouseMoved, pos)
  } else {
    // Current location via associated event
    let ev = CGEvent(source: nil)
    pos = ev?.location ?? .zero
  }
  let btn: CGMouseButton = button == "right" ? .right : .left
  let down: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
  let count: Int64 = double ? 2 : 1
  postMouse(down, pos, button: btn, clickCount: count)
  if double {
    postMouse(up, pos, button: btn, clickCount: 1)
    postMouse(down, pos, button: btn, clickCount: 2)
    postMouse(up, pos, button: btn, clickCount: 2)
  } else {
    postMouse(up, pos, button: btn, clickCount: count)
  }
}

func mouseButton(_ button: String, down: Bool) {
  let ev = CGEvent(source: nil)
  let pos = ev?.location ?? .zero
  let btn: CGMouseButton = button == "right" ? .right : .left
  let type: CGEventType
  if button == "right" {
    type = down ? .rightMouseDown : .rightMouseUp
  } else {
    type = down ? .leftMouseDown : .leftMouseUp
  }
  postMouse(type, pos, button: btn)
}

func drag(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, button: String) {
  let start = clampPoint(x1, y1)
  let end = clampPoint(x2, y2)
  let btn: CGMouseButton = button == "right" ? .right : .left
  let down: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
  let dragType: CGEventType = button == "right" ? .rightMouseDragged : .leftMouseDragged
  let up: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
  postMouse(.mouseMoved, start, button: btn)
  postMouse(down, start, button: btn)
  postMouse(dragType, end, button: btn)
  postMouse(up, end, button: btn)
}

func scroll(dy: Int32, dx: Int32) {
  let ev = CGEvent(source: nil)
  let pos = ev?.location ?? .zero
  let event = CGEvent(
    scrollWheelEvent2Source: nil,
    units: .line,
    wheelCount: 2,
    wheel1: dy,
    wheel2: dx,
    wheel3: 0
  )
  event?.location = pos
  event?.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
  let src = CGEventSource(stateID: .hidSystemState)
  for ch in text.utf16 {
    var chars = [UniChar(ch)]
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &chars)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }
}

let keyMap: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
  "delete": 51, "backspace": 51, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "cmd": 55, "command": 55, "shift": 56, "option": 58, "alt": 58, "control": 59, "ctrl": 59,
  "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40,
  "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32,
  "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
]

func keyEvent(_ name: String, mode: String) {
  guard let code = keyMap[name.lowercased()] else {
    fputs("unknown key: \(name)\n", stderr)
    exit(2)
  }
  let src = CGEventSource(stateID: .hidSystemState)
  if mode == "down" || mode == "tap" {
    CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
  }
  if mode == "up" || mode == "tap" {
    CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
  }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else {
  fputs("usage: macos-input <size|move|click|down|up|drag|scroll|type|key> ...\n", stderr)
  exit(2)
}

switch cmd {
case "size":
  let (w, h) = screenSize()
  print("\(w) \(h)")
case "move":
  guard args.count >= 3, let x = Double(args[1]), let y = Double(args[2]) else { exit(2) }
  moveTo(x, y)
case "click":
  var button = "left"
  var double = false
  var coords: (Double, Double)? = nil
  var i = 1
  while i < args.count {
    let a = args[i]
    if a == "left" || a == "right" { button = a; i += 1 }
    else if a == "double" { double = true; i += 1 }
    else if let x = Double(a), i + 1 < args.count, let y = Double(args[i + 1]) {
      coords = (x, y); i += 2
    } else { exit(2) }
  }
  click(button, x: coords?.0, y: coords?.1, double: double)
case "down":
  mouseButton(args.count > 1 ? args[1] : "left", down: true)
case "up":
  mouseButton(args.count > 1 ? args[1] : "left", down: false)
case "drag":
  guard args.count >= 5,
        let x1 = Double(args[1]), let y1 = Double(args[2]),
        let x2 = Double(args[3]), let y2 = Double(args[4]) else { exit(2) }
  let button = args.count > 5 ? args[5] : "left"
  drag(x1, y1, x2, y2, button: button)
case "scroll":
  guard args.count >= 2, let dy = Int32(args[1]) else { exit(2) }
  let dx = args.count > 2 ? (Int32(args[2]) ?? 0) : 0
  scroll(dy: dy, dx: dx)
case "type":
  let text = args.dropFirst().joined(separator: " ")
  typeText(text)
case "key":
  guard args.count >= 2 else { exit(2) }
  let mode = args.count > 2 ? args[2] : "tap"
  keyEvent(args[1], mode: mode)
default:
  fputs("unknown command\n", stderr)
  exit(2)
}
