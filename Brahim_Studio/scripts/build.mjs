import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { bundleAppJs } from './bundle.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
const html = await readFile('public/index.html', 'utf8');
const js = await bundleAppJs();
const worker = await readFile('worker/index.js', 'utf8');
await writeFile('dist/server/index.js', `const HTML=${JSON.stringify(html)};\nconst APP_JS=${JSON.stringify(js)};\n${worker}`);
await writeFile('dist/.openai/hosting.json', await readFile('.openai/hosting.json'));
console.log('Built private Worker application');
