import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { rgbPNG } from './helpers/png.mjs';
import { createAIClient } from '../src/index.mjs';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const png = rgbPNG(12, 7);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); } assert.fail('Expected screenshot event'); }

async function fixture(options = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const frames = [], events = [], peers = [], id = 'a'.repeat(32);
  const metadata = { id, operationId: 'b'.repeat(32), sequence: 1, source: 'human', capturedAt: '2026-09-29T17:00:00Z',
    display: 'HDMI-1', width: 12, height: 7, mimeType: 'image/png', size: png.length, sha256: createHash('sha256').update(png).digest('hex') };
  let peer, privateInput = false, image = true, reads = 0;
  const send = message => peer.send(JSON.stringify(message));
  const state = () => send({ type: 'screenshot_state', protocol: 'vrch-screenshot-v2', canCapture: !privateInput, images: image ? [metadata] : [], busy: false });
  server.on('connection', socket => {
    peer = socket; peers.push(socket);
    socket.on('message', bytes => {
      const message = JSON.parse(bytes); frames.push(message);
      if (message.type === 'ai_join' || message.type === 'ai_resume') {
        send(message.type === 'ai_join' ? { type: 'ai_approved', credential: 'fixture-credential', requestId: 'fixture', leaseExpiresAt: Date.now() + 60000 }
          : { type: 'ai_resumed', leaseExpiresAt: Date.now() + 60000 });
        send({ type: 'collaboration', owner: 'human', private: false, passwordRequired: false }); state();
      } else if (message.type === 'screenshot_get') {
        reads++;
        send({ type: 'screenshot_image', ...metadata });
        const packet = Buffer.alloc(28 + png.length); packet.write('VRCHSS1\0'); Buffer.from(id, 'hex').copy(packet, 8); png.copy(packet, 28); peer.send(packet);
        send({ type: 'screenshot_complete', id });
      }
    });
  });
  const client = createAIClient(`http://127.0.0.1:${server.address().port}/recovery/ai?invite=fixture`, { sessionFile: false, delay: 10, emit: event => events.push(event), ...options });
  return { client, frames, events, metadata, send, state, reads: () => reads,
    private(value) { privateInput = value; send({ type: 'collaboration', owner: 'human', private: value, passwordRequired: value }); state(); },
    remove() { image = false; state(); }, disconnect() { peer.terminate(); },
    output(bytes) { send({ type: 'ready', streamId: 'fixture', outputStart: 0 }); send({ type: 'output', streamId: 'fixture', offset: 0, length: bytes.length }); peer.send(bytes); },
    async close() { client.close(); for (const socket of peers) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
  };
}

test('image input requires decoding and adapter acceptance; reconnect re-acks retained bytes', async () => {
  let accept, image;
  const f = await fixture({ imageInput: received => { image = received; return new Promise(resolve => { accept = resolve; }); } });
  try {
    await until(() => accept);
    assert.deepEqual(image.data, png);
    assert.equal(f.frames[0].imageInput, true);
    assert.equal(f.frames.filter(frame => frame.type === 'screenshot_ack').length, 0);
    accept(); await until(() => f.frames.some(frame => frame.type === 'screenshot_ack'));
    assert.equal(f.client.sharedScreenshots().length, 1);
    assert.equal(f.reads(), 1);
    // A literal signature in terminal output is still terminal text, never image data.
    const bytes = Buffer.from('VRCHSS1\0literal terminal bytes padding'); f.output(bytes);
    await until(() => f.events.some(event => event.type === 'data'));
    assert.equal(f.events.find(event => event.type === 'data').data, bytes.toString());
    f.disconnect(); await until(() => f.frames.filter(frame => frame.type === 'screenshot_ack').length === 2);
    assert.equal(f.reads(), 1, 'A live client reuses its already-decoded image on reconnect');
    f.remove(); await until(() => !f.client.sharedScreenshots().length);
  } finally { await f.close(); }
});

test('private-input race aborts image attachment and suppresses receipt until a fresh authorized read', async () => {
  const jobs = [];
  const f = await fixture({ imageInput: (image, context) => new Promise(resolve => jobs.push({ image, ...context, resolve })) });
  try {
    await until(() => jobs.length === 1);
    f.private(true); await until(() => jobs[0].signal.aborted);
    jobs[0].resolve(); await sleep(20);
    assert(!f.frames.some(frame => frame.type === 'screenshot_ack'));
    assert.equal(f.client.sharedScreenshots().length, 0);
    await assert.rejects(f.client.takeScreenshot(), { code: 'capture_unavailable' });
    assert(!f.frames.some(frame => frame.type === 'screenshot_take'));
    f.private(false); await until(() => jobs.length === 2); jobs[1].resolve();
    await until(() => f.frames.some(frame => frame.type === 'screenshot_ack'));
    assert.equal(f.client.sharedScreenshots().length, 1);
  } finally { await f.close(); }
});

test('attachment failures never acknowledge image support as successful delivery', async () => {
  const f = await fixture({ imageInput: async () => { throw Error('Image adapter unavailable'); } });
  try {
    await until(() => f.events.some(event => event.type === 'screenshot_error'));
    assert(!f.frames.some(frame => frame.type === 'screenshot_ack'));
    assert.equal(f.client.sharedScreenshots().length, 0);
  } finally { await f.close(); }
});

test('invalid PNG dimensions are rejected before reaching an image adapter', async () => {
  let delivered = false;
  const f = await fixture({ imageInput: async () => { delivered = true; } });
  f.metadata.width = 13;
  try {
    await until(() => f.events.some(event => event.type === 'screenshot_error'));
    assert.equal(delivered, false);
    assert(!f.frames.some(frame => frame.type === 'screenshot_ack'));
  } finally { await f.close(); }
});
