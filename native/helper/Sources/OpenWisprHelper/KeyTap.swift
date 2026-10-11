import AppKit
import CoreGraphics

/// Global keyboard tap. Streams every key transition to the app and swallows a non-modifier key
/// only when, together with the held modifiers, it exactly completes a registered shortcut.
final class KeyTap {
    static let shared = KeyTap()

    private var tap: CFMachPort?
    private var heldModifiers = Set<Int>()
    private var swallowedKeyUps = Set<Int>()
    private var shortcuts: [Set<Int>] = []

    /// Device-dependent modifier masks from IOKit's NX_DEVICE*KEYMASK, keyed by virtual key code.
    private static let modifierMasks: [Int: UInt64] = [
        55: 0x0000_0008, // left command
        54: 0x0000_0010, // right command
        56: 0x0000_0002, // left shift
        60: 0x0000_0004, // right shift
        58: 0x0000_0020, // left option
        61: 0x0000_0040, // right option
        59: 0x0000_0001, // left control
        62: 0x0000_2000, // right control
        63: CGEventFlags.maskSecondaryFn.rawValue,
        57: CGEventFlags.maskAlphaShift.rawValue,
    ]

    var isRunning: Bool { tap != nil }

    func setShortcuts(_ combos: [[Int]]) {
        shortcuts = combos.map(Set.init)
    }

    @discardableResult
    func start() -> Bool {
        if tap != nil { return true }
        let mask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue) |
            (1 << CGEventType.flagsChanged.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, _ in
            KeyTap.shared.handle(type: type, event: event)
        }

        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: nil
        ) else {
            IPC.log("CGEvent.tapCreate failed; Accessibility/Input Monitoring permission is likely missing")
            return false
        }
        tap = port
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            heldModifiers.removeAll()
            IPC.send(["type": "tapReset"])
            return Unmanaged.passUnretained(event)
        case .flagsChanged:
            let keycode = Int(event.getIntegerValueField(.keyboardEventKeycode))
            guard let mask = Self.modifierMasks[keycode] else { return Unmanaged.passUnretained(event) }
            let down = event.flags.rawValue & mask != 0
            if down { heldModifiers.insert(keycode) } else { heldModifiers.remove(keycode) }
            IPC.send(["type": "key", "keycode": keycode, "down": down])
            return Unmanaged.passUnretained(event)
        case .keyDown, .keyUp:
            let keycode = Int(event.getIntegerValueField(.keyboardEventKeycode))
            let isDown = type == .keyDown
            let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            if !isRepeat {
                IPC.send(["type": "key", "keycode": keycode, "down": isDown])
            }
            if isDown {
                if shortcuts.contains(heldModifiers.union([keycode])) {
                    swallowedKeyUps.insert(keycode)
                    return nil
                }
                if swallowedKeyUps.contains(keycode) { return nil }
            } else if swallowedKeyUps.remove(keycode) != nil {
                return nil
            }
            return Unmanaged.passUnretained(event)
        default:
            return Unmanaged.passUnretained(event)
        }
    }
}
