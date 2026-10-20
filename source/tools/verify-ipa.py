"""Verify an unsigned device IPA without executing it or reading account data."""
import argparse, hashlib, json, plistlib, struct, zipfile
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('ipa',type=Path);parser.add_argument('--version',default=json.loads(Path(__file__).resolve().parents[1].joinpath('package.json').read_text())['version']);parser.add_argument('--output',type=Path)
args=parser.parse_args()
with zipfile.ZipFile(args.ipa) as archive:
    assert archive.testzip() is None, 'Archive CRC failure'
    names=archive.namelist()
    assert all(not name.startswith('/') and '..' not in name.split('/') for name in names), 'Unsafe archive path'
    plists=[name for name in names if name.startswith('Payload/') and name.count('/')==2 and name.endswith('.app/Info.plist')]
    assert len(plists)==1, 'IPA must contain one application'
    info=plistlib.loads(archive.read(plists[0]));root=plists[0].removesuffix('Info.plist')
    assert info['CFBundleIdentifier']=='com.focusfeed.next', 'Unexpected app identity'
    assert info['CFBundleShortVersionString']==args.version, 'Unexpected version'
    assert info['CFBundleSupportedPlatforms']==['iPhoneOS'], 'Not an iPhone device build'
    assert info.get('MinimumOSVersion')=='16.0', 'Expected the iOS 16 deployment minimum'
    ats=info.get('NSAppTransportSecurity',{})
    assert ats.get('NSExceptionDomains',{}).get('127.0.0.1',{}).get('NSExceptionAllowsInsecureHTTPLoads') is True, 'Missing media proxy loopback transport exception'
    assert not any(ats.get(key) for key in ('NSAllowsArbitraryLoads','NSAllowsArbitraryLoadsForMedia','NSAllowsArbitraryLoadsInWebContent')), 'External transport protections must remain enabled'
    assert b'FFN_UI_TEST_SCENARIO' not in archive.read(root+info['CFBundleExecutable']), 'Test fixture backend present in release'
    assert not any('FixtureApp' in name for name in names), 'Test fixture renderer present in release'
    assert info.get('CADisableMinimumFrameDurationOnPhone') is True, 'Missing ProMotion opt-in'
    scenes=info.get('UIApplicationSceneManifest',{})
    assert scenes.get('UIApplicationSupportsMultipleScenes') is True, 'Tao scene lifecycle is not enabled'
    assert any(scene.get('UISceneDelegateClassName')=='TaoSceneDelegate' for scene in scenes.get('UISceneConfigurations',{}).get('UIWindowSceneSessionRoleApplication',[])), 'Missing iOS 27 scene delegate'
    assert not any('_CodeSignature' in name.split('/') or name.endswith('.mobileprovision') for name in names), 'Signature or profile present'
    executable=archive.read(root+info['CFBundleExecutable'])
    assert struct.unpack_from('<I',executable)[0]==0xfeedfacf, 'Expected a thin 64-bit Mach-O'
    _,cpu,subtype,_,count,_,_,_=struct.unpack_from('<8I',executable)
    assert cpu==0x0100000c, 'Expected arm64'
    offset=32;commands=[]
    for _ in range(count):
        command,size=struct.unpack_from('<II',executable,offset)
        assert size>=8 and offset+size<=len(executable), 'Malformed load command'
        commands.append(command);offset+=size
    assert 0x1d not in commands, 'Mach-O code signature present'
    native_images=0
    for name in names:
        if name.endswith('/'):continue
        data=archive.read(name)
        if data[:4] == b'\xcf\xfa\xed\xfe':
            native_images+=1;position=32
            for _ in range(struct.unpack_from('<I',data,16)[0]):
                command,size=struct.unpack_from('<II',data,position);assert command!=0x1d,f'Signed native image: {name}';position+=size
    report={'version':info['CFBundleShortVersionString'],'build':info['CFBundleVersion'],'bundleIdentifier':info['CFBundleIdentifier'],
            'platforms':info['CFBundleSupportedPlatforms'],'minimumOS':info.get('MinimumOSVersion'),'sdk':info.get('DTSDKName'),
            'architecture':'arm64','proMotionOptIn':True,'zipEntries':len(names),'nativeImagesChecked':native_images,'archiveCRC':'passed',
            'codeSignatures':0,'provisioningProfiles':0,'bytes':args.ipa.stat().st_size,'sha256':hashlib.sha256(args.ipa.read_bytes()).hexdigest()}
if args.output:args.output.write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
