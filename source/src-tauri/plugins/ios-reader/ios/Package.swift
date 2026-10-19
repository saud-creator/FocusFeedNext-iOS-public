// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "tauri-plugin-ios-reader",
    platforms: [.iOS(.v16)],
    products: [.library(name: "tauri-plugin-ios-reader", type: .static, targets: ["IosReader"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "IosReader", dependencies: [.byName(name: "Tauri")], path: "Sources", exclude: ["Reader.js"])]
)
