// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OpenWisprHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "openwispr-helper",
            path: "Sources/OpenWisprHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Carbon"),
            ]
        ),
    ]
)
