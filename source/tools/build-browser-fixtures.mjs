import {build} from 'vite';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
// Measure the release renderer, not React's development checks. This entry is
// isolated from the ordinary app output and can never enter the device IPA.
await build({
  root,configFile:resolve(root,'vite.config.ts'),
  build:{outDir:resolve(root,'dist-ios/browser-fixture-app'),emptyOutDir:true,
    rolldownOptions:{input:resolve(root,'tools/browser-fixtures/index.html')}},
});
