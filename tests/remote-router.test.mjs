import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {createAIClient} from '../src/index.mjs';
import {relay, until} from './helpers/relay.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;
const {createRemoteRouter} = supported ? await import('../src/remote-router.mjs') : {};
const identity = {issuer: 'https://mcp.example', principal: 'paired-identity', oauthClientId: 'chatgpt-client'};
async function fixture({delayPublish = false, waitMs = 1000, ...timers} = {}) {
  const remote = await relay(), directory = mkdtempSync(join(tmpdir(), 'vrch-remote-router-'));
  remote.state.recordOperations = true;
  const remoteOrigin = new URL(remote.url).origin.replace(/^http/, 'ws');
  class DeviceSocket extends WebSocket {constructor(url) {assert.equal(new URL(url).origin, 'wss://registered.example'); super(remoteOrigin + new URL(url).pathname);}}
  const filename = join(directory, 'connections.sqlite'), key = randomBytes(32);
  const options = {filename, credentialDirectory: join(directory, 'credentials'), encryptionKey: key, waitMs, ...timers,
    resolveRegisteredTarget: async url => {
      if (new URL(url).origin !== 'https://registered.example') throw Object.assign(Error('target_unavailable'), {code: 'target_unavailable'});
      return {origin: 'https://registered.example', deviceId: 'registered-130', WebSocketImpl: DeviceSocket};
    }, createClient: (url, args) => {
      const client = createAIClient(url, args), request = client.appsRequest;
      client.appsRequest = async (...values) => {
        const result = await request(...values);
        if (delayPublish && values[0] === 'publish') await new Promise(resolve => setTimeout(resolve, 100));
        return result;
      }; return client;
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
  return {remote, options, filename, directory, call, connect, get router() {return router;},
    async restart() {router.close(); router = await createRemoteRouter(options);},
    async close() {router.close(); await remote.close(); rmSync(directory, {recursive: true, force: true});}};
}

test('explicit remote references isolate identities and clients, keep attempt retries stable and never guess a device', {skip: !supported}, async () => {
  const f = await fixture();
  try {
    const {reference, attemptId, url} = await f.connect();
    const tools = f.router.catalog;
    assert(tools.find(tool => tool.name === 'apps_save').inputSchema.required.includes('operationId'));
    assert(tools.find(tool => tool.name === 'apps_state').inputSchema.required.includes('connectionRef'));
    assert(!tools.some(tool => tool.name === 'file_upload'), 'Local filesystem paths are not exposed by this hosted slice.');
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
    await f.call('terminal_connect', {connectionRef: reference, resume: true});
    await until(() => f.remote.frames.some(frame => frame.type === 'ai_resume'));
    await new Promise(resolve => setTimeout(resolve, 10));
    const status = await f.call('apps_operation_status', {connectionRef: reference, originalOperationId: operationId, originalAction: 'publish'});
    assert.equal(status.structuredContent.phase, 'succeeded');
    assert.equal(f.remote.frames.filter(frame => frame.action === 'publish').length, 1);
  } finally {await f.close();}
});
