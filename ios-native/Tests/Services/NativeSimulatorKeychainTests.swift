#if targetEnvironment(simulator)
import Security
import XCTest

/// The hosted test exercises the entitlement on the actual native app.
final class NativeSimulatorKeychainTests: XCTestCase {
    func testHostedSimulatorAppCanReadAndWriteItsKeychainGroup() {
        let group = "SIMULATOR0.com.focusfeed.next"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccessGroup as String: group,
            kSecAttrService as String: "com.focusfeed.next.tests.simulator-keychain",
            kSecAttrAccount as String: UUID().uuidString,
        ]
        let fixture = Data("keychain-fixture".utf8)
        var entry = query
        entry[kSecValueData as String] = fixture
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(entry as CFDictionary, nil)
        XCTAssertEqual(status, errSecSuccess, "The simulator host must claim its test Keychain access group.")
        guard status == errSecSuccess else { return }
        defer { XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess) }

        var read = query
        read[kSecReturnData as String] = true
        read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, fixture)
    }
}
#endif
