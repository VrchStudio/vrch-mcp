import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {WebSocket} from 'ws';
import {createRemoteCredentialStore} from '../src/remote-credentials.mjs';
import {createAIClient} from '../src/index.mjs';
import {relay, until} from './helpers/relay.mjs';

const binding = {issuer: 'https://mcp.example', principal: 'paired-user', oauthClientId: 'chat-client', deviceId: 'device-130', channel: 'apps', connectionRef: 'a'.repeat(32)};
const record = {credential: 'fixture-secret', requestId: 'fixture-request', expires: 0, offset: 0, stream: ''};

test('encrypted recovery is durable, bound to each context dimension and never copied between identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vrch-remote-credentials-')), key = randomBytes(32);
  const store = options => createRemoteCredentialStore({directory, key, binding, ...options});
  try {
    store().write(record);
    const file = join(directory, readdirSync(directory)[0]), encrypted = readFileSync(file);
    assert(!encrypted.includes(Buffer.from(record.credential)));
    assert(!encrypted.includes(Buffer.from(binding.principal)));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store().read(), record);
    for (const field of Object.keys(binding).filter(field => field !== 'channel')) {
      const other = store({binding: {...binding, [field]: binding[field] + '-other'}});
      assert.equal(other.read(), null);
      other.write({...record, credential: 'other-secret'});
      const otherFile = readdirSync(directory).map(name => join(directory, name)).find(name => name !== file);
      writeFileSync(otherFile, encrypted);
      assert.throws(() => other.read(), {code: 'credential_storage_unavailable'});
      rmSync(otherFile);
      assert.deepEqual(store().read(), record);
    }
    assert.throws(() => store({key: randomBytes(32)}).read(), {code: 'credential_storage_unavailable'});
    store().remove('another-grant'); assert.deepEqual(store().read(), record);
    store().remove(record.requestId); assert.equal(store().read(), null);
    store().write(record); chmodSync(directory, 0o755);
    assert.throws(() => store().read(), {code: 'credential_storage_unavailable'});
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('real WebSocket resumes only from the injected encrypted store; secrets stay out of events', async () => {
  const remote = await relay(), directory = mkdtempSync(join(tmpdir(), 'vrch-remote-resume-')), key = randomBytes(32), events = [];
  const store = () => createRemoteCredentialStore({directory, key, binding});
  let client;
  try {
    client = createAIClient(remote.url, {WebSocketImpl: WebSocket, credentialStore: store(), emit: event => events.push(event)});
    await until(() => events.some(event => event.type === 'ai_pending')); remote.approve();
    await until(() => client.capabilities()?.apps);
    assert.equal(store().read().credential, 'fixture-secret');
    client.close();
    client = createAIClient(remote.url, {WebSocketImpl: WebSocket, resume: true, credentialStore: store(), emit: event => events.push(event)});
    await until(() => client.capabilities()?.apps);
    assert.equal(remote.frames.filter(frame => frame.type === 'ai_join').length, 1);
    assert.equal(remote.frames.filter(frame => frame.type === 'ai_resume').length, 1);
    remote.remove(); await until(() => events.some(event => event.type === 'ended' && event.code === 'ai_revoked'));
    assert.equal(store().read(), null);
    assert(!JSON.stringify(events).includes('fixture-secret'));
  } finally {client?.close(); await remote.close(); rmSync(directory, {recursive: true, force: true});}
});

test('approval storage failure never emits approved/ready or admits collaboration and never sends Remove', async () => {
  const remote = await relay(), events = [];
  let client;
  try {
    client = createAIClient(remote.url, {WebSocketImpl: WebSocket,
      credentialStore: {read: () => null, write() {throw Error('private path and secret');}, remove() {assert.fail('Must not remove the actual grant.');}},
      emit: event => events.push(event)});
    await until(() => events.some(event => event.type === 'ai_pending')); remote.approve();
    await until(() => events.some(event => event.type === 'ended' && event.code === 'approval_storage_failed'));
    assert.equal(client.capabilities(), null);
    assert(events.some(event => event.type === 'resume_storage_error' && event.authorizationOutcome === 'unknown' && event.retryable === false));
    assert(!events.some(event => ['ai_approved', 'collaboration', 'ready'].includes(event.type)));
    assert(!JSON.stringify(events).includes('private path'));
    assert(!remote.frames.some(frame => frame.type === 'ai_remove'));
  } finally {client?.close(); await remote.close();}
});
