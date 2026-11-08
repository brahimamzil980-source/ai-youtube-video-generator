import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { bundleAppJs } from './bundle.mjs';

// Inlines worker/sync.js into one Worker module: drops its `export` keywords and
// the matching import line in worker/index.js.
async function bundleWorker() {
  const sync = (await readFile('worker/sync.js', 'utf8')).replace(/^export (async function|function|const)/gm, '$1');
  const index = (await readFile('worker/index.js', 'utf8')).replace(/^import \{[^}]*\} from '\.\/sync\.js';\n/m, '');
  if (/^import /m.test(index) || /^export (?!default|const _internals)/m.test(sync + index)) throw Error('Unexpected import/export left in Worker bundle');
  return sync + '\n' + index;
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
