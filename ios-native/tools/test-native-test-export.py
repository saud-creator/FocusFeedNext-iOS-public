"""Exercise export/error handling with a fake xcresulttool; no simulator runs."""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_test_export', Path(__file__).with_name('export-native-tests.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class NativeTestExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='native evidence ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / 'Tests-123.xcresult'
        self.bundle.mkdir()
        self.output = self.root / 'dist/test-evidence/Tests-123'
        self.calls = []

    def runner(self, command, **options):
        self.calls.append(command)
        self.assertEqual(command[0:2], ['xcrun', 'xcresulttool'])
        self.assertFalse(options['check'])
        if command[2:5] == ['get', 'test-results', 'summary']:
            return subprocess.CompletedProcess(command, 0, json.dumps({
                'result': 'Passed', 'totalTestCount': 3, 'passedTests': 3,
                'failedTests': 0, 'skippedTests': 0}), '')
        self.assertEqual(command[2:4], ['export', 'attachments'])
        self.assertEqual(command[command.index('--path') + 1], str(self.bundle))
        destination = Path(command[command.index('--output-path') + 1])
        self.assertTrue(destination.is_dir())
        (destination / 'welcome.png').write_bytes(b'synthetic screenshot fixture')
        (destination / 'manifest.json').write_text('{}')
        return subprocess.CompletedProcess(command, 0, '', '')

    def report(self):
        return json.loads((self.output / 'test-summary.json').read_text())

    def test_passing_run_exports_reviewable_images_and_compact_summary(self):
        self.assertEqual(exporter.export_results(self.bundle, self.output, 0, self.runner), 0)
        report = self.report()
        self.assertEqual(report['summary']['passedTests'], 3)
        self.assertEqual(report['screenshots'], ['attachments/welcome.png'])
        self.assertEqual(report['attachmentFileCount'], 2)
        self.assertEqual(report['xcodebuildExitStatus'], 0)
        self.assertIn('not performed', report['physicalDeviceAcceptance'])
        self.assertEqual(len(self.calls), 2)

    def test_failed_xcodebuild_still_exports_and_records_original_status(self):
        def runner(command, **options):
            result = self.runner(command, **options)
            if command[2] == 'get':
                summary = json.loads(result.stdout)
                summary.update(result='Failed', passedTests=2, failedTests=1,
                               testFailures=[{'failureText': 'Native UI failure'}])
                result.stdout = json.dumps(summary)
            return result
        self.assertEqual(exporter.export_results(self.bundle, self.output, 65, runner), 0)
        self.assertEqual(self.report()['xcodebuildExitStatus'], 65)
        self.assertEqual(self.report()['summary']['failedTests'], 1)
        self.assertEqual(self.report()['summary']['testFailures'][0]['failureText'], 'Native UI failure')
        self.assertTrue(self.report()['screenshots'])

    def test_summary_failure_does_not_skip_attachment_export(self):
        def runner(command, **options):
            if command[2] == 'get':
                return subprocess.CompletedProcess(command, 70, '', 'invalid bundle')
            return self.runner(command, **options)
        self.assertEqual(exporter.export_results(self.bundle, self.output, 65, runner), 1)
        self.assertIsNone(self.report()['summary'])
        self.assertTrue(self.report()['attachmentsExported'])
        self.assertTrue(self.report()['screenshots'])

    def test_attachment_failure_cannot_qualify_otherwise_passing_tests(self):
        def runner(command, **options):
            if command[2] == 'export':
                return subprocess.CompletedProcess(command, 74, '', 'export failed')
            return self.runner(command, **options)
        self.assertEqual(exporter.export_results(self.bundle, self.output, 0, runner), 1)
        self.assertEqual(self.report()['summary']['passedTests'], 3)
        self.assertFalse(self.report()['attachmentsExported'])

    def test_empty_successful_export_does_not_qualify_missing_ui_screenshots(self):
        def runner(command, **options):
            if command[2] == 'export':
                return subprocess.CompletedProcess(command, 0, '', '')
            return self.runner(command, **options)
        self.assertEqual(exporter.export_results(self.bundle, self.output, 0, runner), 1)
        self.assertEqual(self.report()['screenshots'], [])
        self.assertTrue(self.report()['errors'])

    def test_invalid_summary_still_attempts_attachments_and_stale_evidence_is_refused(self):
        def runner(command, **options):
            if command[2] == 'get':
                return subprocess.CompletedProcess(command, 0, '{broken', '')
            return self.runner(command, **options)
        self.assertEqual(exporter.export_results(self.bundle, self.output, 0, runner), 1)
        self.assertTrue(self.report()['screenshots'])
        with self.assertRaises(FileExistsError):
            exporter.export_results(self.bundle, self.output, 0, self.runner)


class BuildExitStatusTests(unittest.TestCase):
    def test_real_build_script_preserves_test_failures_and_requires_export(self):
        bash = shutil.which('bash')
        if not bash:
            candidate = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe'
            bash = str(candidate) if candidate.is_file() else None
        if not bash:
            self.skipTest('Bash is unavailable; exporter cases still run.')
        for test_status, export_status, bundle_exists, expected, receipt in (
                (65, 0, True, 65, False), (65, 74, True, 65, False),
                (0, 74, True, 74, False), (0, 0, True, 0, True),
                (65, 0, False, 65, False), (0, 0, False, 1, False)):
            with self.subTest(test_status=test_status, export_status=export_status, bundle=bundle_exists):
                with tempfile.TemporaryDirectory(prefix='native build evidence ') as temporary:
                    root = Path(temporary)
                    tools = root / 'ios-native/tools'
                    tools.mkdir(parents=True)
                    script = tools / 'build-native.sh'
                    script.write_text(Path(__file__).with_name('build-native.sh').read_text(), newline='\n')
                    environment = root / 'fixture-environment.sh'
                    # Run the actual build script control flow without invoking
                    # Xcode, Rust, or any production export/provenance command.
                    environment.write_text('''PATH="/usr/bin:/bin:$PATH"
xcodegen() { return 0; }
bash() { return 0; }
shasum() { printf 'unchanged fixture plist\\n'; }
python3() {
  case "$1" in
    *select-simulator.py) printf 'platform=iOS Simulator,id=fixture\\n';;
    *export-native-tests.py) printf 'export attempted\\n' > .export-attempted; return "$NATIVE_EXPORT_STATUS";;
    *write-provenance.py) if [[ "${2:-}" == --record-tests ]]; then : > .receipt-recorded; fi;;
  esac
  return 0
}
xcodebuild() {
  local previous="" argument result=""
  for argument in "$@"; do
    if [[ "$previous" == -resultBundlePath ]]; then result="$argument"; fi
    previous="$argument"
  done
  if [[ "$NATIVE_TEST_BUNDLE" == yes ]]; then mkdir -p "$result"; fi
  return "$NATIVE_TEST_STATUS"
}
''', newline='\n')
                    env = dict(os.environ, BASH_ENV=environment.as_posix(),
                               NATIVE_TEST_STATUS=str(test_status), NATIVE_EXPORT_STATUS=str(export_status),
                               NATIVE_TEST_BUNDLE='yes' if bundle_exists else 'no')
                    result = subprocess.run([bash, script.as_posix(), 'check'], env=env,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                    self.assertEqual((root / 'ios-native/.receipt-recorded').exists(), receipt)
                    self.assertEqual((root / 'ios-native/.export-attempted').exists(), bundle_exists)


if __name__ == '__main__':
    unittest.main()
