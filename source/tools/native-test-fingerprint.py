"""Fingerprint the exact native fixture inputs; never cache a passing result across builds."""
from hashlib import sha256
from pathlib import Path
import subprocess


def fingerprint(root: Path, toolchain: bytes) -> str:
    paths = {
        root / 'tools/test-ios-native.sh',
        root / 'tools/native-test-fingerprint.py',
        root / 'tools/build-ios-native.mjs',
        root / 'package-lock.json',
    }
    for folder in ('src-tauri/plugins/ios-reader/ios/Sources',
                   'src-tauri/plugins/ios-reader/transaction',
                   'tools/ios-native-tests', 'tools/browser-fixtures'):
        paths.update(path for path in (root / folder).rglob('*')
                     if path.is_file() and '__pycache__' not in path.parts)
    digest = sha256(toolchain)
    for path in sorted(paths):
        digest.update(path.relative_to(root).as_posix().encode() + b'\0')
        digest.update(sha256(path.read_bytes()).digest())
    return digest.hexdigest()


if __name__ == '__main__':
    version = subprocess.check_output(['xcrun', 'swiftc', '--version'])
    print(fingerprint(Path(__file__).resolve().parent.parent, version))
