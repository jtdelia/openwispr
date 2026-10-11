import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

var lastFrontmostBundleId: String?

func sendAppInfoIfChanged() {
    let info = Accessibility.appInfo()
    let bundleId = info["bundleId"] as? String
    guard bundleId != lastFrontmostBundleId else { return }
    lastFrontmostBundleId = bundleId
    IPC.send(["type": "appInfo", "info": info])
}

NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { _ in sendAppInfoIfChanged() }

func handle(_ message: [String: Any]) {
    let id = message["id"]
    switch message["type"] as? String {
    case "setShortcuts":
        KeyTap.shared.setShortcuts(message["combos"] as? [[Int]] ?? [])
        IPC.respond(id: id, result: [:])
    case "startKeyTap":
        IPC.respond(id: id, result: ["running": KeyTap.shared.start()])
    case "getAccessibilityStatus":
        let trusted = Accessibility.isTrusted(prompt: message["prompt"] as? Bool ?? false)
        if trusted { KeyTap.shared.start() }
        IPC.respond(id: id, result: ["trusted": trusted, "keyTapRunning": KeyTap.shared.isRunning])
    case "getTextBoxInfo":
        IPC.respond(id: id, result: Accessibility.textBoxInfo())
    case "getAppInfo":
        IPC.respond(id: id, result: Accessibility.appInfo())
    case "startSpeakerPolling":
        SpeakerPoller.shared.start(markers: TileMarkers(
            speakingClasses: Set(message["speakingClasses"] as? [String] ?? []),
            selfLabels: Set(message["selfLabels"] as? [String] ?? [])
        ))
        IPC.respond(id: id, result: [:])
    case "stopSpeakerPolling":
        SpeakerPoller.shared.stop()
        IPC.respond(id: id, result: [:])
    case "paste":
        let start = Date()
        let success = Paster.paste(
            message["text"] as? String ?? "",
            restoreClipboard: message["restoreClipboard"] as? Bool ?? true
        )
        IPC.respond(id: id, result: ["success": success, "timeElapsedMs": Date().timeIntervalSince(start) * 1000])
    case let other:
        IPC.respondError(id: id, message: "unknown message type \(other ?? "nil")")
    }
}

IPC.startReading(handle)

let trusted = Accessibility.isTrusted(prompt: false)
if trusted { KeyTap.shared.start() }
IPC.send(["type": "ready", "trusted": trusted, "keyTapRunning": KeyTap.shared.isRunning])
sendAppInfoIfChanged()

app.run()
