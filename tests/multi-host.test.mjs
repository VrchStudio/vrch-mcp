import assert from 'node:assert/strict';
import test from 'node:test';
import {createTerminalMCP} from '../src/index.mjs';

// Two invited hosts stay connected side by side; each keeps its own events, approval and file transfers.
test('local MCP keeps several hosts connected with separate events, tools and file uploads', async () => {
  const replies = [], hosts = new Map();
  const bridge = createTerminalMCP({send: message => replies.push(message), createClient: (url, options) => {
    const host = new URL(url).host, record = {options, closed: false, uploads: [], apps: []};
    hosts.set(host + (hosts.has(host) ? '#2' : ''), record);
    return {close() { record.closed = true; }, capabilities: () => ({apps: true}), screenshotBatches: () => [], sharedScreenshots: () => [],
      report: async message => ({delivered: true, message}),
      uploadFile: async (path, options) => { record.uploads.push({path, ...options}); return {host, path, committed: true}; },
      appsRequest: async action => { record.apps.push(action); return {host, action}; },
      input: data => { record.input = data; return true; }};
  }});
  let id = 0;
  const call = async (method, params = {}) => { const requestId = ++id; await bridge.receive({jsonrpc: '2.0', id: requestId, method, params}); return replies.find(value => value.id === requestId); };
  const tool = async (name, args = {}) => (await call('tools/call', {name, arguments: args})).result;
  const body = result => result.content.map(item => item.text).join('\n');
  await call('initialize', {protocolVersion: '2025-11-25'});

  assert.match(body(await tool('terminal_connect', {url: 'https://vrch-110.vrch.ai/apps/ai?invite=a'})), /connectionRef vrch-110\.vrch\.ai/);
  assert.match(body(await tool('terminal_connect', {url: 'https://vrch-130.vrch.ai/apps/ai?invite=b'})), /connectionRef vrch-130\.vrch\.ai/);
  const one = hosts.get('vrch-110.vrch.ai'), two = hosts.get('vrch-130.vrch.ai');
  one.options.emit({type: 'collaboration', apps: 'vrch-apps-v1'}); two.options.emit({type: 'collaboration', apps: 'vrch-apps-v1'});

  const events = await tool('terminal_events', {waitSeconds: 0});
  const refs = events.content.map(item => JSON.parse(item.text).connectionRef).sort();
  assert.deepEqual(refs, ['vrch-110.vrch.ai', 'vrch-130.vrch.ai']);

  const ambiguous = await tool('file_upload', {path: '/tmp/a.vrchapp', purpose: 'app-package'});
  assert.equal(ambiguous.isError, true); assert.match(body(ambiguous), /connection_required/);
  assert.match(body(await tool('file_upload', {connectionRef: 'vrch-110.vrch.ai', path: '/tmp/a.vrchapp', purpose: 'app-package'})), /vrch-110/);
  assert.match(body(await tool('file_upload', {connectionRef: 'vrch-130.vrch.ai', path: '/tmp/b.vrchapp', purpose: 'app-package'})), /vrch-130/);
  assert.deepEqual(one.uploads.map(item => item.path), ['/tmp/a.vrchapp']);
  assert.deepEqual(two.uploads.map(item => item.path), ['/tmp/b.vrchapp']);
  await tool('apps_state', {connectionRef: 'vrch-130.vrch.ai'});
  assert.deepEqual([one.apps, two.apps], [[], ['state']]);

  const busy = await tool('terminal_connect', {url: 'https://vrch-110.vrch.ai/apps/ai?invite=a', resume: true});
  assert.match(body(busy), /already_connected/); assert.equal(one.closed, false);

  // A dropped host resumes under the same name; the other host is untouched.
  one.options.emit({type: 'ended', code: 'transport_disconnected'});
  assert.match(body(await tool('terminal_connect', {url: 'https://vrch-110.vrch.ai/apps/ai?invite=a', resume: true})), /connectionRef vrch-110/);
  const resumed = hosts.get('vrch-110.vrch.ai#2');
  assert.equal(resumed.options.resume, true); assert.equal(one.closed, true); assert.equal(two.closed, false);
  const kept = await tool('terminal_events', {connectionRef: 'vrch-110.vrch.ai', waitSeconds: 0});
  assert.match(body(kept), /transport_disconnected/);

  await tool('terminal_disconnect', {connectionRef: 'vrch-110.vrch.ai'});
  assert.equal(resumed.closed, true); assert.equal(two.closed, false);
  assert.match(body(await tool('file_upload', {path: '/tmp/c.vrchapp', purpose: 'app-package'})), /vrch-130/);
  assert.match(body(await tool('apps_state', {connectionRef: 'vrch-110.vrch.ai'})), /connection_not_found/);
  bridge.close();
});

