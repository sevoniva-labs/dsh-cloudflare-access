import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['@deepseek-ai/*', 'jose', 'proper-lockfile'], sourcemap: true });
const client = await build({ entryPoints: ['src/client.ts'], bundle: true, platform: 'browser', format: 'cjs', target: 'es2022', write: false });
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"@sevoniva/dsh-cloudflare-access",factory:function(require){const module={exports:{}};const exports=module.exports;${client.outputFiles[0].text}\nreturn module.exports.createClient(require);}});\n`);
console.log('Built host and native Harness client bundles.');
