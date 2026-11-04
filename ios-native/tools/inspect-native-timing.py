"""Read stored simulator timing activities without executing an app or test."""
import argparse
import json
import subprocess
from pathlib import Path

TEST = 'NativeFeedIntegrationTests/testReturnedFirstPageHasVisibleNativeContentWithin250Milliseconds()'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    bundles = sorted(path for path in args.evidence.rglob('*.xcresult') if path.is_dir())
    if len(bundles) != 1:
        parser.exit(1, 'Exactly one native result bundle is required.\n')
    result = subprocess.run(['xcrun', 'xcresulttool', 'get', 'test-results', 'activities',
                             '--path', str(bundles[0]), '--test-id', TEST],
                            capture_output=True, text=True, check=True, timeout=120)
    activities = json.loads(result.stdout)
    output = Path('ios-native/dist/timing-inspection.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'testIdentifier': TEST, 'activities': activities}, indent=2) + '\n', encoding='utf-8')

    def visit(value):
        if isinstance(value, dict):
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, str) and any(marker in value for marker in ('Snapshot update:', 'Controlled returned-data', 'First-page p95:')):
            print(value)

    visit(activities)


if __name__ == '__main__':
    main()
