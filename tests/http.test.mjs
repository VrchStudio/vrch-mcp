import assert from 'node:assert/strict';
import test from 'node:test';
import { createAIClient, createTerminalMCP, validateHTTPOrigin } from '../src/index.mjs';

class Socket {
  static OPEN = 1;
  static urls = [];
  constructor(url) { Socket.urls.push(url); }
  addEventListener() {}
  close() {}
}

test('precise HTTP policy refuses before socket or credential storage', () => {
  for (const allowed of [undefined, 'http://vrch-100.local', 'http://172.31.255.1:81']) {
    const before = Socket.urls.length;
    assert.throws(() => createAIClient('http://172.31.255.1/recovery/ai?invite=unused', {
      WebSocketImpl: Socket, sessionFile: '/proc/must-not-read/credentials', allowHTTPOrigin: allowed
    }), /HTTPS/);
    assert.equal(Socket.urls.length, before);
  }
  for (const origin of ['https://vrch-110.local', 'http://example.com', 'http://10.example.com',
    'http://127.0.0.1', 'http://169.254.1.2', 'http://192.169.1.2', 'http://172.32.0.1',
    'http://user@vrch-110.local', 'http://vrch-110.local/path', 'http://vrch-110.local\\path',
    'http://vrch-110.local?invite=x', 'http://vrch-110.local#x', 'http://*.local', 'http://[fd00::1]',
    ' http://vrch-110.local', 'http://vrch-110.local\n']) {
    assert.throws(() => validateHTTPOrigin(origin), /origin/i, origin);
  }
});

test('normalized exact host and port work without changing HTTPS and loopback', () => {
  assert.equal(validateHTTPOrigin('http://VRCH-110.local:80/'), 'http://vrch-110.local');
  for (const [url, allowed] of [
    ['http://vrch-110.local/recovery/ai?invite=x', 'http://VRCH-110.local:80'],
    ['http://172.31.255.1:18080/recovery/ai?invite=x', 'http://172.31.255.1:18080'],
    ['https://vrch-110.vrch.ai/recovery/ai?invite=x', undefined],
    ['http://127.0.0.1/recovery/ai?invite=x', undefined],
  ]) {
    const client = createAIClient(url, { WebSocketImpl: Socket, sessionFile: false, allowHTTPOrigin: allowed });
    assert.equal(Socket.urls.at(-1), new URL('/vrch-ws/terminal-assist', url).href.replace(/^http/, 'ws'));
    client.close();
  }
});

test('MCP startup policy reaches new joins and process resume; tool arguments cannot enable HTTP', async () => {
  const calls = [], replies = [];
  const bridge = createTerminalMCP({ allowHTTPOrigin: 'http://VRCH-110.local:80',
    send: value => replies.push(value), createClient: (url, options) => {
      calls.push({ url, options }); return { close() {}, screenshotBatches: () => [] };
    } });
  await bridge.receive({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  for (const resume of [false, true]) {
    await bridge.receive({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'terminal_connect', arguments: { url: 'http://vrch-110.local/recovery/ai?invite=x', resume,
        allowHTTPOrigin: 'http://other.local' } } });
    assert.equal(calls.at(-1).options.allowHTTPOrigin, 'http://vrch-110.local');
    assert.equal(calls.at(-1).options.resume, resume);
    await bridge.receive({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terminal_disconnect' } });
  }
  bridge.close();
  const before = Socket.urls.length;
  const denied = createTerminalMCP({ send: value => replies.push(value),
    createClient: (url, options) => createAIClient(url, { ...options, WebSocketImpl: Socket, sessionFile: false }) });
  await denied.receive({ jsonrpc: '2.0', id: 4, method: 'initialize' });
  await denied.receive({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'terminal_connect',
    arguments: { url: 'http://vrch-110.local/recovery/ai?invite=x', allowHTTPOrigin: 'http://vrch-110.local' } } });
  assert.equal(replies.at(-1).result.isError, true);
  assert.equal(Socket.urls.length, before);
  denied.close();
});

test('unsupported Windows storage fails before socket and before making a credential directory', () => {
  const original = process.getuid, before = Socket.urls.length;
  try {
    process.getuid = undefined;
    assert.throws(() => createAIClient('http://127.0.0.1/recovery/ai?invite=x', { WebSocketImpl: Socket }), /Windows is not supported/);
    assert.equal(Socket.urls.length, before);
  } finally { process.getuid = original; }
});
