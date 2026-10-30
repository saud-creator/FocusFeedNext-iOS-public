import json, subprocess
state=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','available','--json']))
candidates=[]
for runtime, devices in state['devices'].items():
    if '.iOS-' not in runtime: continue
    version=tuple(int(v) for v in runtime.split('.iOS-')[-1].split('-'))
    for device in devices:
        if device.get('isAvailable') and device['name'].startswith('iPhone'):
            candidates.append((version, device['name'], device['udid']))
if not candidates: raise SystemExit('No available iPhone simulator; native UI tests cannot be skipped.')
device=sorted(candidates)[-1]
print('platform=iOS Simulator,id='+device[2])
