import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
const html=await readFile('public/index.html','utf8'),js=await readFile('public/app.js','utf8'),worker=await readFile('worker/index.js','utf8');
await writeFile('dist/server/index.js',`const HTML=${JSON.stringify(html)};\nconst APP_JS=${JSON.stringify(js)};\n${worker}`);
await writeFile('dist/.openai/hosting.json',await readFile('.openai/hosting.json'));
console.log('Built private Worker application');
