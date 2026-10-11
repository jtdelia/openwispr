// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OpenWisprModels",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "openwispr-models",
            path: "Sources/OpenWisprModels",
            linkerSettings: [
                // Embeds Info.plist so the process has a stable identity and a Speech Recognition usage string.
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.plist"]),
            ]
        ),
    ]
)
