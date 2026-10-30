from pathlib import Path
import hashlib, json, subprocess
root=Path(__file__).resolve().parents[2]
def run(*args): return subprocess.check_output(args,cwd=root,text=True).strip()
files={}
for folder in ['ios-native/App','ios-native/NativeServices','ios-native/Integration','crates']:
    for path in sorted((root/folder).rglob('*')):
        if path.is_file() and path.suffix in {'.swift','.rs','.toml','.json'}:
            files[path.relative_to(root).as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
manifest={'schemaVersion':1,'version':'0.10.0','sourceCommit':run('git','rev-parse','HEAD'),
          'rust':run('rustc','--version'),'xcode':run('xcodebuild','-version'),
          'lockSha256':hashlib.sha256((root/'Cargo.lock').read_bytes()).hexdigest(),
          'sources':files,'signing':'unsigned','reader':'UIKit','minimumOS':'16.0'}
out=root/'ios-native/Resources/BuildProvenance.json'
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(manifest,indent=2)+'\n')
