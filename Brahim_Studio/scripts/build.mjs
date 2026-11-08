import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { bundleAppJs } from './bundle.mjs';

// Builds one Worker module: local modules imported by worker/index.js
// (`import { … } from './x.js';`) are inlined before it, without their exports.
async function bundleWorker() {
  let index = await readFile('worker/index.js', 'utf8');
  const modules = [];
  index = index.replace(/^import \{[^}]*\} from '\.\/([a-z-]+\.js)';\n/gm, (_, file) => { modules.push(file); return ''; });
  const parts = [];
  for (const file of modules) {
    const src = (await readFile('worker/' + file, 'utf8'))
      .replace(/^export (async function|function|const)/gm, '$1')
      .replace(/^export \{[^}]*\};\n?/gm, '');
    parts.push('// ---- worker/' + file + ' ----\n' + src);
  }
  const out = parts.join('\n') + '\n' + index;
  if (/^import /m.test(out) || /^export (?!default|const _internals)/m.test(out)) throw Error('Unexpected import/export left in Worker bundle');
  return out;
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
const html = await readFile('public/index.html', 'utf8');
const js = await bundleAppJs();
const worker = await bundleWorker();
await writeFile('dist/server/index.js', `const HTML=${JSON.stringify(html)};\nconst APP_JS=${JSON.stringify(js)};\n${worker}`);
await writeFile('dist/.openai/hosting.json', await readFile('.openai/hosting.json'));
console.log('Built private Worker application');
