from pathlib import Path
import hashlib, zipfile
root=Path(__file__).resolve().parents[1]
app=root/'.build/FocusFeedNext.xcarchive/Products/Applications/FocusFeedNext.app'
if not app.is_dir(): raise SystemExit('Native device archive is missing.')
if list(app.rglob('_CodeSignature')) or list(app.rglob('*.mobileprovision')):
    raise SystemExit('Unsigned delivery must not contain a signature or provisioning profile.')
out=root/'dist/FocusFeedNext-unsigned.ipa'
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(app.rglob('*')):
        if path.is_file(): archive.write(path, 'Payload/FocusFeedNext.app/'+path.relative_to(app).as_posix())
out.with_suffix('.ipa.sha256').write_text(hashlib.sha256(out.read_bytes()).hexdigest()+'  '+out.name+'\n')
print(out)
