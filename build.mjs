import {mkdirSync,copyFileSync,existsSync} from 'node:fs';
mkdirSync('dist/server',{recursive:true});
copyFileSync('worker/index.js','dist/server/index.js');
if (existsSync('.openai/hosting.json')) {
  mkdirSync('dist/.openai',{recursive:true});
  copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
}
