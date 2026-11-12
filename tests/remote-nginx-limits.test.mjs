import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request, Agent} from 'node:http';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
const nginx = process.env.NGINX || '/usr/sbin/nginx';
const available = spawnSync(nginx, ['-v']).status === 0;
test('real nginx separates setup from MCP and accepts client IP only from its trusted local proxy', {skip: !available}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrch-mcp-limits-'));
  const backend = createServer((req, res) => {req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ip: req.headers['x-real-ip']}));});
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const template = readFileSync(new URL('../remote/nginx.conf.template', import.meta.url), 'utf8').replaceAll('MCP_HOST', 'mcp.test')
    .replaceAll(':18917', ':' + port).replaceAll(':18916', ':' + backend.address().port);
  writeFileSync(join(dir, 'nginx.conf'), `daemon off; master_process off; pid ${dir}/nginx.pid; error_log ${dir}/error.log error; events { worker_connections 1024; } http { client_body_temp_path ${dir}/body; ${template} }`);
  const process = spawn(nginx, ['-p', dir, '-c', join(dir, 'nginx.conf')], {stdio: 'ignore'}), exited = once(process, 'exit');
  const agent = new Agent({keepAlive: true, maxSockets: 30});
  const call = (path, ip, localAddress = '127.0.0.1') => new Promise((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port, path, localAddress, agent,
      headers: {Host: 'mcp.test', 'CF-Connecting-IP': ip, 'X-Real-IP': 'forged'}}, res => {let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({status: res.statusCode, text}));});
    req.on('error', reject); req.end();
  });
  try {
    let ready = false; for (let i = 0; i < 100; i++) {try {await call('/ready', '203.0.113.250'); ready = true; break;} catch {await new Promise(r => setTimeout(r, 20));}}
    assert(ready, 'nginx starts with the rendered configuration');
    assert.equal(JSON.parse((await call('/authorize', '203.0.113.1')).text).ip, '203.0.113.1');
    assert.equal(JSON.parse((await call('/authorize', '203.0.113.2', '127.0.0.2')).text).ip, '127.0.0.2', 'Untrusted local peers cannot forge CF client addresses');
    const busy = await Promise.all(Array.from({length: 350}, () => call('/authorize', '203.0.113.1')));
    assert(busy.some(r => r.status === 429), 'Setup retains a real rate limit');
    assert.equal((await call('/authorize', '203.0.113.3')).status, 200, 'Other client IP is independent');
    const tools = await Promise.all(Array.from({length: 350}, () => call('/synth', '203.0.113.1')));
    assert(tools.every(r => r.status === 200), 'The MCP route delegates allowance to authenticated grants, including after setup is throttled');
  } finally {agent.destroy(); process.kill('SIGTERM'); await exited; backend.closeAllConnections(); await new Promise(r => backend.close(r)); rmSync(dir, {recursive: true, force: true});}
});
