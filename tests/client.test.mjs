import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAIClient } from '../src/index.mjs';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || (major === 22 && minor >= 4);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await pause(10);
  }
  assert.fail('Expected client event was not received');
}

test('unsupported native runtime refuses before consuming an invitation', { skip: supported }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  let connections = 0;
  server.on('connection', () => { connections++; });
  try {
    assert.throws(() => createAIClient(`http://127.0.0.1:${server.address().port}/recovery/ai?invite=unused`), /Node.js 22.4/);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/vrch-mcp.mjs', import.meta.url))], { encoding: 'utf8', input: '' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Node.js 22.4 or later is required/);
    assert(!cli.stderr.includes('Invitation URL:'));
    await pause(30);
    assert.equal(connections, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('native WebSocket preserves approval, output and resume across heartbeats', { skip: !supported }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const events = [], frames = [], sockets = [];
  const credential = 'fixture-terminal-only-credential-aaaaaaaaaaaaaaaa';
  const output = Buffer.from('NATIVE_HEARTBEAT_OUTPUT \u03b1\r\n');
  const state = (owner, epoch) => ({ type: 'collaboration', owner, epoch, private: false, passwordRequired: false });
  let socket, resumed = false, client;
  server.on('connection', peer => {
    socket = peer; sockets.push(peer);
    peer.on('message', raw => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === 'ai_join') {
        peer.send(JSON.stringify({ type: 'ai_pending' }));
        // Ordinary relay pings may arrive while a person considers Allow AI.
        peer.ping();
        peer.send(JSON.stringify({ type: 'ai_approved', requestId: 'fixture-request', credential, leaseExpiresAt: Date.now() + 60000, scopes: ['terminal'] }));
        peer.send(JSON.stringify(state('human', 2)));
        peer.send(JSON.stringify({ type: 'ready', streamId: 'fixture-stream', outputStart: 0 }));
      } else if (frame.type === 'input') {
        peer.ping();
        peer.send(JSON.stringify({ type: 'output', streamId: 'fixture-stream', offset: 0, length: output.length }));
        peer.send(output.subarray(0, 8), { fin: false });
        peer.ping();
        peer.send(output.subarray(8), { fin: true });
      } else if (frame.type === 'ai_resume') {
        resumed = true;
        peer.ping();
        peer.send(JSON.stringify({ type: 'ai_resumed', leaseExpiresAt: Date.now() + 60000 }));
        peer.send(JSON.stringify(state('human', 4)));
        peer.send(JSON.stringify({ type: 'ready', streamId: 'fixture-stream', outputStart: output.length }));
      }
    });
  });
  try {
    // Intentionally use the native default: no injected WebSocket implementation.
    client = createAIClient(`http://127.0.0.1:${server.address().port}/recovery/ai?invite=fixture`, { sessionFile: false, emit: event => events.push(event), delay: 10 });
    await until(() => events.some(event => event.type === 'ready'));
    assert(events.some(event => event.type === 'ai_approved'));
    assert.equal(client.input('pwd\n'), false);
    assert.equal(frames.filter(frame => frame.type === 'input').length, 0);
    socket.send(JSON.stringify(state('ai', 3)));
    await until(() => events.some(event => event.type === 'collaboration' && event.epoch === 3));
    assert.equal(client.input('pwd\n'), true);
    await until(() => events.some(event => event.type === 'data'));
    assert.equal(events.filter(event => event.type === 'data').map(event => event.data).join(''), output.toString());
    assert.deepEqual(frames.find(frame => frame.type === 'input'), { type: 'input', epoch: 3, data: 'pwd\n' });
    socket.terminate();
    await until(() => resumed && events.some(event => event.type === 'collaboration' && event.epoch === 4));
    assert.deepEqual(frames.find(frame => frame.type === 'ai_resume'), { type: 'ai_resume', protocol: 'vrch-terminal-assist-v1', requestId: 'fixture-request', credential, outputOffset: output.length });
    assert.equal(client.input('uptime\n'), false, 'Human takeover remains authoritative after reconnect');
    socket.send(JSON.stringify({ type: 'error', code: 'ai_removed' }));
    await until(() => events.some(event => event.type === 'ended' && event.code === 'ai_removed'));
    assert.equal(client.input('pwd\n'), false);
    assert(!JSON.stringify(events).includes(credential));
  } finally {
    client?.close();
    for (const peer of sockets) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a killed client resumes its saved identity; human takeover, busy, removal and expiry remain authoritative', { skip: !supported }, async () => {
  const { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync, symlinkSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const directory = mkdtempSync(join(tmpdir(), 'vrch-ai-resume-'));
  const sessionFile = join(directory, 'session.json');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credential = 'fixture-resume-credential-aaaaaaaaaaaaaaaaaaaaaaaa';
  const frames = [], sockets = [], events = [];
  let owner = 'ai', busy = true, peer, child, client, childOutput = '';
  server.on('connection', socket => {
    peer = socket; sockets.push(socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === 'ai_join') socket.send(JSON.stringify({ type: 'ai_approved', requestId: 'saved-request', credential, leaseExpiresAt: Date.now() + 60000 }));
      else if (frame.type === 'ai_resume') {
        assert.equal(frame.credential, credential);
        assert.equal(frame.requestId, 'saved-request');
        if (busy) { busy = false; socket.send(JSON.stringify({ type: 'error', code: 'ai_resume_busy' })); return; }
        socket.send(JSON.stringify({ type: 'ai_resumed', leaseExpiresAt: Date.now() + 60000 }));
      }
      socket.send(JSON.stringify({ type: 'collaboration', owner, epoch: 4, private: false, passwordRequired: false }));
      socket.send(JSON.stringify({ type: 'ready', streamId: 'same-stream', outputStart: 0 }));
    });
  });
  try {
    const module = new URL('../src/index.mjs', import.meta.url).href;
    const program = `import {createAIClient} from ${JSON.stringify(module)}; createAIClient(${JSON.stringify(origin + '/recovery/ai?invite=fixture')},{sessionFile:${JSON.stringify(sessionFile)}});`;
    child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { childOutput += data; });
    await until(() => childOutput.includes('"ready"'));
    const record = JSON.parse(readFileSync(sessionFile));
    assert.equal(record.credential, credential);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
    assert(!childOutput.includes(credential));
    assert(!readFileSync(sessionFile, 'utf8').includes('invite'));
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    owner = 'human';
    client = createAIClient(origin, { resume: true, sessionFile, emit: event => events.push(event), delay: 10 });
    await until(() => events.some(event => event.type === 'ready'));
    assert.equal(frames.filter(frame => frame.type === 'ai_join').length, 1);
    assert.equal(frames.filter(frame => frame.type === 'ai_resume').length, 2, 'busy old attachment is retried without consuming a new invite');
    assert.equal(client.input('pwd\n'), false, 'restart must preserve human takeover');
    peer.send(JSON.stringify({ type: 'collaboration', owner: 'ai', epoch: 5, private: false, passwordRequired: false }));
    await until(() => events.some(event => event.epoch === 5));
    assert.equal(client.input('pwd\n'), true);
    client.close();
    assert(existsSync(sessionFile), 'ordinary detach retains the saved identity');
    events.length = 0;
    client = createAIClient(origin, { resume: true, sessionFile, emit: event => events.push(event), delay: 10 });
    await until(() => events.some(event => event.type === 'ready'));
    peer.send(JSON.stringify({ type: 'error', code: 'ai_removed' }));
    await until(() => events.some(event => event.type === 'ended'));
    assert(!existsSync(sessionFile), 'removal clears the resume record');
    const connectionCount = sockets.length;
    writeFileSync(sessionFile, JSON.stringify({ ...record, expires: Date.now() - 1 }), { mode: 0o600 });
    createAIClient(origin, { resume: true, sessionFile, emit: event => events.push(event) });
    assert(!existsSync(sessionFile));
    assert.equal(sockets.length, connectionCount, 'expired access must not reconnect');
    writeFileSync(sessionFile, JSON.stringify(record), { mode: 0o600 });
    chmodSync(sessionFile, 0o644);
    assert.throws(() => createAIClient(origin, { resume: true, sessionFile }), /0600/);
    chmodSync(sessionFile, 0o600);
    writeFileSync(sessionFile, 'invalid ' + credential);
    assert.throws(() => createAIClient(origin, { resume: true, sessionFile }), error => error.message === 'Invalid resume record.');
    rmSync(sessionFile);
    symlinkSync(join(directory, 'outside'), sessionFile);
    assert.throws(() => createAIClient(origin, { resume: true, sessionFile }), /0600/);
    assert(!JSON.stringify(events).includes(credential));
  } finally {
    client?.close();
    if (child?.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});


test('bounded file upload keeps native WebSocket heartbeats responsive on a slow link', { skip: !supported }, async () => {
  const { default: net } = await import('node:net');
  const { Transform } = await import('node:stream');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { randomBytes, createHash } = await import('node:crypto');
  const temp=await mkdtemp('/tmp/vrch-heartbeat-window-'),source=temp+'/fixture.bin',data=randomBytes(1024*1024);
  await writeFile(source,data);
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  const pipes=[],peers=[];let heartbeatLost=false,client,pingCount=0,pongCount=0;
  let fail;const failed=new Promise((_,reject)=>{fail=reject;});failed.catch(()=>{});
  server.on('connection',ws=>{
   peers.push(ws);let spec,received=[],offset=0,pingAt=0;
   const pulse=setInterval(()=>{if(pingAt){if(Date.now()-pingAt>3000){heartbeatLost=true;fail(Error('heartbeat timeout while file bytes are queued'));ws.terminate();}}else{pingAt=Date.now();pingCount++;ws.ping();}},200);
   ws.on('pong',()=>{pongCount++;pingAt=0;});ws.on('close',()=>clearInterval(pulse));
   ws.on('message',(raw,binary)=>{
    if(binary){received.push(raw.subarray(40));offset+=raw.length-40;ws.send(JSON.stringify({type:'file_ack',id:spec.id,epoch:3,offset}));return;}
    const m=JSON.parse(raw);
    if(m.type==='ai_join'){
     ws.send(JSON.stringify({type:'ai_approved',credential:'fixture-credential-aaaaaaaaaaaaaaaaaaaaaa',requestId:'fixture',leaseExpiresAt:Date.now()+60000}));
     ws.send(JSON.stringify({type:'collaboration',owner:'ai',epoch:3,private:false,passwordRequired:false,fileTransfer:'vrch-file-v1'}));
     ws.send(JSON.stringify({type:'ready',streamId:'fixture',outputStart:0}));
    }else if(m.type==='file_begin'){
     spec=m;ws.send(JSON.stringify({type:'file_ready',id:m.id,epoch:3,offset:0,prefixSHA256:createHash('sha256').digest('hex'),chunkBytes:60*1024}));
    }else if(m.type==='file_finish'){
     assert.deepEqual(Buffer.concat(received),data);ws.send(JSON.stringify({type:'file_done',id:spec.id,epoch:3,name:spec.name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
    }
   });
  });
  const proxy=net.createServer(down=>{
   const up=net.connect(server.address().port,'127.0.0.1');pipes.push(down,up);
   const throttle=new Transform({transform(chunk,encoding,callback){setTimeout(()=>callback(null,chunk),Math.ceil(chunk.length/(150*1024)*1000));}});
   down.pipe(throttle).pipe(up);up.pipe(down);
   down.on('error',()=>up.destroy());up.on('error',()=>down.destroy());down.on('close',()=>up.destroy());up.on('close',()=>down.destroy());
  });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  try{
   await new Promise(resolve=>{client=createAIClient(`http://127.0.0.1:${proxy.address().port}/recovery/ai?invite=fixture`,{sessionFile:false,emit:e=>{if(e.type==='ready')resolve();}});});
   await Promise.race([client.putFile(source),failed]);assert(!heartbeatLost);assert(pongCount>1);
   assert.equal(heartbeatLost,false);
  }finally{client?.close();for(const s of pipes)s.destroy();for(const ws of peers)ws.terminate();await new Promise(r=>proxy.close(r));await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}

});

test('Recovery and Apps use separate sockets and persistent credentials on the same host', {skip: !supported}, async () => {
  const {mkdtempSync, readdirSync, readFileSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'vrch-ai-channels-'));
  const previous = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = directory;
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve=>server.once('listening',resolve));
  const sockets=[], frames=[], events={terminal:[],apps:[]}; let recovery,apps;
  const origin=`http://127.0.0.1:${server.address().port}`;
  server.on('connection',(peer,request)=>{
    const channel=request.url==='/vrch-ws/apps-terminal-assist'?'apps':'terminal';
    assert.equal(request.url,channel==='apps'?'/vrch-ws/apps-terminal-assist':'/vrch-ws/terminal-assist');
    sockets.push(peer);
    peer.on('message',raw=>{
      const frame=JSON.parse(raw); frames.push({channel,...frame});
      if(frame.type==='ai_join'||frame.type==='ai_resume') {
        if(frame.type==='ai_resume') assert.equal(frame.credential,channel+'-fixture-credential');
        else peer.send(JSON.stringify({type:'ai_approved',requestId:channel,credential:channel+'-fixture-credential',leaseExpiresAt:Date.now()+60000}));
        peer.send(JSON.stringify({type:'collaboration',owner:'ai',epoch:channel==='apps'?4:2,private:false,passwordRequired:false}));
        peer.send(JSON.stringify({type:'ready',streamId:channel,outputStart:0}));
      }
    });
  });
  const options=channel=>({emit:event=>events[channel].push(event)});
  try {
    recovery=createAIClient(origin+'/?invite=recovery',options('terminal'));
    apps=createAIClient(origin+'/apps/ai?invite=apps',options('apps'));
    await until(()=>events.terminal.some(e=>e.type==='ready')&&events.apps.some(e=>e.type==='ready'));
    const files=readdirSync(join(directory,'vrch-terminal-ai'));
    assert.equal(files.length,2);
    const records=files.map(name=>JSON.parse(readFileSync(join(directory,'vrch-terminal-ai',name),'utf8')));
    assert.deepEqual(new Set(records.map(r=>r.purpose)),new Set(['terminal','apps']));
    const terminalFile=join(directory,'vrch-terminal-ai',files[records.findIndex(r=>r.purpose==='terminal')]);
    assert.throws(()=>createAIClient(origin+'/?channel=apps',{resume:true,sessionFile:terminalFile}),/Invalid resume record/);
    apps.close(); apps=null;
    assert(recovery.input('recovery-still-active\n'));
    await until(()=>frames.some(f=>f.channel==='terminal'&&f.data==='recovery-still-active\n'));
    recovery.close(); recovery=null;
    events.terminal=[]; events.apps=[];
    recovery=createAIClient(origin,{...options('terminal'),resume:true});
    apps=createAIClient(origin+'/recovery/ai?channel=apps',{...options('apps'),resume:true});
    await until(()=>events.terminal.some(e=>e.type==='ready')&&events.apps.some(e=>e.type==='ready'));
    assert.equal(frames.filter(f=>f.type==='ai_resume').length,2);
    apps.close();apps=null;events.apps=[];
    apps=createAIClient(origin+'/apps/ai',{...options('apps'),resume:true});
    await until(()=>events.apps.some(e=>e.type==='ready'));
    assert.equal(frames.filter(f=>f.type==='ai_resume'&&f.channel==='apps').length,2);
    apps.forget(); apps=null;
    assert.equal(readdirSync(join(directory,'vrch-terminal-ai')).length,1);
    assert(recovery.input('after-apps-forgotten\n'));
    await until(()=>frames.some(f=>f.data==='after-apps-forgotten\n'));
  } finally {
    recovery?.close();apps?.close();for(const peer of sockets)peer.terminate();
    await new Promise(resolve=>server.close(resolve));
    if(previous===undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME=previous;
    rmSync(directory,{recursive:true,force:true});
  }
});

test('native resume retries HTTP 503 during a host restart without another invitation', {skip: !supported}, async () => {
  const {createServer} = await import('node:http');
  const server = createServer();
  const sockets = new WebSocketServer({noServer: true});
  let unavailable = false, rejected = 0, peer, client;
  const events = [], frames = [];
  const leaseExpiresAt = Date.now() + 60000;
  const credential = 'fixture-reboot-only-credential';
  server.on('upgrade', (request, socket, head) => {
    if (unavailable && rejected++ < 3) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      const frame = JSON.parse(raw); frames.push(frame);
      if (frame.type === 'ai_join') {
        socket.send(JSON.stringify({type: 'ai_approved', credential, requestId: 'fixture-reboot', leaseExpiresAt}));
      } else if (frame.type === 'ai_resume') {
        assert.equal(frame.credential, credential);
        socket.send(JSON.stringify({type: 'ai_resumed', leaseExpiresAt, newShell: true}));
      } else return;
      socket.send(JSON.stringify({type: 'collaboration', owner: 'ai', epoch: 2, private: false, passwordRequired: false}));
      socket.send(JSON.stringify({type: 'ready', streamId: unavailable ? 'new-shell' : 'old-shell', outputStart: 0}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    client = createAIClient(`http://127.0.0.1:${server.address().port}/recovery/ai?invite=fixture`, {
      sessionFile: false, delay: 10, emit: event => events.push(event)
    });
    await until(() => events.some(event => event.type === 'ready'));
    unavailable = true;
    peer.terminate();
    await until(() => events.some(event => event.type === 'ready' && event.streamId === 'new-shell'));
    assert.equal(frames.filter(frame => frame.type === 'ai_join').length, 1);
    assert.equal(frames.filter(frame => frame.type === 'ai_resume').length, 1);
    assert.equal(events.filter(event => event.type === 'reconnecting').length, 4);
    assert.equal(events.find(event => event.type === 'ai_resumed').leaseExpiresAt, leaseExpiresAt);
    assert.equal(client.input('hostname\n'), true);
    await until(() => frames.some(frame => frame.type === 'input'));
    assert(!JSON.stringify(events).includes(credential));
  } finally {
    client?.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
