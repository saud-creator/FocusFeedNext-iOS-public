"""Structurally verify an unsigned native IPA and its source-bound test receipt.

This does not prove signed upgrade preservation, live-provider behavior, device
media recovery, energy use, or physical-device performance.
"""
import argparse
import hashlib
import json
import plistlib
import re
import struct
import zipfile
from pathlib import Path, PurePosixPath

PREFIX = 'Payload/FocusFeedNext.app/'
ENGINE_INPUTS = (
    'ios-native/NativeServices/TransportDocument.swift',
    'ios-native/NativeServices/ReaderScript.swift',
    'ios-native/NativeServices/TransportRules.swift',
    'ios-native/NativeServices/IdentityTransport.swift',
)
MACH_MAGICS = {bytes.fromhex(value) for value in (
    'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}


class VerificationError(ValueError):
    pass


def require(condition, message):
    # Never use assert: verification must remain enabled under python -O.
    if not condition:
        raise VerificationError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def is_hash(value, length=64):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{' + str(length) + '}', value) is not None


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key in provenance: ' + key)
        result[key] = value
    return result


def read_json(data):
    return json.loads(data, object_pairs_hook=no_duplicates)


def verify_macho(binary, name, main=False):
    require(len(binary) >= 32 and binary[:4] == bytes.fromhex('cffaedfe'),
            'Expected thin arm64 Mach-O: ' + name)
    _, cpu, _, filetype, count, command_bytes, _, _ = struct.unpack_from('<8I', binary)
    require(cpu == 0x100000c, 'Non-arm64 executable: ' + name)
    require(not main or filetype == 2, 'Main binary is not an executable.')
    require(count > 0 and command_bytes >= count * 8 and 32 + command_bytes <= len(binary),
            'Invalid Mach-O load command extent: ' + name)
    offset = 32
    linked = []
    platform = None
    minimum = None
    for _ in range(count):
        require(offset + 8 <= 32 + command_bytes, 'Truncated Mach-O command: ' + name)
        command, size = struct.unpack_from('<II', binary, offset)
        require(size >= 8 and size % 8 == 0 and offset + size <= 32 + command_bytes,
                'Invalid Mach-O load command: ' + name)
        require(command != 0x1d, 'Embedded code signature: ' + name)
        if command == 0x32:  # LC_BUILD_VERSION
            require(size >= 24 and platform is None, 'Invalid build version: ' + name)
            platform, minimum, _, tools = struct.unpack_from('<4I', binary, offset + 8)
            require(24 + tools * 8 <= size, 'Truncated build tools: ' + name)
        if command in {0xc, 0x80000018, 0x8000001f, 0x80000023}:  # dylib load commands
            require(size >= 24, 'Invalid dylib command: ' + name)
            name_offset = struct.unpack_from('<I', binary, offset + 8)[0]
            require(24 <= name_offset < size, 'Invalid dylib name offset: ' + name)
            encoded = binary[offset + name_offset:offset + size]
            require(b'\0' in encoded, 'Unterminated dylib name: ' + name)
            linked.append(encoded.split(b'\0', 1)[0].decode('utf-8'))
        offset += size
    require(offset == 32 + command_bytes, 'Mach-O command size mismatch: ' + name)
    require(platform == 2, 'Mach-O is not built for an iOS device: ' + name)
    require(minimum == 16 << 16 if main else minimum is not None and minimum <= 16 << 16,
            'Mach-O minimum OS is incompatible with iOS 16: ' + name)
    require(not any(re.search(r'(?:^|/)(?:lib)?(?:tauri|tao|react)(?:[._/-]|$)', item, re.I)
                    for item in linked), 'Legacy reader dependency in ' + name)
    return linked


def verify_manifest(manifest):
    require(manifest.get('schemaVersion') == 2, 'Unsupported native provenance schema.')
    require(manifest.get('reader') == 'UIKit' and manifest.get('version') == '0.10.0'
            and manifest.get('minimumOS') == '16.0' and manifest.get('signing') == 'unsigned',
            'Wrong native build contract.')
    require(is_hash(manifest.get('sourceCommit'), 40), 'Invalid source commit.')
    sources = manifest.get('sources')
    require(isinstance(sources, dict) and sources and all(is_hash(value) for value in sources.values()),
            'Missing native source hashes.')
    require(manifest.get('sourceDigest') == digest(canonical(sources)), 'Source digest does not match inputs.')
    require(manifest.get('lockSha256') == sources.get('Cargo.lock'), 'Dependency lock hash is missing or inconsistent.')
    require(all(path in sources for path in (
        'source/src-tauri/src/media_proxy.rs', 'source/src-tauri/src/durable.rs',
        'source/src-tauri/src/providers/native_parser.rs',
        'source/src-tauri/plugins/ios-reader/src/fault.rs')), 'Shared Rust source hashes are incomplete.')
    engine = manifest.get('engineSources', {})
    require(all(engine.get(path) == sources.get(path) and is_hash(engine.get(path))
                for path in ENGINE_INPUTS), 'Provider-engine source hashes are incomplete.')
    bindings = manifest.get('bindings', {})
    require(bindings.get('uniffiVersion') == '0.32.1' and bindings.get('swiftLanguageMode') == '5',
            'Unexpected Swift/UniFFI binding contract.')
    generated = bindings.get('generatedHashes', {})
    require(isinstance(generated, dict) and all(is_hash(value) for value in generated.values())
            and all(any(name.endswith(suffix) for name in generated) for suffix in ('.swift', '.h', '.modulemap')),
            'Generated binding hashes are incomplete.')
    resources = manifest.get('resources', {})
    require(isinstance(resources, dict) and resources and all(sources.get(name) == value and is_hash(value)
            for name, value in resources.items()), 'Native source resource hashes are inconsistent.')
    require(any(name.endswith('/AppIcon.png') for name in resources), 'App icon source hash is missing.')
    packages = manifest.get('rustPackages', [])
    require(isinstance(packages, list) and {'focusfeed-core', 'focusfeed-ffi', 'uniffi'}.issubset(packages)
            and not any(name.startswith('tauri') or name == 'tao' for name in packages),
            'Native dependency graph is missing or includes the old shell.')
    receipt = manifest.get('nativeTestReceipt')
    require(isinstance(receipt, dict) and receipt.get('schemaVersion') == 1
            and receipt.get('recordedBy') == 'xcresulttool', 'A successful native test receipt is required.')
    require(receipt.get('sourceCommit') == manifest['sourceCommit']
            and receipt.get('sourceDigest') == manifest['sourceDigest']
            and receipt.get('xcode') == manifest.get('xcode'), 'Native tests belong to different source or Xcode.')
    summary = receipt.get('summary', {})
    require(isinstance(summary.get('result'), str) and summary['result'].lower() == 'passed',
            'Native tests did not pass.')
    require(all(type(summary.get(key)) is int and summary[key] >= 0
                for key in ('totalTestCount', 'passedTests', 'failedTests', 'skippedTests'))
            and summary['passedTests'] > 0 and summary['totalTestCount'] > 0 and summary['failedTests'] == 0,
            'Native test counts are missing or contain failures.')
    require(is_hash(receipt.get('resultBundleSha256')) and is_hash(receipt.get('summarySha256')),
            'Native test result hashes are missing.')


def verify(ipa, expected_manifest):
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), 'Duplicate ZIP entry in IPA.')
        for name in names:
            path = PurePosixPath(name)
            require('\\' not in name and not path.is_absolute() and '..' not in path.parts,
                    'Unsafe ZIP path in IPA.')
            require(name in {'Payload/', PREFIX} or name.startswith(PREFIX), 'Unexpected application or payload in IPA.')
            parts = {part.lower() for part in path.parts}
            require('_codesignature' not in parts and not name.lower().endswith('.mobileprovision'),
                    'Unsigned IPA contains signing material.')
            require(not parts.intersection({'assets', 'www', 'node_modules', 'react', 'tauri', 'tao', 'fixtures', 'tests'})
                    and path.suffix.lower() not in {'.html', '.htm', '.js', '.jsx', '.tsx', '.wasm'},
                    'Web reader or test resources entered the native app.')
            require(not re.search(r'(?:^|/)(?:lib)?(?:tauri|tao|react)(?:[._/-]|$)', name, re.I),
                    'Legacy reader library entered the native app.')
        require(archive.testzip() is None, 'IPA CRC failed.')
        info = plistlib.loads(archive.read(PREFIX + 'Info.plist'))
        require(info.get('CFBundleIdentifier') == 'com.focusfeed.next', 'Bundle identity changed.')
        require(info.get('CFBundleShortVersionString') == '0.10.0', 'Wrong release version.')
        require(info.get('MinimumOSVersion') == '16.0', 'Minimum OS changed.')
        require(info.get('CFBundleSupportedPlatforms') == ['iPhoneOS'], 'Not an iOS device archive.')
        require(isinstance(info.get('CFBundleVersion'), str) and re.fullmatch(r'\d+(?:\.\d+){0,2}', info['CFBundleVersion'])
                and int(info['CFBundleVersion'].split('.')[0]) > 31, 'Build must increase over installed build 31.')
        ats = info.get('NSAppTransportSecurity', {})
        require(not any(ats.get(key, False) for key in ('NSAllowsArbitraryLoads', 'NSAllowsArbitraryLoadsInWebContent',
                    'NSAllowsArbitraryLoadsForMedia')), 'Unrestricted transport exception.')
        exceptions = ats.get('NSExceptionDomains', {})
        require(set(exceptions) == {'127.0.0.1'}, 'Transport exception must be loopback-only.')
        loopback = exceptions['127.0.0.1']
        require(loopback.get('NSExceptionAllowsInsecureHTTPLoads') is True
                and not loopback.get('NSIncludesSubdomains', False), 'Invalid loopback allowance.')
        scenes = info['UIApplicationSceneManifest']['UISceneConfigurations']['UIWindowSceneSessionRoleApplication']
        require(len(scenes) == 1 and scenes[0].get('UISceneDelegateClassName', '').endswith('.NativeSceneDelegate'),
                'Native scene configuration is missing.')
        executable = info.get('CFBundleExecutable', '')
        require(executable and '/' not in executable and '\\' not in executable, 'Invalid executable name.')
        main_binary = PREFIX + executable
        require(PREFIX + 'Assets.car' in names and archive.getinfo(PREFIX + 'Assets.car').file_size > 0,
                'Compiled native asset catalog is missing.')
        linked = verify_macho(archive.read(main_binary), executable, main=True)
        require(all(any('/' + framework + '.framework/' in item for item in linked)
                    for framework in ('UIKit', 'WebKit', 'AVKit')), 'Required native modules are not linked.')
        manifest = read_json(archive.read(PREFIX + 'BuildProvenance.json'))
        require(manifest == expected_manifest, 'Embedded manifest differs from the build manifest.')
        verify_manifest(manifest)
        binaries = {main_binary: digest(archive.read(main_binary))}
        resources = {}
        for name in names:
            if name.endswith('/') or name == main_binary:
                continue
            data = archive.read(name)
            if data[:4] in MACH_MAGICS:
                verify_macho(data, name)
                binaries[name] = digest(data)
            else:
                resources[name.removeprefix(PREFIX)] = digest(data)
    return {
        'schemaVersion': 2, 'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
        'bundleID': info['CFBundleIdentifier'], 'architecture': 'arm64', 'minimumOS': '16.0',
        'archiveCRC': 'passed', 'sourceCommit': manifest['sourceCommit'], 'sourceDigest': manifest['sourceDigest'],
        'reader': 'UIKit', 'signatures': 0, 'provisioningProfiles': 0,
        'sha256': digest(ipa.read_bytes()), 'binaryHashes': binaries, 'resourceHashes': resources,
        'nativeSimulatorTests': manifest['nativeTestReceipt'],
        'physicalDeviceAcceptance': 'not performed by archive verifier',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa', type=Path)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        report = verify(args.ipa, read_json(args.manifest.read_text()))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    except (ValueError, KeyError, TypeError, IndexError, UnicodeError, OSError, struct.error, zipfile.BadZipFile) as error:
        parser.exit(1, f'Native IPA verification failed: {error}\n')


if __name__ == '__main__':
    main()
