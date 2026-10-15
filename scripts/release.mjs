import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=(command,args)=>{
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8'});
  if(result.status!==0)throw new Error(result.stderr||result.stdout);
  return result.stdout.trim();
};
if(run('git',['status','--porcelain']))throw new Error('Commit the reviewed source before building a release.');
run(process.execPath,['scripts/build.mjs','--check']);
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const directory=join(root,'release');await mkdir(directory,{recursive:true});
const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',directory]))[0];
const archive=`vrch-mcp-${pkg.version}.tgz`;
await rename(join(directory,packed.filename),join(directory,archive));
const copies=[
  ['dist/vrch-mcp.mjs','vrch-mcp.mjs'],
  ['dist/vrch_terminal_ai_client.mjs','vrch_terminal_ai_client.mjs'],
  ['src/file-transfer.mjs','vrch_file_transfer_client.mjs'],
  ['src/vrch_file_hash_worker.js','vrch_file_hash_worker.js'],
  ['src/vrch_pages_sha256_fallback.js','vrch_pages_sha256_fallback.js']
];
for(const [source,target]of copies)await copyFile(join(root,source),join(directory,target));
const files=[archive,...copies.map(([,name])=>name)];
const hashes={};
for(const name of files)hashes[name]=createHash('sha256').update(await readFile(join(directory,name))).digest('hex');
const receipt={name:pkg.name,version:pkg.version,tag:`v${pkg.version}`,sourceCommit:run('git',['rev-parse','HEAD']),node:pkg.engines.node,platforms:pkg.os,artifacts:hashes};
await writeFile(join(directory,'release.json'),JSON.stringify(receipt,null,2)+'\n');
hashes['release.json']=createHash('sha256').update(await readFile(join(directory,'release.json'))).digest('hex');
await writeFile(join(directory,'SHA256SUMS'),Object.entries(hashes).map(([name,hash])=>`${hash}  ${name}`).join('\n')+'\n');
console.log(JSON.stringify(receipt,null,2));
