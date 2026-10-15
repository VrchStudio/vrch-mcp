import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = await mkdtemp(join(tmpdir(), 'vrch-package-'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
function npm(args) {
  const result = spawnSync('npm', args, {encoding:'utf8',shell:process.platform==='win32'});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
let client;
try {
  const packed = JSON.parse(npm(['pack','--ignore-scripts','--json','--pack-destination',directory]))[0];
  for (const file of packed.files) assert(!/(^|\/)(node_modules|\.git|release|tests)(\/|$)/.test(file.path));
  const prefix = join(directory, 'installed');
  npm(['install','--prefix',prefix,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',join(directory,packed.filename)]);
  const installed = join(prefix,'node_modules',...pkg.name.split('/'),'bin','vrch-mcp.mjs');
  assert.equal(spawnSync(process.execPath,[installed,'--version'],{encoding:'utf8'}).stdout.trim(),pkg.version);
  client = new Client({name:'clean-install-check',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[installed],stderr:'pipe'}));
  assert.equal(client.getServerVersion().version,pkg.version);
  const {tools} = await client.listTools();
  assert(tools.some(tool=>tool.name==='terminal_connect'));
  assert(tools.some(tool=>tool.name==='apps_launch'));
  assert(tools.some(tool=>tool.name==='file_upload'));
  assert.equal((await client.callTool({name:'apps_list',arguments:{}})).isError,true);
  console.log(JSON.stringify({version:pkg.version,files:packed.files.length,productionDependencies:0,cleanInstall:'passed',installedSTDIO:'passed',catalogTools:tools.length}));
} finally {await client?.close();await rm(directory,{recursive:true,force:true});}
