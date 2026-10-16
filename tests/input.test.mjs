// The real AI client/MCP adapter over WebSocket; relay responses are fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAIClient, createTerminalMCP } from '../src/index.mjs';
import { WebSocket, WebSocketServer } from 'ws';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(10); }
  assert.fail('Expected terminal event');
}

test('MCP distinguishes input sent from execution and reports Agent rejection without disconnecting', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const replies = [], events = [], inputs = [];
  let peer, id = 0;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes);
      if (frame.type === 'ai_join') {
        socket.send(JSON.stringify({ type: 'ai_approved', credential: 'fixture-only', requestId: 'fixture', leaseExpiresAt: Date.now() + 60000 }));
        socket.send(JSON.stringify({ type: 'collaboration', owner: 'ai', epoch: 2, private: false, passwordRequired: false }));
      } else if (frame.type === 'input') inputs.push(frame);
    });
  });
  const origin = `http://192.168.250.2:${server.address().port}`;
  class FixtureSocket extends WebSocket {
    constructor(url, ...args) {
      const mapped = new URL(url); mapped.hostname = '127.0.0.1';
      super(mapped.href, ...args);
    }
  }
  const bridge = createTerminalMCP({ allowHTTPOrigin: origin, send: value => replies.push(value),
    createClient: (url, options) => createAIClient(url, { ...options, WebSocketImpl: FixtureSocket, sessionFile: false,
      emit: value => { events.push(value); options.emit(value); } }) });
  async function rpc(method, params) {
    const requestId = ++id;
    await bridge.receive({ jsonrpc: '2.0', id: requestId, method, params });
    const reply = replies.find(value => value.id === requestId);
    assert(reply && !reply.error);
    return reply.result;
  }
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  try {
    await rpc('initialize', { protocolVersion: '2025-11-25' });
    await call('terminal_connect', { url: origin + '/recovery/ai?invite=fixture' });
    await until(() => events.some(value => value.type === 'collaboration'));
    await call('terminal_events', { waitSeconds: 0 });
    const sent = await call('terminal_input', { data: 'touch fixture-only\n' });
    assert.match(sent.content[0].text, /Input sent; execution is not yet confirmed/);
    assert(!JSON.stringify(sent).includes('No new terminal events'));
    await until(() => inputs.length === 1);
    peer.send(JSON.stringify({ type: 'input_rejected', code: 'stale_input', epoch: 3,
      message: 'Input control changed. No input was sent; check current control before retrying.' }));
    await until(() => events.some(value => value.type === 'input_rejected'));
    const refused = await call('terminal_events', { waitSeconds: 0 });
    assert.match(JSON.stringify(refused), /stale_input/);
    assert.match(JSON.stringify(refused), /No input was sent/);
    assert(!events.some(value => value.type === 'ended'));
    await call('terminal_input', { data: 'explicit retry\n' });
    await until(() => inputs.length === 2);
    peer.send(JSON.stringify({ type: 'collaboration', owner: 'human', epoch: 4, private: true, passwordRequired: true }));
    await until(() => events.some(value => value.type === 'collaboration' && value.private));
    const blocked = await call('terminal_input', { data: 'not-a-password\n' });
    assert.equal(blocked.isError, true);
    assert.equal(inputs.length, 2);
  } finally {
    bridge.close(); peer?.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
