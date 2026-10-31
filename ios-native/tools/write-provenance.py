"""Record native inputs and successful simulator test evidence.

The receipt qualifies simulator tests, not physical-device or live-provider use.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RECEIPT = ROOT / 'ios-native/.build/native-test-receipt.json'
ENGINE_INPUTS = (
    'ios-native/NativeServices/TransportDocument.swift',
    'ios-native/NativeServices/ReaderScript.swift',
    'ios-native/NativeServices/TransportRules.swift',
    'ios-native/NativeServices/IdentityTransport.swift',
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def source_inputs(root=ROOT):
    files = {}
    # Include the shared Rust modules imported using #[path], not only crates/.
    folders = ('ios-native/App', 'ios-native/NativeServices', 'ios-native/Integration',
               'ios-native/Tests', 'ios-native/tools', 'ios-native/Resources/Assets.xcassets',
               'crates', 'source/src-tauri/src', 'source/src-tauri/plugins/ios-reader/src')
    extensions = {'.swift', '.rs', '.toml', '.json', '.py', '.sh', '.png', '.h', '.modulemap'}
    for folder in folders:
        for path in sorted((root / folder).rglob('*')):
            if path.is_file() and path.suffix in extensions and '__pycache__' not in path.parts:
                files[path.relative_to(root).as_posix()] = digest(path.read_bytes())
    for name in ('ios-native/project.yml', 'ios-native/Configuration/Info.plist',
                 'rust-toolchain.toml', 'Cargo.toml', 'Cargo.lock', '.github/workflows/native-ios.yml'):
        files[name] = digest((root / name).read_bytes())
    return dict(sorted(files.items()))


def directory_digest(directory):
    files = {path.relative_to(directory).as_posix(): digest(path.read_bytes())
             for path in sorted(directory.rglob('*')) if path.is_file()}
    if not files:
        raise ValueError('The test result bundle is empty.')
    return digest(canonical(files))


def test_summary(summary):
    """Accept only an xcresulttool summary with actual passing tests."""
    result = summary.get('result')
    if not isinstance(result, str) or result.lower() != 'passed':
        raise ValueError('The native test result did not pass.')
    keys = ('totalTestCount', 'passedTests', 'failedTests', 'skippedTests')
    if any(type(summary.get(key)) is not int or summary[key] < 0 for key in keys):
        raise ValueError('The native test summary has missing or invalid counts.')
    if summary['failedTests'] != 0 or summary['passedTests'] < 1 or summary['totalTestCount'] < 1:
        raise ValueError('The native test result has failures or no executed tests.')
    if summary.get('testFailures'):
        raise ValueError('The native test summary contains failures.')
    return {key: summary[key] for key in ('result',) + keys}


def matching_receipt(receipt, commit, sources_digest, xcode):
    if not isinstance(receipt, dict) or receipt.get('schemaVersion') != 1:
        return False
    if (receipt.get('sourceCommit') != commit or receipt.get('sourceDigest') != sources_digest
            or receipt.get('xcode') != xcode or receipt.get('recordedBy') != 'xcresulttool'):
        return False
    try:
        test_summary(receipt['summary'])
        return all(isinstance(receipt.get(key), str) and len(receipt[key]) == 64
                   and all(c in '0123456789abcdef' for c in receipt[key])
                   for key in ('resultBundleSha256', 'summarySha256'))
    except (KeyError, TypeError, ValueError):
        return False


def record_tests(bundle):
    # Invalidate previous evidence before processing a new qualification attempt.
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps({'schemaVersion': 1, 'result': 'pending'}) + '\n')
    bundle = bundle.resolve()
    if not bundle.is_dir() or bundle.suffix != '.xcresult':
        raise ValueError('A completed .xcresult directory is required.')
    raw = run('xcrun', 'xcresulttool', 'get', 'test-results', 'summary', '--path', str(bundle))
    summary = test_summary(json.loads(raw))
    sources = source_inputs()
    receipt = {
        'schemaVersion': 1, 'recordedBy': 'xcresulttool',
        'sourceCommit': run('git', 'rev-parse', 'HEAD'),
        'sourceDigest': digest(canonical(sources)),
        'resultBundleSha256': directory_digest(bundle),
        'summarySha256': digest(canonical(json.loads(raw))),
        'summary': summary, 'xcode': run('xcodebuild', '-version'),
        'testEnvironment': 'iOS Simulator',
        'physicalDeviceAcceptance': 'not performed by simulator tests',
    }
    RECEIPT.write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Native test receipt recorded: {summary["passedTests"]} passed tests.')


def write_manifest():
    sources = source_inputs()
    sources_digest = digest(canonical(sources))
    commit = run('git', 'rev-parse', 'HEAD')
    xcode = run('xcodebuild', '-version')
    metadata = json.loads(run('cargo', 'metadata', '--locked', '--format-version', '1',
                              '--filter-platform', 'aarch64-apple-ios'))
    packages = sorted({package['name'] for package in metadata['packages']})
    if any(name.startswith('tauri') or name == 'tao' for name in packages):
        raise ValueError('Legacy shell dependency entered the native workspace.')
    uniffi = {package['version'] for package in metadata['packages'] if package['name'] == 'uniffi'}
    if uniffi != {'0.32.1'}:
        raise ValueError('The native bridge must use UniFFI exactly 0.32.1.')
    receipt = json.loads(RECEIPT.read_text()) if RECEIPT.exists() else None
    if not matching_receipt(receipt, commit, sources_digest, xcode):
        receipt = None
    generated = {path.relative_to(ROOT).as_posix(): digest(path.read_bytes())
                 for path in sorted((ROOT / 'ios-native/Generated').glob('*')) if path.is_file()}
    resources = {name: sha for name, sha in sources.items()
                 if name.startswith('ios-native/Resources/')}
    manifest = {
        'schemaVersion': 2, 'version': '0.10.0', 'sourceCommit': commit,
        'sourceDigest': sources_digest, 'sources': sources,
        'rust': run('rustc', '--version'), 'xcode': xcode,
        'lockSha256': sources['Cargo.lock'], 'rustPackages': packages,
        'sdk': run('xcrun', '--sdk', 'iphoneos', '--show-sdk-version'),
        'signing': 'unsigned', 'reader': 'UIKit', 'minimumOS': '16.0',
        'bindings': {'uniffiVersion': '0.32.1', 'swiftLanguageMode': '5', 'generatedHashes': generated},
        'engineSources': {name: sources[name] for name in ENGINE_INPUTS},
        'resources': resources, 'nativeTestReceipt': receipt,
    }
    out = ROOT / 'ios-native/Resources/BuildProvenance.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-tests', type=Path)
    args = parser.parse_args()
    try:
        if args.record_tests is not None:
            record_tests(args.record_tests)
        else:
            write_manifest()
    except (ValueError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Native provenance failed: {error}\n')


if __name__ == '__main__':
    main()
