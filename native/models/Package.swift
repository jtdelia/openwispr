// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OpenWisprModels",
    platforms: [.macOS("26.0")],
    dependencies: [
        // No traits: skips the NeMo text-normalization binary, which only FluidAudio's text-to-speech uses.
        .package(url: "https://github.com/FluidInference/FluidAudio", exact: "0.17.7", traits: []),
    ],
    targets: [
        .executableTarget(
            name: "openwispr-models",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/OpenWisprModels",
            linkerSettings: [
                // Embeds Info.plist so the process has a stable identity and a Speech Recognition usage string.
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.plist"]),
            ]
        ),
    ]
)
