import { build } from 'vite';
import { resolve } from 'node:path';
const root=resolve(process.argv[2] ?? '.');
const outDir=resolve(process.argv[3] ?? 'dist-ios/validation-0.8.0/perf-candidate');
await build({root,base:'./',configFile:resolve(root,'vite.config.ts'),build:{outDir,emptyOutDir:false,rollupOptions:{input:resolve(root,'perf/feed-harness.html')}}});
