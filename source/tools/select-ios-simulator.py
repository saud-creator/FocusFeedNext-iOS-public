"""Select an available, compatible iPhone on the SDK-matched iOS 27.1 runtime."""
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
devices = [item for item in catalog['devices'].get(runtime['identifier'], [])
           if item.get('isAvailable') and item['name'].startswith('iPhone')]
device = next((item for item in devices if item['name'] == 'iPhone 17 Pro'), None)
device = device or next(iter(devices), None)
supported = runtime.get('supportedDeviceTypes', [])
if device:
    device_type = next(item for item in catalog['devicetypes']
                       if item['identifier'] == device.get('deviceTypeIdentifier')
                       or item['name'] == device['name'])
else:
    device_type = next((item for item in supported if item['name'].startswith('iPhone')), None)
    if device_type is None:
        raise SystemExit('The pinned runtime has no supported iPhone device profile.')
identifier = device['udid'] if device else subprocess.check_output([
    'xcrun', 'simctl', 'create', 'Focus Feed UI Tests',
    device_type['identifier'], runtime['identifier']], text=True).strip()
if len(sys.argv) > 1:
    Path(sys.argv[1]).write_text(json.dumps({
        'runtime': runtime['identifier'], 'version': runtime['version'],
        'deviceType': device_type['identifier'], 'device': identifier,
        'deviceName': device['name'] if device else device_type['name'],
    }, indent=2), encoding='utf-8')
print(identifier)
