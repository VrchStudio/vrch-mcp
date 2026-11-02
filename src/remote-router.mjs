// One hosted process owns explicit connections. HTTP sessions never select a
// device. Device protocol/schema execution comes from the existing MCP core.
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {lstatSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createAIClient} from './client.mjs';
import {createTerminalMCP} from './mcp.mjs';
import {createRemoteCredentialStore} from './remote-credentials.mjs';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail = code => Object.assign(Error(code), {code});
const canonical = value => JSON.stringify(value, (_key, child) => child && !Array.isArray(child) && typeof child === 'object' ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const digest = value => createHash('sha256').update(value).digest('hex');
const durable = new Set(['apps_create', 'apps_open', 'apps_publish', 'apps_save', 'apps_import_inspect', 'apps_import_commit', 'apps_file_commit', 'apps_launch']);
const content = value => [{type: 'text', text: JSON.stringify(value)}];

export async function createRemoteRouter({filename, credentialDirectory, encryptionKey, resolveRegisteredTarget, createClient = createAIClient, waitMs = 20000, pendingWaitMs = 600000, resultDrainMs = 45000, idleMs = 1800000}) {
  if (typeof resolveRegisteredTarget !== 'function' || !Number.isInteger(waitMs) || waitMs < 1 || waitMs > 20000) throw fail('invalid_configuration');
  const parent = lstatSync(dirname(filename));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw fail('unsafe_connection_storage');
  try {const info = lstatSync(filename); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('unsafe_connection_storage');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  const db = new DatabaseSync(filename); chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, owner TEXT NOT NULL, attempt TEXT NOT NULL, invitation_hash TEXT NOT NULL,
      device TEXT NOT NULL, origin TEXT NOT NULL, phase TEXT NOT NULL, code TEXT, capabilities TEXT, UNIQUE(owner,attempt));
    CREATE TABLE IF NOT EXISTS operations(connection TEXT NOT NULL, id TEXT NOT NULL, action TEXT NOT NULL, digest TEXT NOT NULL,
      phase TEXT NOT NULL, result TEXT, PRIMARY KEY(connection,id));
    UPDATE connections SET phase='request_disconnected',code='service_restarted',capabilities=NULL WHERE phase IN ('connecting','pending');
    UPDATE connections SET phase='disconnected',code='service_restarted',capabilities=NULL WHERE phase IN ('ready','approved','resuming');
    UPDATE operations SET phase='outcome_unknown' WHERE phase='pending';`);
  if ([pendingWaitMs, resultDrainMs, idleMs].some(value => !Number.isSafeInteger(value) || value < 1)) throw fail('invalid_configuration');
  const active = new Map(), attaching = new Map();
  let closed = false;
  const owner = identity => {
    const values = ['issuer', 'principal', 'oauthClientId'].map(key => identity?.[key]);
    if (values.some(value => typeof value !== 'string' || !value || value.length > 2048)) throw fail('authentication_required');
    return JSON.stringify(values);
  };
  const load = (identity, reference) => {
    if (typeof reference !== 'string') throw fail('connection_required');
    const value = db.prepare('SELECT * FROM connections WHERE id=? AND owner=?').get(reference, owner(identity));
    if (!value) throw fail('context_mismatch'); return value;
  };
  const snapshot = record => ({connectionRef: record.id, phase: record.phase, retryable: false,
    ...(record.code ? {code: record.code} : {}), ...(record.phase === 'request_disconnected' ? {authorizationOutcome: 'unknown'} : {}),
    ...(record.phase === 'pending' ? {deadlineKnown: !!active.get(record.id)?.inviteDeadline, ...(active.get(record.id)?.inviteDeadline ? {inviteExpiresAt: active.get(record.id).inviteDeadline} : {})} : {}),
    ...(record.phase === 'ready' && record.capabilities ? {capabilities: JSON.parse(record.capabilities)} : {})});
  const setState = (id, phase, code = null, capabilities = null) => db.prepare('UPDATE connections SET phase=?,code=?,capabilities=? WHERE id=?').run(phase, code, capabilities && JSON.stringify(capabilities), id);
  const envelopes = (value, result = {}) => ({...result, content: result.content?.length ? result.content : content(value), structuredContent: value});
  function armIdle(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (closed) return;
      if (entry.requests) {entry.idleTimer = setTimeout(() => armIdle(entry), Math.min(1000, idleMs)); entry.idleTimer.unref(); return;}
      entry.shutdown();
    }, Math.max(1, entry.lastCall + idleMs - Date.now()));
    entry.idleTimer.unref();
  }
  function observe(id, event) {
    const entry = active.get(id);
    if (event.type === 'ai_pending') {
      setState(id, 'pending');
      if (entry && !entry.pendingTimer) {
        entry.inviteDeadline = Number.isSafeInteger(event.inviteExpiresAt) && event.inviteExpiresAt > 0 ? event.inviteExpiresAt : null;
        // The relay uses 20s pings + 20s pong timeout. Drain adds 5s for a
        // final result; old runtimes have a wait bound, never a fake expiry.
        entry.pendingTimer = setTimeout(() => setImmediate(() => {
          if (!closed && db.prepare('SELECT phase FROM connections WHERE id=?').get(id)?.phase === 'pending') entry.shutdown();
        }), Math.max(0, (entry.inviteDeadline || Date.now() + pendingWaitMs) - Date.now()) + resultDrainMs);
        entry.pendingTimer.unref();
      }
    }
    else if (['ai_approved', 'ai_resumed'].includes(event.type)) {clearTimeout(entry?.pendingTimer); if (entry) entry.pendingTimer = null; setState(id, 'approved');}
    else if (event.type === 'collaboration') {
      const previous = db.prepare('SELECT phase FROM connections WHERE id=?').get(id)?.phase;
      setState(id, 'ready', null, event.assistantCapabilities);
      if (entry && previous !== 'ready') {entry.lastCall = Date.now(); armIdle(entry);}
    }
    else if (event.type === 'ended') {
      clearTimeout(entry?.pendingTimer); clearTimeout(entry?.idleTimer);
      const previous = db.prepare('SELECT phase FROM connections WHERE id=?').get(id)?.phase;
      const phase = event.code === 'invite_unavailable' ? 'failed' : event.code === 'invite_expired' ? 'expired' : event.code === 'invite_canceled' ? 'cancelled'
        : event.code === 'invite_rejected' || event.code === 'ai_resume_denied' ? 'denied'
        : ['ai_removed', 'ai_revoked'].includes(event.code) ? 'removed'
        : ['request_disconnected', 'approval_storage_failed'].includes(event.code) || ['connecting', 'pending'].includes(previous) ? 'request_disconnected' : 'disconnected';
      setState(id, phase, event.code);
      if (active.get(id) === entry) active.delete(id);
    }
  }
  function attach(identity, record, url, resume, resolved) {
    if (attaching.has(record.id)) return attaching.get(record.id);
    const job = doAttach(identity, record, url, resume, resolved).finally(() => attaching.delete(record.id));
    attaching.set(record.id, job); return job;
  }
  async function doAttach(identity, record, url, resume, resolved) {
    const target = resolved || await resolveRegisteredTarget(url, {deviceId: record.device, resume});
    if (closed) throw fail('service_unavailable');
    if (target.deviceId !== record.device || target.origin !== record.origin || typeof target.WebSocketImpl !== 'function') throw fail('target_unavailable');
    active.get(record.id)?.shutdown(); active.delete(record.id);
    const pending = new Map(), entry = {requests: 0, lastCall: Date.now()};
    const credentialStore = createRemoteCredentialStore({directory: credentialDirectory, key: encryptionKey,
      binding: {...identity, deviceId: record.device, channel: 'apps', connectionRef: record.id}});
    entry.bridge = createTerminalMCP({toolCatalog: 'stable', send: message => {
      if (pending.has(message.id)) {pending.get(message.id)(message.result); pending.delete(message.id);}
    }, createClient: (address, options) => createClient(address, {...options, WebSocketImpl: target.WebSocketImpl, credentialStore, autoReconnect: false,
      emit: event => {try {observe(record.id, event); options.emit(event);} catch {queueMicrotask(() => entry.shutdown());}}})});
    entry.shutdown = () => {clearTimeout(entry.pendingTimer); clearTimeout(entry.idleTimer); entry.bridge.close();};
    entry.call = async (method, params) => {
      entry.requests++;
      const id = randomUUID(); const output = new Promise(resolve => pending.set(id, resolve));
      try {await entry.bridge.receive({jsonrpc: '2.0', id, method, params}); return await output;} finally {entry.requests--;} 
    };
    active.set(record.id, entry);
    await entry.call('initialize');
    setState(record.id, resume ? 'resuming' : 'connecting');
    const result = await entry.call('tools/call', {name: 'terminal_connect', arguments: {url, resume}});
    if (result.isError) {setState(record.id, 'disconnected', 'connection_failed'); entry.shutdown(); active.delete(record.id);}
    return result;
  }
  const replies = [];
  const catalogBridge = createTerminalMCP({toolCatalog: 'stable', send: message => replies.push(message)});
  await catalogBridge.receive({jsonrpc: '2.0', id: 1, method: 'initialize'});
  await catalogBridge.receive({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  const initialize = {...replies[0].result, serverInfo: {name: 'vrch-mcp-remote', version: '0.1.7-remote-dev'}};
  initialize.instructions += '\nHosted tools always require the explicit connectionRef. The terminal runs on the device, not in the browser. Device screenshots are not web Preview screenshots; apps_state reports the Preview runtime errors. Hosted file staging is not available in this slice; never treat local file paths as uploadable. Pairing does not replace the human Invite AI and Allow AI decisions.';
  const catalog = replies[1].result.tools.filter(tool => !tool.name.startsWith('file_')).map(original => {
    const tool = structuredClone(original);
    tool.outputSchema = {type: 'object', properties: {connectionRef: {type: 'string'}, phase: {type: 'string'}, retryable: {type: 'boolean'}}, required: ['phase', 'retryable'], additionalProperties: true};
    if (tool.name === 'terminal_connect') {
      tool.inputSchema = {type: 'object', properties: {url: {type: 'string'}, attemptId: {type: 'string', format: 'uuid'}, connectionRef: {type: 'string'}, resume: {type: 'boolean'}}, additionalProperties: false};
      tool.description = 'Join a new invitation with url and a newly generated lowercase UUID attemptId, or explicitly resume only the original connectionRef with resume:true. Reuse the original attemptId after a lost response; never select a recent device.';
    } else {
      tool.inputSchema.properties.connectionRef = {type: 'string'};
      tool.inputSchema.required = [...tool.inputSchema.required, 'connectionRef'];
      if (durable.has(tool.name)) {tool.inputSchema.properties.operationId = {type: 'string', format: 'uuid'}; if (!tool.inputSchema.required.includes('operationId')) tool.inputSchema.required.push('operationId');}
      if (tool.name === 'terminal_events') {tool.inputSchema.properties.waitSeconds.maximum = 20; tool.description = 'Read this connection’s repeatable approval/connection state and queued events. waitSeconds defaults to 20 and cannot exceed 20; ending this wait never cancels approval or a sent operation.';}
    }
    return tool;
  });
  catalogBridge.close();
  async function connect(identity, args) {
    if (args.resume === true) {
      if (args.url !== undefined || args.attemptId !== undefined) throw fail('invalid_connection_arguments');
      const record = load(identity, args.connectionRef);
      if (['connecting', 'pending', 'approved', 'resuming', 'ready'].includes(record.phase) && active.has(record.id)) return envelopes(snapshot(record));
      if (['removed', 'denied', 'request_disconnected', 'expired', 'cancelled', 'failed'].includes(record.phase)) throw fail('approval_required');
      await attach(identity, record, record.origin + '/apps/ai', true);
      return envelopes(snapshot(load(identity, record.id)));
    }
    if (args.connectionRef !== undefined || !uuid(args.attemptId) || typeof args.url !== 'string') throw fail('invalid_connection_arguments');
    const url = new URL(args.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/apps/ai' || !url.searchParams.get('invite')) throw fail('invalid_invitation');
    const key = owner(identity), hash = digest(url.href);
    let record = db.prepare('SELECT * FROM connections WHERE owner=? AND attempt=?').get(key, args.attemptId);
    if (record) {if (record.invitation_hash !== hash) throw fail('attempt_conflict'); return envelopes(snapshot(record));}
    const target = await resolveRegisteredTarget(url.href, {resume: false});
    if (target.origin !== url.origin || !target.deviceId || typeof target.WebSocketImpl !== 'function') throw fail('target_unavailable');
    record = db.prepare('SELECT * FROM connections WHERE owner=? AND attempt=?').get(key, args.attemptId);
    if (record) {if (record.invitation_hash !== hash) throw fail('attempt_conflict'); return envelopes(snapshot(record));}
    const id = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO connections(id,owner,attempt,invitation_hash,device,origin,phase) VALUES(?,?,?,?,?,?,?)').run(id, key, args.attemptId, hash, target.deviceId, url.origin, 'connecting');
    record = load(identity, id);
    await attach(identity, record, url.href, false, target);
    return envelopes(snapshot(load(identity, id)));
  }
  const bounded = (promise, pending) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(pending), waitMs);
    promise.then(value => {clearTimeout(timer); resolve(value);}, error => {clearTimeout(timer); reject(error);});
  });
  function business(result) {
    let value; try {value = JSON.parse(result.content?.[0]?.text);} catch {}
    const code = result.isError ? (value?.code || /^([a-z_]+):/.exec(result.content?.[0]?.text || '')?.[1] || 'operation_failed') : null;
    return {phase: result.isError ? ['connection_interrupted', 'operation_pending'].includes(code) ? 'outcome_unknown' : 'failed' : 'succeeded', retryable: false,
      ...(code ? {code} : {}), ...(value && typeof value === 'object' ? {result: value} : {})};
  }
  async function call(identity, name, args) {
    if (!catalog.some(tool => tool.name === name)) throw fail('unsupported_tool');
    if (name === 'terminal_connect') return connect(identity, args);
    const record = load(identity, args.connectionRef), entry = active.get(record.id);
    if (name === 'terminal_events' && (!entry || record.phase !== 'ready' && record.phase !== 'pending')) return envelopes(snapshot(record));
    if (!entry) throw fail('disconnected');
    entry.lastCall = Date.now(); if (record.phase === 'ready') armIdle(entry);
    if (name === 'terminal_disconnect') {entry.shutdown(); active.delete(record.id); return envelopes(snapshot(load(identity, record.id)));}
    if (!['terminal_events', 'ai_report', 'ai_capabilities'].includes(name) && record.phase !== 'ready') throw fail('approval_required');
    const {connectionRef, ...values} = args;
    if (name === 'terminal_events' && (typeof (values.waitSeconds ?? 20) !== 'number' || !Number.isFinite(values.waitSeconds ?? 20) || (values.waitSeconds ?? 20) < 0 || (values.waitSeconds ?? 20) > 20)) throw fail('invalid_wait');
    const invoke = () => entry.call('tools/call', {name, arguments: values});
    if (name === 'apps_operation_status') {
      if (!uuid(values.originalOperationId) || typeof values.originalAction !== 'string') throw fail('invalid_operation_query');
      const previous = db.prepare('SELECT * FROM operations WHERE connection=? AND id=?').get(connectionRef, values.originalOperationId);
      if (previous && previous.action.slice(5) !== values.originalAction) throw fail('operation_conflict');
      if (previous && ['succeeded', 'failed'].includes(previous.phase)) return envelopes(JSON.parse(previous.result));
      const response = await bounded(invoke(), null), queried = response && business(response);
      const terminal = queried?.result?.status;
      const value = {connectionRef, operationId: values.originalOperationId, retryable: false,
        phase: terminal === 'succeeded' ? 'succeeded' : ['failed', 'canceled'].includes(terminal) ? 'failed'
          : terminal ? 'pending' : 'outcome_unknown',
        ...(queried?.result ? {result: queried.result} : {})};
      if (previous && !closed) db.prepare('UPDATE operations SET phase=?,result=? WHERE connection=? AND id=?').run(value.phase, JSON.stringify(value), connectionRef, values.originalOperationId);
      return envelopes(value);
    }
    if (durable.has(name)) {
      if (!uuid(values.operationId)) throw fail('operation_id_required');
      const fingerprint = digest(canonical(values));
      const previous = db.prepare('SELECT * FROM operations WHERE connection=? AND id=?').get(record.id, values.operationId);
      if (previous) {
        if (previous.action !== name || previous.digest !== fingerprint) throw fail('operation_conflict');
        return envelopes({connectionRef, operationId: values.operationId, phase: previous.phase, retryable: false, ...(previous.result ? JSON.parse(previous.result) : {})});
      }
      db.prepare('INSERT INTO operations(connection,id,action,digest,phase) VALUES(?,?,?,?,?)').run(record.id, values.operationId, name, fingerprint, 'pending');
      const completed = invoke().then(result => {
        const value = {connectionRef, operationId: values.operationId, ...business(result)};
        if (!closed) db.prepare('UPDATE operations SET phase=?,result=? WHERE connection=? AND id=?').run(value.phase, JSON.stringify(value), connectionRef, values.operationId);
        return envelopes(value, result);
      });
      return bounded(completed, envelopes({connectionRef, operationId: values.operationId, phase: 'pending', retryable: false}));
    }
    const result = await bounded(invoke(), null);
    if (!result) return envelopes({connectionRef, phase: 'outcome_unknown', retryable: false});
    if (name === 'terminal_events' || name === 'ai_capabilities') return envelopes(snapshot(load(identity, connectionRef)), result);
    return envelopes({connectionRef, ...business(result)}, result);
  }
  return {catalog, async handle(identity, message) {
    owner(identity);
    if (message.method === 'initialize') return {jsonrpc: '2.0', id: message.id, result: {...initialize, instructions: initialize.instructions + ' Remote calls require their exact connectionRef. Generate a fresh attemptId for a new invitation and an operationId before each recoverable modification. Lost responses are queried with their original IDs, never replayed with new IDs.'}};
    if (message.method === 'tools/list') return {jsonrpc: '2.0', id: message.id, result: {tools: catalog}};
    if (message.method === 'ping') return {jsonrpc: '2.0', id: message.id, result: {}};
    if (message.method !== 'tools/call') return {jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Method not found'}};
    try {return {jsonrpc: '2.0', id: message.id, result: await call(identity, message.params?.name, message.params?.arguments || {})};}
    catch (error) {const code = error.code || 'connection_unavailable'; return {jsonrpc: '2.0', id: message.id, result: envelopes({phase: 'failed', retryable: false, code}, {isError: true, content: content({code})})};}
  }, close() {if (closed) return; for (const entry of active.values()) entry.shutdown(); active.clear(); closed = true; db.close();}};
}
