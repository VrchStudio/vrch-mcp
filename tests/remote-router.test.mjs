import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {createAIClient} from '../src/index.mjs';
import {relay, until} from './helpers/relay.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;
const {createRemoteRouter} = supported ? await import('../src/remote-router.mjs') : {};
const identity = {issuer: 'https://mcp.example', principal: 'paired-identity', oauthClientId: 'chatgpt-client'};
async function fixture({delayPublish = false, delayCommit = false, syntheticImage = false, waitMs = 1000, ...timers} = {}) {
  const remote = await relay(), directory = mkdtempSync(join(tmpdir(), 'vrch-remote-router-'));
  remote.state.recordOperations = true;
  const remoteOrigin = new URL(remote.url).origin.replace(/^http/, 'ws');
  class DeviceSocket extends WebSocket {constructor(url) {assert.equal(new URL(url).origin, 'wss://registered.example'); super(remoteOrigin + new URL(url).pathname);}}
  const filename = join(directory, 'connections.sqlite'), key = randomBytes(32);
  const emitted = [];
  const options = {filename, credentialDirectory: join(directory, 'credentials'), encryptionKey: key, waitMs, ...timers,
    resolveRegisteredTarget: async url => {
      if (new URL(url).origin !== 'https://registered.example') throw Object.assign(Error('target_unavailable'), {code: 'target_unavailable'});
      return {origin: 'https://registered.example', deviceId: 'registered-130', WebSocketImpl: DeviceSocket};
    }, createClient: (url, args) => {
      const client = createAIClient(url, {...args, emit: event => {emitted.push(event); args.emit(event);}}), request = client.appsRequest;
      client.appsRequest = async (...values) => {
        const result = await request(...values);
        if (delayPublish && values[0] === 'publish' || delayCommit && values[0] === 'file_commit') await new Promise(resolve => setTimeout(resolve, 100));
        return result;
      };
      if(syntheticImage){
        const image={metadata:{type:'screenshot',id:'image-fixture',batchId:'batch-fixture',source:'ai',capturedAt:'2026-11-02T23:00:00Z',sha256:'a'.repeat(64),width:1,height:1},data:Buffer.from('fixture-image')};
        client.takeScreenshot=async()=>{args.emit({type:'apps_state',sequence:99});args.imageInput(image,{signal:{aborted:false}});return [image];};
        client.screenshotBatches=()=>[[image]];client.sharedScreenshots=()=>[image];
      }
      return client;
    }};
  let router = await createRemoteRouter(options), sequence = 0;
  const call = async (name, args = {}, actor = identity) => (await router.handle(actor, {jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: {name, arguments: args}})).result;
  async function connect() {
    const attemptId = randomUUID(), url = 'https://registered.example/apps/ai?invite=fixture';
    const joined = await call('terminal_connect', {url, attemptId}), reference = joined.structuredContent.connectionRef;
    assert(reference); await until(() => remote.frames.some(frame => frame.type === 'ai_join'));
    remote.approve();
    for (let i = 0; i < 100; i++) {
      if ((await call('terminal_events', {connectionRef: reference, waitSeconds: 0})).structuredContent.phase === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await call('ai_capabilities', {connectionRef: reference})).structuredContent.phase, 'ready');
    return {reference, attemptId, url};
  }
  return {remote, options, filename, directory, emitted, call, connect, get router() {return router;},
    async restart() {router.close(); router = await createRemoteRouter(options);},
    async close() {router.close(); await remote.close(); rmSync(directory, {recursive: true, force: true});}};
}

test('explicit remote references isolate identities and clients, keep attempt retries stable and never guess a device', {skip: !supported}, async () => {
  const f = await fixture();
  try {
    const {reference, attemptId, url} = await f.connect();
    const tools = f.router.catalog;
    const caps = await f.call('ai_capabilities', {connectionRef:reference});
    assert.equal(caps.structuredContent.capabilities.terminal, false);
    assert.equal(JSON.parse(caps.content[0].text).terminal, false);
    assert.deepEqual(JSON.parse(caps.content[0].text).files, []);
    assert(caps.structuredContent.capabilities.instructions.includes('apps_write_text'));
    const guide = await f.call('apps_sdk_reference', {connectionRef:reference});
    assert(guide.structuredContent.result.text.includes('VrchApp.controls.onEvent'));
    assert(guide.structuredContent.result.text.includes('expectedVersion:old.version'));
    const badConnect = await f.call('terminal_connect');
    assert.equal(badConnect.structuredContent.code, 'invalid_connection_arguments');
    assert(badConnect.structuredContent.message.includes('attemptId'));
    for (const name of ['apps_file_export','apps_file_commit','apps_export_begin','apps_import_inspect','apps_import_commit']) assert(!tools.some(tool=>tool.name===name));

    assert(tools.find(tool => tool.name === 'apps_save').inputSchema.required.includes('operationId'));
    assert(tools.find(tool => tool.name === 'apps_state').inputSchema.required.includes('connectionRef'));
    assert(!tools.some(tool => tool.name === 'file_upload'), 'Local filesystem paths are not exposed by this hosted slice.');
    for (const name of ['terminal_input', 'terminal_run_private', 'terminal_cancel_private_input']) {
      assert(!tools.some(tool => tool.name === name));
      assert.equal((await f.call(name, {connectionRef: reference, data: 'pwd\n'})).structuredContent.code, 'unsupported_tool');
    }
    f.remote.output('private-terminal-history-fixture');
    await until(() => f.emitted.some(event => event.type === 'data' && event.data.includes('private-terminal-history-fixture')));
    assert(!JSON.stringify(await f.call('terminal_events', {connectionRef: reference, waitSeconds: 0})).includes('private-terminal-history-fixture'));
    const repeated = await f.call('terminal_connect', {url, attemptId});
    assert.equal(repeated.structuredContent.connectionRef, reference);
    assert.equal(f.remote.frames.filter(frame => frame.type === 'ai_join').length, 1);
    assert.equal((await f.call('terminal_connect', {url: url + '-changed', attemptId})).structuredContent.code, 'attempt_conflict');
    assert.equal((await f.call('apps_state')).structuredContent.code, 'connection_required');
    for (const actor of [{...identity, principal: 'another-person'}, {...identity, oauthClientId: 'another-client'}])
      assert.equal((await f.call('apps_state', {connectionRef: reference}, actor)).structuredContent.code, 'context_mismatch');
    assert.equal((await f.call('terminal_events', {connectionRef: reference, waitSeconds: 21})).structuredContent.code, 'invalid_wait');
    assert.equal((await f.call('apps_state', {connectionRef: reference})).structuredContent.phase, 'succeeded');
    assert(!readFileSync(f.filename).includes(Buffer.from('invite=fixture')));
    assert(!readFileSync(f.filename).includes(Buffer.from('fixture-secret')));
  } finally {await f.close();}
});

test('recoverable edits are journaled before send, same IDs query results and changed arguments conflict', {skip: !supported}, async () => {
  const f = await fixture();
  try {
    const {reference} = await f.connect(), operationId = randomUUID();
    const args = {connectionRef: reference, operationId, workspaceId: 'workspace', expectedRevision: 'revision'};
    assert.equal((await f.call('apps_publish', {...args, operationId: undefined})).structuredContent.code, 'operation_id_required');
    assert.equal((await f.call('apps_publish', args)).structuredContent.phase, 'succeeded');
    assert.equal((await f.call('apps_publish', args)).structuredContent.phase, 'succeeded');
    assert.equal((await f.call('apps_publish', {...args, expectedRevision: 'changed'})).structuredContent.code, 'operation_conflict');
    assert.equal(f.remote.frames.filter(frame => frame.action === 'publish').length, 1);
    const query = await f.call('apps_operation_status', {connectionRef: reference, originalOperationId: operationId, originalAction: 'publish'});
    assert.equal(query.structuredContent.phase, 'succeeded');
    assert.equal((await f.call('apps_operation_status', {connectionRef: reference, originalOperationId: operationId, originalAction: 'save'})).structuredContent.code, 'operation_conflict');
  } finally {await f.close();}
});

test('lost response and server restart preserve original operation IDs without replay; explicit resume queries the device', {skip: !supported}, async () => {
  const f = await fixture({delayPublish: true, waitMs: 5});
  try {
    const {reference} = await f.connect(), operationId = randomUUID();
    const args = {connectionRef: reference, operationId, workspaceId: 'workspace', expectedRevision: 'revision'};
    assert.equal((await f.call('apps_publish', args)).structuredContent.phase, 'pending');
    await until(() => f.remote.frames.some(frame => frame.action === 'publish'));
    await f.restart();
    assert.equal((await f.call('terminal_events', {connectionRef: reference})).structuredContent.phase, 'disconnected');
    assert.equal((await f.call('terminal_events', {connectionRef: reference})).structuredContent.code, 'service_restarted');
    assert.equal((await f.call('apps_state', {connectionRef: reference})).structuredContent.code, 'disconnected');
    await f.call('terminal_connect', {connectionRef: reference, resume: true});
    await until(() => f.remote.frames.some(frame => frame.type === 'ai_resume'));
    for (let i = 0; i < 100; i++) {
      if ((await f.call('terminal_events', {connectionRef: reference, waitSeconds: 0})).structuredContent.phase === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await f.call('apps_publish', args)).structuredContent.phase, 'outcome_unknown');
    const status = await f.call('apps_operation_status', {connectionRef: reference, originalOperationId: operationId, originalAction: 'publish'});
    assert.equal(status.structuredContent.phase, 'succeeded');
    assert.equal(status.structuredContent.result.operationId, operationId);
    assert.equal(f.remote.frames.filter(frame => frame.action === 'publish').length, 1);
    const unknown = await f.call('apps_operation_status', {connectionRef: reference, originalOperationId: randomUUID(), originalAction: 'publish'});
    assert.equal(unknown.structuredContent.phase, 'outcome_unknown');
    await new Promise(resolve => setTimeout(resolve, 110));
  } finally {await f.close();}
});


test('unknown invitation deadlines have a fixed wait/drain bound and repeated polls cannot revive the attempt', {skip: !supported}, async () => {
  const f = await fixture({pendingWaitMs: 50, resultDrainMs: 30});
  try {
    const args = {url: 'https://registered.example/apps/ai?invite=fixture', attemptId: randomUUID()};
    const reference = (await f.call('terminal_connect', args)).structuredContent.connectionRef;
    await until(() => f.remote.frames.some(frame => frame.type === 'ai_join'));
    let observed;
    for (let i = 0; i < 40; i++) {
      observed = (await f.call('terminal_events', {connectionRef: reference, waitSeconds: 0})).structuredContent;
      if (observed.phase === 'request_disconnected') break;
      if (observed.phase === 'pending') assert.equal(observed.deadlineKnown, false);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(observed.phase, 'request_disconnected'); assert.equal(observed.authorizationOutcome, 'unknown');
    assert.equal((await f.call('terminal_connect', args)).structuredContent.phase, 'request_disconnected');
    assert.equal(f.remote.frames.filter(frame => frame.type === 'ai_join').length, 1);
    assert(!f.remote.frames.some(frame => frame.type === 'ai_remove'));
  } finally {await f.close();}
});

test('approval received during bounded result drain is saved and remains ready', {skip: !supported}, async () => {
  const f = await fixture({pendingWaitMs: 100, resultDrainMs: 200});
  try {
    const reference = (await f.call('terminal_connect', {url: 'https://registered.example/apps/ai?invite=fixture', attemptId: randomUUID()})).structuredContent.connectionRef;
    await until(() => f.remote.frames.some(frame => frame.type === 'ai_join'));
    await new Promise(resolve => setTimeout(resolve, 150)); f.remote.approve();
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal((await f.call('terminal_events', {connectionRef: reference, waitSeconds: 0})).structuredContent.phase, 'ready');
  } finally {await f.close();}
});

test('idle cleanup waits for an in-flight edit and keeps its durable result for explicit resume', {skip: !supported}, async () => {
  const f = await fixture({delayPublish: true, waitMs: 5, idleMs: 60});
  try {
    const {reference} = await f.connect(), operationId = randomUUID();
    assert.equal((await f.call('apps_publish', {connectionRef: reference, operationId, workspaceId: 'workspace', expectedRevision: 'revision'})).structuredContent.phase, 'pending');
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal((await f.call('terminal_events', {connectionRef: reference})).structuredContent.phase, 'disconnected');
    assert.equal((await f.call('terminal_events', {connectionRef: reference})).structuredContent.code, 'idle_timeout');
    await f.call('terminal_connect', {connectionRef: reference, resume: true});
    await until(() => f.remote.frames.some(frame => frame.type === 'ai_resume'));
    await new Promise(resolve => setTimeout(resolve, 10));
    const status = await f.call('apps_operation_status', {connectionRef: reference, originalOperationId: operationId, originalAction: 'publish'});
    assert.equal(status.structuredContent.phase, 'succeeded');
    assert.equal(f.remote.frames.filter(frame => frame.action === 'publish').length, 1);
  } finally {await f.close();}
});


const fileSHA = value => createHash('sha256').update(value).digest('hex');
test('hosted text editing uses real File V2, atomic workspace commit and conflict-safe operation IDs without a shell', {skip: !supported}, async () => {
  const f = await fixture(), workspaceId = randomUUID(), initial = '\ufeff<h1>节拍器</h1>\n';
  f.remote.state.workspaceId = workspaceId; f.remote.state.workspaceFiles = {'index.html': Buffer.from(initial)};
  try {
    const {reference} = await f.connect(), base = {connectionRef: reference, workspaceId, path:'index.html'};
    const read = await f.call('apps_read_text', base);
    assert.equal(read.structuredContent.phase, 'succeeded'); assert.equal(read.structuredContent.result.text, initial);
    assert.equal(read.structuredContent.result.sha256, fileSHA(initial));
    const parallel = await Promise.all(Array.from({length:3},()=>f.call('apps_read_text',base)));
    assert(parallel.every(result=>!result.isError&&result.structuredContent.result.text===initial));
    const operationId = randomUUID(), next = '<h1>Updated</h1>\n';
    const write = {...base, operationId, expectedSha256:fileSHA(initial), content:next};
    assert.equal((await f.call('apps_write_text', write)).structuredContent.phase, 'succeeded');
    assert.equal(f.remote.state.workspaceFiles['index.html'].toString(), next);
    assert.equal((await f.call('apps_write_text', write)).structuredContent.phase, 'succeeded');
    assert.equal(f.remote.frames.filter(value=>value.action==='file_commit').length, 1);
    assert.equal((await f.call('apps_write_text', {...write, content:'changed intent'})).structuredContent.code, 'operation_conflict');
    assert.equal((await f.call('apps_write_text', {...write, operationId:randomUUID()})).structuredContent.code, 'file_conflict');
    assert.equal(f.remote.state.workspaceFiles['index.html'].toString(), next);
    assert.equal((await f.call('apps_write_text', {...base, path:'new.js', operationId:randomUUID(), expectedSha256:null, content:''})).structuredContent.phase, 'succeeded');
    assert.equal((await f.call('apps_read_text', {...base, path:'new.js'})).structuredContent.result.text, '');
    assert(!f.remote.frames.some(value=>value.type==='input'||['publish','save','launch'].includes(value.action)));
    assert.deepEqual(readdirSync(join(f.directory,'workspace-transfers')), []);
    assert(!readFileSync(f.filename).includes(Buffer.from(next)));
    assert(!JSON.stringify(read).includes(f.directory));
  } finally {await f.close();}
});

test('text tools reject wrong workspace/path/size and withhold downloaded source when payload access is removed', {skip: !supported}, async () => {
  const f = await fixture(), workspaceId = randomUUID();
  f.remote.state.workspaceId = workspaceId; f.remote.state.workspaceFiles = {'secret.txt':Buffer.from('retained-private-source'),'big.txt':Buffer.alloc(65537)};
  try {
    const {reference} = await f.connect(), base={connectionRef:reference,workspaceId,path:'secret.txt'};
    for (const path of ['/etc/passwd','../outside','a/../b','a//b','a\\b','a\0b'])
      assert.equal((await f.call('apps_read_text',{...base,path})).structuredContent.code,'invalid_workspace_path');
    assert.equal((await f.call('apps_read_text',{...base,workspaceId:randomUUID()})).structuredContent.code,'workspace_conflict');
    assert.equal((await f.call('apps_read_text',{...base,path:'big.txt'})).structuredContent.code,'workspace_text_too_large');
    assert.equal((await f.call('apps_write_text',{...base,operationId:randomUUID(),expectedSha256:null,content:'x'.repeat(65537)})).structuredContent.code,'invalid_workspace_text');
    f.remote.state.privateAfterDownload = true;
    const withheld = await f.call('apps_read_text',base);
    assert.equal(withheld.structuredContent.code,'private_input');
    assert(!JSON.stringify(withheld).includes('retained-private-source'));
    assert.deepEqual(readdirSync(join(f.directory,'workspace-transfers')),[]);
  } finally {await f.close();}
});

test('a lost text commit response is queried after restart without uploading or committing again', {skip: !supported}, async () => {
  const f = await fixture({delayCommit:true,waitMs:5}), workspaceId=randomUUID();
  f.remote.state.workspaceId=workspaceId;f.remote.state.workspaceFiles={};
  try {
    const {reference}=await f.connect(), operationId=randomUUID(), args={connectionRef:reference,workspaceId,path:'index.html',expectedSha256:null,content:'<h1>Retained</h1>',operationId};
    assert.equal((await f.call('apps_write_text',args)).structuredContent.phase,'pending');
    await until(()=>f.remote.frames.some(value=>value.action==='file_commit'));
    await f.restart();
    await f.call('terminal_connect',{connectionRef:reference,resume:true});
    for(let i=0;i<100;i++){if((await f.call('terminal_events',{connectionRef:reference,waitSeconds:0})).structuredContent.phase==='ready')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal((await f.call('apps_write_text',args)).structuredContent.phase,'outcome_unknown');
    const status=await f.call('apps_operation_status',{connectionRef:reference,originalOperationId:operationId,originalAction:'write_text'});
    assert.equal(status.structuredContent.phase,'succeeded');
    assert.equal(status.structuredContent.result.result.sha256,fileSHA(args.content));
    assert.equal(f.remote.frames.filter(value=>value.action==='file_commit').length,1);
    assert.equal(f.remote.frames.filter(value=>value.type==='file_begin'&&value.direction==='upload').length,1);
    assert.equal(f.remote.state.workspaceFiles['index.html'].toString(),args.content);
    await new Promise(resolve=>setTimeout(resolve,110));
  } finally {await f.close();}
});

test('a new invitation always waits for approval; fast approval retains pending evidence and clears its deadline timer', {skip: !supported}, async () => {
  const f = await fixture({pendingWaitMs:50,resultDrainMs:100});
  try {
    const reference=(await f.call('terminal_connect',{url:'https://registered.example/apps/ai?invite=fixture',attemptId:randomUUID()})).structuredContent.connectionRef;
    await until(()=>f.remote.frames.some(frame=>frame.type==='ai_join'));
    assert.equal((await f.call('apps_state',{connectionRef:reference})).structuredContent.code,'approval_required');
    f.remote.approve();
    await until(()=>f.emitted.some(event=>event.type==='collaboration'));
    const events=await f.call('terminal_events',{connectionRef:reference,waitSeconds:0});
    assert.equal(events.structuredContent.phase,'ready');
    const types=events.structuredContent.events.map(item=>item.type);
    assert(types.indexOf('ai_pending')>=0 && types.indexOf('ai_approved')>types.indexOf('ai_pending'));
    await new Promise(resolve=>setTimeout(resolve,170));
    assert.equal((await f.call('apps_state',{connectionRef:reference})).structuredContent.phase,'succeeded');
  } finally {await f.close();}
});

test('hosted parallel control tools keep complete gestures ordered and do not resume queued input after ownership changes', {skip:!supported},async()=>{
 const f=await fixture();
 try{
  const {reference}=await f.connect(),base={connectionRef:reference,target:'device',instanceId:'fixture-instance',generation:1};
  await Promise.all([
   f.call('apps_control',{...base,control:'K2',type:'click',holdMs:40}),
   f.call('apps_control',{...base,control:'E1',type:'rotate',delta:4}),
   f.call('apps_control',{...base,control:'K3',type:'click',holdMs:0})
  ]);
  const frames=f.remote.frames.filter(v=>v.action==='control_input').map(v=>v.args.event);
  assert.deepEqual(frames.map(v=>v.control+':'+v.type),['K2:down','K2:up','E1:rotate','K3:down','K3:up']);
  const first=f.call('apps_control',{...base,control:'K2',type:'click',holdMs:60});
  const queued=f.call('apps_control',{...base,control:'E4',type:'rotate',delta:3});
  await until(()=>f.remote.frames.filter(v=>v.action==='control_input').length===6);
  f.remote.update({owner:'human',epoch:2});
  await first;const refused=await queued;assert.equal(refused.structuredContent.code,'control_changed');
  assert(!f.remote.frames.some(v=>v.action==='control_input'&&v.args.event.control==='E4'));
 }finally{await f.close();}
});

test('structured-only consumers receive complete bounded source and SDK text without duplicating the body', {skip:!supported},async()=>{
 const f=await fixture(),workspaceId=randomUUID(),body='\"\\'.repeat(32768);
 f.remote.state.workspaceId=workspaceId;f.remote.state.workspaceFiles={'index.html':Buffer.from(body)};
 try{
  const {reference}=await f.connect();
  const read=await f.call('apps_read_text',{connectionRef:reference,workspaceId,path:'index.html'});
  assert.equal(read.structuredContent.result.text,body);
  assert(JSON.stringify(read).length<150000);
  assert(!read.content.some(v=>v.text===body));
  const guide=await f.call('apps_sdk_reference',{connectionRef:reference});
  assert(guide.structuredContent.result.text.includes('VrchApp.ready()'));
 }finally{await f.close();}
});

test('structured screenshot metadata survives an unrelated state event before the image', {skip:!supported},async()=>{
 const f=await fixture({syntheticImage:true});
 try{
  const {reference}=await f.connect();const result=await f.call('take_screenshot',{connectionRef:reference});
  assert.equal(result.structuredContent.result.images[0].capturedAt,'2026-11-02T23:00:00Z');
  assert.equal(result.structuredContent.result.images[0].sha256,'a'.repeat(64));
  assert(result.structuredContent.result.events.some(event=>event.type==='apps_state'));
  assert.equal(result.content.filter(item=>item.type==='image').length,1);
 }finally{await f.close();}
});
