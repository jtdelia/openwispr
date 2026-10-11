import AppKit
import ApplicationServices

enum Accessibility {
    static func isTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func frontmostAppElement() -> (NSRunningApplication, AXUIElement)? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        // Chromium and Electron apps only build their AX tree when asked to.
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        return (app, element)
    }

    static func appInfo() -> [String: Any] {
        guard let (app, element) = frontmostAppElement() else {
            return ["appName": "", "bundleId": "", "windowTitle": ""]
        }
        var title = ""
        if let windowRef = attribute(element, kAXFocusedWindowAttribute),
           CFGetTypeID(windowRef) == AXUIElementGetTypeID(),
           let value = attribute(windowRef as! AXUIElement, kAXTitleAttribute) as? String {
            title = value
        }
        return [
            "appName": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "",
            "windowTitle": title,
        ]
    }

    static func textBoxInfo() -> [String: Any] {
        var result: [String: Any] = [
            "accessibilityIsFunctioning": isTrusted(prompt: false),
            "couldNotGetTextBoxInfo": true,
            "isEditable": false,
            "contents": "",
            "beforeText": "",
            "afterText": "",
            "selectedText": "",
        ]
        _ = frontmostAppElement()
        let system = AXUIElementCreateSystemWide()
        guard let focusedRef = attribute(system, kAXFocusedUIElementAttribute),
              CFGetTypeID(focusedRef) == AXUIElementGetTypeID()
        else { return result }
        let focused = focusedRef as! AXUIElement

        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(focused, kAXValueAttribute as CFString, &settable)
        let role = attribute(focused, kAXRoleAttribute) as? String ?? ""
        let editableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
        result["isEditable"] = settable.boolValue || editableRoles.contains(role)

        guard let contents = attribute(focused, kAXValueAttribute) as? String else { return result }
        result["couldNotGetTextBoxInfo"] = false
        result["contents"] = contents
        result["selectedText"] = attribute(focused, kAXSelectedTextAttribute) as? String ?? ""

        if let rangeRef = attribute(focused, kAXSelectedTextRangeAttribute),
           CFGetTypeID(rangeRef) == AXValueGetTypeID() {
            var range = CFRange()
            if AXValueGetValue(rangeRef as! AXValue, .cfRange, &range) {
                let text = contents as NSString
                let start = max(0, min(range.location, text.length))
                let end = max(start, min(range.location + range.length, text.length))
                result["beforeText"] = text.substring(to: start)
                result["afterText"] = text.substring(from: end)
            }
        }
        return result
    }
}
