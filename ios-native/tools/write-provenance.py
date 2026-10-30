from pathlib import Path
import hashlib, json, subprocess
root=Path(__file__).resolve().parents[2]
def run(*args): return subprocess.check_output(args,cwd=root,text=True).strip()
files={}
for folder in ['ios-native/App','ios-native/NativeServices','ios-native/Integration','crates']:
    for path in sorted((root/folder).rglob('*')):
        if path.is_file() and path.suffix in {'.swift','.rs','.toml','.json'}:
            files[path.relative_to(root).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
for name in ['ios-native/project.yml','ios-native/Configuration/Info.plist','ios-native/tools/build-native.sh','ios-native/tools/build-core.sh','rust-toolchain.toml','Cargo.toml']:
    files[name]=hashlib.sha256((root/name).read_bytes()).hexdigest()
metadata=json.loads(run('cargo','metadata','--locked','--format-version','1','--filter-platform','aarch64-apple-ios'))
packages=sorted({package['name'] for package in metadata['packages']})
if any(name.startswith('tauri') or name=='tao' for name in packages):
    raise SystemExit('Legacy shell dependency entered the native workspace.')
manifest={'schemaVersion':1,'version':'0.10.0','sourceCommit':run('git','rev-parse','HEAD'),
          'rust':run('rustc','--version'),'xcode':run('xcodebuild','-version'),
          'lockSha256':hashlib.sha256((root/'Cargo.lock').read_bytes()).hexdigest(),
          'sources':files,'rustPackages':packages,'sdk':run('xcrun','--sdk','iphoneos','--show-sdk-version'),
          'signing':'unsigned','reader':'UIKit','minimumOS':'16.0'}
out=root/'ios-native/Resources/BuildProvenance.json'
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(manifest,indent=2)+'\n')
