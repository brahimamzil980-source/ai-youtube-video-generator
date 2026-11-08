// Concatenates public/js/*.js (name order) into one script wrapped in an IIFE.
import { readFile, readdir } from 'node:fs/promises';

export async function bundleAppJs(root = new URL('../public/js/', import.meta.url)) {
  const files = (await readdir(root)).filter((f) => f.endsWith('.js')).sort();
  const parts = [];
  for (const f of files) parts.push('// ---- ' + f + ' ----\n' + (await readFile(new URL(f, root), 'utf8')));
  return "(() => {\n'use strict';\n" + parts.join('\n') + '\n})();\n';
}
