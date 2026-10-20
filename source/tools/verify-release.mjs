import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const json=path=>JSON.parse(readFileSync(resolve(root,path),'utf8'));
const version=json('package.json').version;
assert.match(version,/^\d+\.\d+\.\d+$/);
assert.equal(json('package-lock.json').version,version,'npm lock version');
assert.equal(json('package-lock.json').packages[''].version,version,'npm root lock version');
assert.equal(json('src-tauri/tauri.conf.json').version,version,'Tauri version');
assert.equal(readFileSync(resolve(root,'src-tauri/Cargo.toml'),'utf8').match(/^version = "([^"]+)"/m)?.[1],version,'Cargo version');
assert.notEqual(process.env.FFN_UI_TEST,'1','Fixture mode is forbidden for release metadata');
const build=process.env.PROJECT_BUILD_NUMBER || process.env.BUILD_NUMBER || 'local';
const metadata={version,build,sourceCommit:process.env.CM_COMMIT || process.env.GITHUB_SHA || 'local',fixtureMode:false};
if(process.argv[2]) { const path=resolve(root,process.argv[2]);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(metadata,null,2)+'\n'); }
console.log(JSON.stringify(metadata));
