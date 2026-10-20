"""Select an isolated iPhone 17 Pro on the SDK-matched iOS 27.1 runtime."""
import json
import subprocess
import sys
from pathlib import Path

catalog = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', '-j']))
runtime = next((item for item in catalog['runtimes']
                if item.get('isAvailable') and item.get('version') == '27.1'
                and 'iOS' in item['identifier']), None)
if runtime is None:
    raise SystemExit('The pinned iOS 27.1 simulator runtime is unavailable.')
device_type = next(item for item in catalog['devicetypes'] if item['name'] == 'iPhone 17 Pro')
devices = catalog['devices'].get(runtime['identifier'], [])
device = next((item for item in devices if item.get('isAvailable')
               and item.get('deviceTypeIdentifier') == device_type['identifier']), None)
identifier = device['udid'] if device else subprocess.check_output([
    'xcrun', 'simctl', 'create', 'Focus Feed UI Tests',
    device_type['identifier'], runtime['identifier']], text=True).strip()
if len(sys.argv) > 1:
    Path(sys.argv[1]).write_text(json.dumps({
        'runtime': runtime['identifier'], 'version': runtime['version'],
        'deviceType': device_type['identifier'], 'device': identifier,
    }, indent=2), encoding='utf-8')
print(identifier)
