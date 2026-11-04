"""Export simulator test attachments and a compact summary for artifact review.

Failed runs are evidence too. The caller preserves xcodebuild's original exit
status; a successful run requires a successful export with reviewable images.
This export does not establish physical-device or live-provider acceptance.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.heic', '.tif', '.tiff', '.bmp'}
COUNT_KEYS = ('totalTestCount', 'passedTests', 'failedTests', 'skippedTests')


def export_results(bundle, output, xcodebuild_status, runner=subprocess.run):
    if not bundle.is_dir() or bundle.suffix != '.xcresult':
        raise ValueError('A native .xcresult directory is required.')
    # Never mistake attachments from a preceding attempt for this attempt's
    # evidence. Every xcodebuild invocation already receives a unique bundle.
    output.mkdir(parents=True, exist_ok=False)
    report = {
        'schemaVersion': 1,
        'resultBundle': bundle.name,
        'xcodebuildExitStatus': xcodebuild_status,
        'summary': None,
        'attachmentsExported': False,
        'attachmentFileCount': 0,
        'screenshots': [],
        'errors': [],
        'testEnvironment': 'iOS Simulator',
        'physicalDeviceAcceptance': 'not performed by simulator tests',
    }
    try:
        result = runner(['xcrun', 'xcresulttool', 'get', 'test-results', 'summary',
                         '--path', str(bundle)], capture_output=True, text=True,
                        check=False, timeout=180)
        if result.returncode:
            raise ValueError('xcresulttool summary exited with status ' + str(result.returncode))
        raw = json.loads(result.stdout)
        if not isinstance(raw, dict) or not isinstance(raw.get('result'), str):
            raise ValueError('xcresulttool did not return a test summary.')
        if any(type(raw.get(key)) is not int or raw[key] < 0 for key in COUNT_KEYS):
            raise ValueError('xcresulttool summary is missing valid test counts.')
        report['summary'] = {key: raw[key] for key in ('result',) + COUNT_KEYS}
        if isinstance(raw.get('testFailures'), list):
            report['summary']['testFailures'] = raw['testFailures'][:20]
            report['summary']['additionalFailureCount'] = max(0, len(raw['testFailures']) - 20)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report['errors'].append('Summary export failed: ' + str(error))

    attachments = output / 'attachments'
    try:
        attachments.mkdir()
        result = runner(['xcrun', 'xcresulttool', 'export', 'attachments',
                         '--path', str(bundle), '--output-path', str(attachments)],
                        capture_output=True, text=True, check=False, timeout=300)
        if result.returncode:
            raise ValueError('xcresulttool attachment export exited with status ' + str(result.returncode))
        files = sorted(path for path in attachments.rglob('*') if path.is_file())
        report['attachmentsExported'] = True
        report['attachmentFileCount'] = len(files)
        report['screenshots'] = [path.relative_to(output).as_posix() for path in files
                                 if path.suffix.lower() in IMAGE_SUFFIXES and path.stat().st_size > 0]
        if xcodebuild_status == 0 and not report['screenshots']:
            raise ValueError('Passing native UI tests exported no reviewable screenshots.')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report['errors'].append('Attachment export failed: ' + str(error))

    (output / 'test-summary.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'Native test evidence: {output} ({len(report["screenshots"])} screenshots)')
    for error in report['errors']:
        print(error, file=sys.stderr)
    return 1 if report['errors'] else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--xcodebuild-status', type=int, required=True)
    args = parser.parse_args()
    try:
        status = export_results(args.bundle, args.output, args.xcodebuild_status)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Native test export failed: {error}\n')
    parser.exit(status)


if __name__ == '__main__':
    main()
