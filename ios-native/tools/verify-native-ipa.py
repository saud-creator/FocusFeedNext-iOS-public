"""Verify the actual native archive, never infer readiness from its version."""
import argparse, hashlib, json, plistlib, struct, zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('ipa',type=Path);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
with zipfile.ZipFile(a.ipa) as z:
    assert z.testzip() is None, 'IPA CRC failed'
    names=z.namelist();prefix='Payload/FocusFeedNext.app/'
    info=plistlib.loads(z.read(prefix+'Info.plist'))
    assert info['CFBundleIdentifier']=='com.focusfeed.next'
    assert info['CFBundleShortVersionString']=='0.10.0'
    assert info['MinimumOSVersion']=='16.0'
    assert info['CFBundleSupportedPlatforms']==['iPhoneOS'], 'Not a device archive'
    assert not any('_CodeSignature' in n or n.endswith('.mobileprovision') for n in names)
    assert not any('/assets/' in n or n.endswith('.html') for n in names), 'Web reader resources in native app'
    ats=info['NSAppTransportSecurity'];assert not ats.get('NSAllowsArbitraryLoads',False)
    assert set(ats.get('NSExceptionDomains',{}))=={'127.0.0.1'}
    scene=info['UIApplicationSceneManifest']['UISceneConfigurations']['UIWindowSceneSessionRoleApplication'][0]
    assert scene['UISceneDelegateClassName'].endswith('.NativeSceneDelegate')
    binary=z.read(prefix+info['CFBundleExecutable'])
    assert binary[:4]==b'\xcf\xfa\xed\xfe' and struct.unpack_from('<I',binary,4)[0]==0x100000c, 'Expected thin arm64 Mach-O'
    manifest=json.loads(z.read(prefix+'BuildProvenance.json'))
    assert manifest==json.loads(a.manifest.read_text())
    assert len(manifest['sourceCommit'])==40 and manifest['reader']=='UIKit'
    # Inspect load commands, rather than matching incidental text in the engine.
    count=struct.unpack_from('<I',binary,16)[0];offset=32
    linked=[];device_platform=False
    for _ in range(count):
        command,size=struct.unpack_from('<II',binary,offset)
        assert size>=8 and offset+size<=len(binary)
        assert command!=0x1d, 'Executable contains an embedded signature'
        if command==0x32:
            assert size>=24
            platform,minimum=struct.unpack_from('<II',binary,offset+8)
            device_platform=platform==2
            assert minimum==16<<16, 'Executable minimum OS differs from Info.plist'
        if command in {0xc,0x80000018,0x8000001f,0x80000023}:
            name_offset=struct.unpack_from('<I',binary,offset+8)[0]
            linked.append(binary[offset+name_offset:offset+size].split(b'\0',1)[0].decode())
        offset+=size
    assert device_platform, 'Missing iOS device build-version command'
    assert not any('tauri' in n.lower() or 'tao' in n.lower() for n in linked)
report={'schemaVersion':1,'version':info['CFBundleShortVersionString'],'build':info['CFBundleVersion'],
        'bundleID':info['CFBundleIdentifier'],'architecture':'arm64','minimumOS':'16.0','archiveCRC':'passed',
        'sourceCommit':manifest['sourceCommit'],'reader':'UIKit','signatures':0,'provisioningProfiles':0,
        'sha256':hashlib.sha256(a.ipa.read_bytes()).hexdigest(),'physicalDeviceAcceptance':'not performed by archive verifier'}
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
