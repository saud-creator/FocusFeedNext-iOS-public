"""Structural package fixtures, not executable IPAs or device acceptance tests."""
import copy
import hashlib
import importlib.util
import json
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provenance = load_tool('write-provenance')
verifier = load_tool('verify-native-ipa')


def macho(platform=2, signature=False, minimum=16 << 16, cpu=0x100000c, linked=None):
    commands = [struct.pack('<6I', 0x32, 24, platform, minimum, 26 << 16, 0)]
    for name in linked if linked is not None else ('UIKit', 'WebKit', 'AVKit'):
        value = (name if name.startswith('/') else '/System/Library/Frameworks/' + name + '.framework/' + name).encode() + b'\0'
        size = (24 + len(value) + 7) // 8 * 8
        commands.append(struct.pack('<6I', 0xc, size, 24, 0, 0, 0) + value + b'\0' * (size - 24 - len(value)))
    if signature:
        commands.append(struct.pack('<4I', 0x1d, 16, 0, 0))
    payload = b''.join(commands)
    return struct.pack('<8I', 0xfeedfacf, cpu, 0, 2, len(commands), len(payload), 0, 0) + payload


def manifest_fixture():
    paths = provenance.ENGINE_INPUTS + (
        'Cargo.lock', 'source/src-tauri/src/media_proxy.rs', 'source/src-tauri/src/durable.rs',
        'source/src-tauri/src/providers/native_parser.rs', 'source/src-tauri/plugins/ios-reader/src/fault.rs',
        'ios-native/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png')
    sources = {name: 'a' * 64 for name in paths}
    manifest = {
        'schemaVersion': 2, 'sourceCommit': 'a' * 40, 'reader': 'UIKit', 'version': '0.10.0',
        'minimumOS': '16.0', 'signing': 'unsigned', 'xcode': 'Xcode fixture',
        'sources': sources, 'sourceDigest': provenance.digest(provenance.canonical(sources)),
        'lockSha256': sources['Cargo.lock'], 'rustPackages': ['focusfeed-core', 'focusfeed-ffi', 'uniffi'],
        'engineSources': {name: sources[name] for name in provenance.ENGINE_INPUTS},
        'resources': {name: sha for name, sha in sources.items() if name.startswith('ios-native/Resources/')},
        'bindings': {'uniffiVersion': '0.32.1', 'swiftLanguageMode': '5', 'generatedHashes': {
            'ios-native/Generated/FocusFeedNative.swift': 'b' * 64,
            'ios-native/Generated/FocusFeedNativeFFI.h': 'c' * 64,
            'ios-native/Generated/FocusFeedNativeFFI.modulemap': 'd' * 64}},
    }
    manifest['nativeTestReceipt'] = {
        'schemaVersion': 1, 'recordedBy': 'xcresulttool', 'sourceCommit': manifest['sourceCommit'],
        'sourceDigest': manifest['sourceDigest'], 'xcode': manifest['xcode'],
        'resultBundleSha256': 'b' * 64, 'summarySha256': 'c' * 64,
        'summary': {'result': 'Passed', 'totalTestCount': 3, 'passedTests': 3, 'failedTests': 0, 'skippedTests': 0}}
    return manifest


class NativeVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = manifest_fixture()
        self.info = {'CFBundleIdentifier': 'com.focusfeed.next', 'CFBundleShortVersionString': '0.10.0',
                     'CFBundleVersion': '100.1', 'MinimumOSVersion': '16.0', 'CFBundleExecutable': 'FocusFeedNext',
                     'CFBundleSupportedPlatforms': ['iPhoneOS'],
                     'NSAppTransportSecurity': {'NSExceptionDomains': {'127.0.0.1': {'NSExceptionAllowsInsecureHTTPLoads': True}}},
                     'UIApplicationSceneManifest': {'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [{'UISceneDelegateClassName': 'App.NativeSceneDelegate'}]}}}

    def check_archive(self, info=None, binary=None, extra=None, manifest=None, expected_manifest=None,
                      assets=True, optimized=False, duplicate=False):
        manifest = self.manifest if manifest is None else manifest
        (self.root / 'manifest.json').write_text(json.dumps(manifest if expected_manifest is None else expected_manifest))
        archive_path = self.root / 'structure-only.ipa'
        with zipfile.ZipFile(archive_path, 'w') as archive:
            prefix = 'Payload/FocusFeedNext.app/'
            archive.writestr(prefix + 'Info.plist', plistlib.dumps(self.info if info is None else info))
            archive.writestr(prefix + 'FocusFeedNext', macho() if binary is None else binary)
            archive.writestr(prefix + 'BuildProvenance.json', json.dumps(manifest))
            if assets:
                archive.writestr(prefix + 'Assets.car', b'structural fixture asset catalog')
            for name, data in (extra or {}).items():
                archive.writestr(prefix + name, data)
            if duplicate:
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', UserWarning)
                    archive.writestr(prefix + 'FocusFeedNext', macho())
        command = [sys.executable] + (['-O'] if optimized else [])
        return subprocess.run(command + [str(Path(__file__).with_name('verify-native-ipa.py')),
                              str(archive_path), '--manifest', str(self.root / 'manifest.json'),
                              '--output', str(self.root / 'report.json')], capture_output=True, text=True)

    def test_matching_native_structure_passes_and_records_boundary(self):
        result = self.check_archive()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / 'report.json').read_text())
        self.assertEqual(report['signatures'], 0)
        self.assertIn('Assets.car', report['resourceHashes'])
        self.assertEqual(report['nativeSimulatorTests']['summary']['passedTests'], 3)
        self.assertEqual(report['physicalDeviceAcceptance'], 'not performed by archive verifier')

    def test_main_simulator_signature_and_wrong_architecture_are_rejected(self):
        for binary in (macho(platform=7), macho(signature=True), macho(cpu=0x1000007), b'not a binary'):
            self.assertNotEqual(self.check_archive(binary=binary).returncode, 0)

    def test_nested_macho_is_checked_for_platform_signatures_and_modules(self):
        for binary in (macho(platform=7), macho(signature=True), macho(linked=['/usr/lib/libtauri.dylib'])):
            self.assertNotEqual(self.check_archive(extra={'Frameworks/Bad.framework/Bad': binary}).returncode, 0)
        result = self.check_archive(extra={'Frameworks/Helper.framework/Helper': macho(minimum=15 << 16)})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_load_command_extents_and_unlinked_native_modules_are_rejected(self):
        binary = bytearray(macho()); struct.pack_into('<I', binary, 20, len(binary) * 2)
        self.assertNotEqual(self.check_archive(binary=binary).returncode, 0)
        binary = bytearray(macho()); struct.pack_into('<I', binary, 32 + 24 + 8, 4)
        self.assertNotEqual(self.check_archive(binary=binary).returncode, 0)
        self.assertNotEqual(self.check_archive(binary=macho(linked=['UIKit', 'WebKit'])).returncode, 0)

    def test_identity_os_build_and_scene_are_verified(self):
        for key, value in [('CFBundleIdentifier', 'other.app'), ('MinimumOSVersion', '15.0'),
                           ('CFBundleSupportedPlatforms', ['iPhoneSimulator']), ('CFBundleVersion', '31')]:
            info = copy.deepcopy(self.info); info[key] = value
            self.assertNotEqual(self.check_archive(info=info).returncode, 0)
        info = copy.deepcopy(self.info)
        info['UIApplicationSceneManifest']['UISceneConfigurations']['UIWindowSceneSessionRoleApplication'][0]['UISceneDelegateClassName'] = 'OldWebScene'
        self.assertNotEqual(self.check_archive(info=info).returncode, 0)

    def test_all_broad_transport_flags_and_domains_are_rejected(self):
        for key in ('NSAllowsArbitraryLoads', 'NSAllowsArbitraryLoadsForMedia', 'NSAllowsArbitraryLoadsInWebContent'):
            info = copy.deepcopy(self.info); info['NSAppTransportSecurity'][key] = True
            self.assertNotEqual(self.check_archive(info=info).returncode, 0)
        info = copy.deepcopy(self.info); info['NSAppTransportSecurity']['NSExceptionDomains']['example.com'] = {}
        self.assertNotEqual(self.check_archive(info=info).returncode, 0)
        info = copy.deepcopy(self.info); info['NSAppTransportSecurity']['NSExceptionDomains']['127.0.0.1']['NSIncludesSubdomains'] = True
        self.assertNotEqual(self.check_archive(info=info).returncode, 0)

    def test_reader_test_resources_signing_and_unsafe_paths_are_rejected(self):
        for path in ('assets/reader.js', 'index.html', 'reader.js', '_CodeSignature/CodeResources',
                     'embedded.mobileprovision', 'Tests/private.fixture', '../other.app/file', 'libtao.dylib'):
            self.assertNotEqual(self.check_archive(extra={path: b'fixture'}).returncode, 0, path)
        self.assertNotEqual(self.check_archive(duplicate=True).returncode, 0)

    def test_missing_assets_engine_or_shared_source_hashes_are_rejected(self):
        self.assertNotEqual(self.check_archive(assets=False).returncode, 0)
        for key in ('engineSources', 'resources', 'sources'):
            manifest = copy.deepcopy(self.manifest); manifest[key] = {}
            self.assertNotEqual(self.check_archive(manifest=manifest).returncode, 0)
        manifest = copy.deepcopy(self.manifest); manifest['sourceDigest'] = 'f' * 64
        self.assertNotEqual(self.check_archive(manifest=manifest).returncode, 0)

    def test_binding_version_and_native_dependency_graph_are_checked(self):
        for version in ('0.32.0', '0.33.0'):
            manifest = copy.deepcopy(self.manifest); manifest['bindings']['uniffiVersion'] = version
            self.assertNotEqual(self.check_archive(manifest=manifest).returncode, 0)
        manifest = copy.deepcopy(self.manifest); manifest['rustPackages'].append('tauri-runtime')
        self.assertNotEqual(self.check_archive(manifest=manifest).returncode, 0)
        manifest = copy.deepcopy(self.manifest); manifest['bindings']['generatedHashes'] = {}
        self.assertNotEqual(self.check_archive(manifest=manifest).returncode, 0)

    def test_native_test_receipt_must_match_and_contain_executed_passing_tests(self):
        mutations = (
            lambda m: m.update(nativeTestReceipt=None),
            lambda m: m['nativeTestReceipt'].update(sourceCommit='b' * 40),
            lambda m: m['nativeTestReceipt'].update(sourceDigest='b' * 64),
            lambda m: m['nativeTestReceipt'].update(xcode='another Xcode'),
            lambda m: m['nativeTestReceipt']['summary'].update(result='Failed'),
            lambda m: m['nativeTestReceipt']['summary'].update(passedTests=0),
            lambda m: m['nativeTestReceipt']['summary'].update(failedTests=1),
        )
        for mutate in mutations:
            manifest = copy.deepcopy(self.manifest); mutate(manifest)
            self.assertNotEqual(self.check_archive(manifest=manifest).returncode, 0)

    def test_stale_embedded_manifest_and_duplicate_json_keys_are_rejected(self):
        manifest = copy.deepcopy(self.manifest); manifest['sourceCommit'] = 'b' * 40
        self.assertNotEqual(self.check_archive(manifest=manifest, expected_manifest=self.manifest).returncode, 0)
        with self.assertRaises(ValueError):
            verifier.read_json('{"reader":"UIKit","reader":"React"}')

    def test_optimized_python_does_not_disable_verification(self):
        result = self.check_archive(optimized=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(self.check_archive(binary=macho(signature=True), optimized=True).returncode, 0)
        info = copy.deepcopy(self.info); info['CFBundleIdentifier'] = 'other.app'
        self.assertNotEqual(self.check_archive(info=info, optimized=True).returncode, 0)


class NativeProvenanceTests(unittest.TestCase):
    def test_source_manifest_includes_shared_rust_assets_and_tests(self):
        inputs = provenance.source_inputs()
        for path in ('source/src-tauri/src/media_proxy.rs', 'source/src-tauri/src/durable.rs',
                     'source/src-tauri/plugins/ios-reader/src/fault.rs',
                     'ios-native/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png',
                     'ios-native/Tests/Services/NativePolicyTests.swift'):
            self.assertIn(path, inputs)
        self.assertNotIn('ios-native/Resources/BuildProvenance.json', inputs)

    def test_summary_requires_successful_execution_and_matching_input_identity(self):
        manifest = manifest_fixture(); receipt = manifest['nativeTestReceipt']
        self.assertTrue(provenance.matching_receipt(receipt, manifest['sourceCommit'], manifest['sourceDigest'], manifest['xcode']))
        self.assertFalse(provenance.matching_receipt(receipt, 'b' * 40, manifest['sourceDigest'], manifest['xcode']))
        self.assertFalse(provenance.matching_receipt(receipt, manifest['sourceCommit'], 'b' * 64, manifest['xcode']))
        self.assertFalse(provenance.matching_receipt(receipt, manifest['sourceCommit'], manifest['sourceDigest'], 'other Xcode'))
        for changes in ({'result': 'Failed'}, {'failedTests': 1}, {'passedTests': 0}, {'passedTests': True}):
            summary = dict(receipt['summary'], **changes)
            with self.assertRaises(ValueError):
                provenance.test_summary(summary)

    def test_receipt_is_bound_to_the_actual_result_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); bundle = root / 'Tests.xcresult'; bundle.mkdir()
            (bundle / 'data').write_bytes(b'xcresult fixture bytes')
            receipt_path = root / 'receipt.json'; summary = manifest_fixture()['nativeTestReceipt']['summary']
            def run(*args):
                if args[0] == 'xcrun':
                    self.assertEqual(args[1:5], ('xcresulttool', 'get', 'test-results', 'summary'))
                    return json.dumps(summary)
                return 'a' * 40 if args[0] == 'git' else 'Xcode fixture'
            with mock.patch.object(provenance, 'RECEIPT', receipt_path), mock.patch.object(provenance, 'run', run), mock.patch.object(provenance, 'source_inputs', return_value={'file': 'a' * 64}):
                provenance.record_tests(bundle)
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt['resultBundleSha256'], provenance.directory_digest(bundle))
            self.assertEqual(receipt['summarySha256'], provenance.digest(provenance.canonical(summary)))
            (bundle / 'data').write_bytes(b'changed bytes')
            self.assertNotEqual(receipt['resultBundleSha256'], provenance.directory_digest(bundle))

    def test_failed_receipt_attempt_invalidates_previous_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); receipt_path = root / 'receipt.json'
            receipt_path.write_text(json.dumps(manifest_fixture()['nativeTestReceipt']))
            with mock.patch.object(provenance, 'RECEIPT', receipt_path):
                with self.assertRaises(ValueError):
                    provenance.record_tests(root / 'missing.xcresult')
            self.assertEqual(json.loads(receipt_path.read_text())['result'], 'pending')


if __name__ == '__main__':
    unittest.main()
