// One hosted process owns explicit connections. HTTP sessions never select a
// device. Device protocol/schema execution comes from the existing MCP core.
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {lstatSync, chmodSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {browserObservationTool,browserCapabilities} from './remote-browser-tools.mjs';
import {previewTools,capturePreview} from './remote-preview.mjs';
import {createWorkspaceText, validateWorkspaceText, workspaceTextTools} from './remote-workspace-text.mjs';
import {hostedCapabilities, hostedInstructions, sdkReference, sdkReferenceTool} from './remote-guidance.mjs';
import {createAIClient} from './client.mjs';
import {createTerminalMCP} from './mcp.mjs';
import {createRemoteCredentialStore} from './remote-credentials.mjs';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail = code => Object.assign(Error(code), {code});
const canonical = value => JSON.stringify(value, (_key, child) => child && !Array.isArray(child) && typeof child === 'object' ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const digest = value => createHash('sha256').update(value).digest('hex');
const durable = new Set(['apps_create', 'apps_open', 'apps_publish_preview', 'apps_publish', 'apps_save', 'apps_import_inspect', 'apps_import_commit', 'apps_file_commit', 'apps_launch', 'apps_write_text']);
const hostedExcluded = new Set(['apps_file_export', 'apps_file_commit', 'apps_export_begin', 'apps_import_inspect', 'apps_import_commit']);
const content = value => [{type: 'text', text: JSON.stringify(value)}];

export async function createRemoteRouter({filename, credentialDirectory, encryptionKey, resolveRegisteredTarget, createClient = createAIClient, waitMs = 20000, pendingWaitMs = 600000, resultDrainMs = 45000, idleMs = 1800000, buildRevision = 'unknown', browserTargets = null}) {
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
  const workspaceText = createWorkspaceText(join(dirname(filename), 'workspace-transfers'));
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
  const resumable = record => record.phase === 'disconnected' && ['transport_disconnected','idle_timeout','service_restarted','client_closed'].includes(record.code);
  const recovery = record => ({resumable:resumable(record),...(resumable(record)?{message:'Resume this original connectionRef with terminal_connect({connectionRef,resume:true}); retryable:false prohibits automatic replay of the interrupted tool call. Resume still checks the retained device authorization.'}:{})});
  const reference = {text:sdkReference,size:Buffer.byteLength(sdkReference),sha256:digest(sdkReference),reviewedPagesRevision:'c59300c5',serviceRevision:buildRevision};
  const snapshot = record => ({connectionRef: record.id, phase: record.phase, retryable: false, ...recovery(record),
    ...(record.code ? {code: record.code} : {}), ...(record.phase === 'request_disconnected' ? {authorizationOutcome: 'unknown'} : {}),
    ...(record.phase === 'pending' ? {deadlineKnown: !!active.get(record.id)?.inviteDeadline, ...(active.get(record.id)?.inviteDeadline ? {inviteExpiresAt: active.get(record.id).inviteDeadline} : {})} : {}),
    targetKind: record.device.startsWith('web_') ? 'browser' : 'device', ...(record.phase === 'ready' && record.capabilities ? {capabilities: (record.device.startsWith('web_')?browserCapabilities:hostedCapabilities)(JSON.parse(record.capabilities))} : {})});
  const setState = (id, phase, code = null, capabilities = null) => db.prepare('UPDATE connections SET phase=?,code=?,capabilities=? WHERE id=?').run(phase, code, capabilities && JSON.stringify(capabilities), id);
  const envelopes = (value, result = {}) => ({...result, content: result.content?.length ? result.content : content(value), structuredContent: value});
  function armIdle(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (closed) return;
      if (entry.requests) {entry.idleTimer = setTimeout(() => armIdle(entry), Math.min(1000, idleMs)); entry.idleTimer.unref(); return;}
      entry.shutdown('idle_timeout');
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
          if (!closed && db.prepare('SELECT phase FROM connections WHERE id=?').get(id)?.phase === 'pending') entry.shutdown('approval_wait_ended');
        }), Math.max(0, (entry.inviteDeadline || Date.now() + pendingWaitMs) - Date.now()) + resultDrainMs);
        entry.pendingTimer.unref();
      }
    }
    else if (['ai_approved', 'ai_resumed'].includes(event.type)) {clearTimeout(entry?.pendingTimer); if (entry) entry.pendingTimer = null; setState(id, 'approved');}
    else if (event.type === 'collaboration') {
      if (entry) {entry.inputEpoch=event.epoch;entry.terminalReadable=event.assistantCapabilities?.terminal===true&&!event.private&&!event.passwordRequired;}
      const previous = db.prepare('SELECT phase FROM connections WHERE id=?').get(id)?.phase;
      setState(id, 'ready', null, entry?.kind === 'browser' ? {...event.assistantCapabilities,owner:event.owner,paused:event.paused,approvalId:event.approvalId} : event.assistantCapabilities);
      if (entry && previous !== 'ready') {entry.lastCall = Date.now(); armIdle(entry);}
    }
    else if (event.type === 'ended') {
      if (event.code === 'client_closed' && entry?.shutdownReason) event = {...event, code:entry.shutdownReason};
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
    const browser = record.device.startsWith('web_');
    if (browser && !browserTargets) throw fail('target_unavailable');
    const target = resolved || await (browser ? browserTargets.resolve(url, {deviceId:record.device,resume}) : resolveRegisteredTarget(url, {deviceId:record.device,resume}));
    if (closed) throw fail('service_unavailable');
    if (target.deviceId !== record.device || target.origin !== record.origin || (browser ? target.kind !== 'browser' : typeof target.WebSocketImpl !== 'function')) throw fail('target_unavailable');
    if (browser) return attachBrowser(identity, record, target, resume);
    active.get(record.id)?.shutdown(); active.delete(record.id);
    const pending = new Map(), entry = {requests: 0, lastCall: Date.now()};
    const credentialStore = createRemoteCredentialStore({directory: credentialDirectory, key: encryptionKey,
      binding: {...identity, deviceId: record.device, channel: 'apps', connectionRef: record.id}});
    entry.bridge = createTerminalMCP({toolCatalog: 'stable', imageDelivery: 'events', eventDelivery: 'terminal', send: message => {
      if (pending.has(message.id)) {pending.get(message.id)(message.result); pending.delete(message.id);}
    }, createClient: (address, options) => {
      const client = createClient(address, {...options, WebSocketImpl: target.WebSocketImpl, credentialStore, autoReconnect: false,
        emit: event => {try {
          observe(record.id, event);
          if (event.type === 'collaboration') event = {...event, filePurposes: [], assistantCapabilities: hostedCapabilities(event.assistantCapabilities)};
          if (event.type === 'apps_guide') event = {...event, instructions: event.instructions
            .replace('Use app-workspace file_upload/file_download with apps_file_export/apps_file_commit for developer files; completed transport does not publish/save/execute files.', hostedInstructions)
            .replace('Human screenshots arrive automatically as native image content in terminal tool results.', 'Human-shared screenshots are queued for terminal_events.')};
          if (event.type !== 'data' || entry.terminalReadable) options.emit(event);
        } catch {queueMicrotask(() => entry.shutdown());}}});
      entry.appRequest = (...args) => client.appsRequest(...args);
      entry.downloadPreview = (path,ticket) => client.downloadFile(path,{purpose:'app-preview',resource:{ticket},maxBytes:1024*1024});
      const capabilities = client.capabilities;
      client.capabilities = () => hostedCapabilities(capabilities());
      const input = client.input;
      client.input = data => {if (!capabilities()?.terminal) throw fail('unsupported_capability'); return input(data);};
      return client;
    }});
    entry.shutdown = (reason = 'client_closed') => {entry.shutdownReason = reason; clearTimeout(entry.pendingTimer); clearTimeout(entry.idleTimer); entry.bridge.close();};
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
  async function attachBrowser(identity, record, target, resume) {
    active.get(record.id)?.shutdown();
    const events=[],waiters=new Set(),entry={kind:'browser',requests:0,lastCall:Date.now()};
    const notify=event=>{
      if(closed)return;
      events.push(event);if(events.length>128)events.shift();
      observe(record.id,event);
      for(const wake of waiters)wake();waiters.clear();
    };
    const channel=browserTargets.attach(target,{connectionRef:record.id,oauthClientId:identity.oauthClientId,resume,onEvent:notify});
    entry.shutdown=(reason='client_closed')=>{entry.shutdownReason=reason;clearTimeout(entry.pendingTimer);clearTimeout(entry.idleTimer);channel.close(reason);for(const wake of waiters)wake();waiters.clear();};
    entry.call=async(method,params={})=>{
      entry.requests++;
      try {
        if(method!=='tools/call')throw fail('unsupported_tool');
        const {name,arguments:values={}}=params;
        if(name==='terminal_events'){
          if(!events.length&&(values.waitSeconds??20)>0)await new Promise(resolve=>{const wake=()=>{clearTimeout(timer);waiters.delete(wake);resolve();};const timer=setTimeout(wake,(values.waitSeconds??20)*1000);waiters.add(wake);});
          return {content:events.splice(0).flatMap(content)};
        }
        if(name==='ai_capabilities')return {content:content(snapshot(load(identity,record.id)))};
        // Browser targets never impersonate a device shell or a native screenshot.
        if(!['apps_list','apps_state','apps_create','apps_open','apps_read_text','apps_write_text','apps_publish_preview','apps_save','apps_input_targets','apps_control','apps_interface_input','apps_preview_input','apps_operation_status','apps_observe','ai_report'].includes(name))
          return {isError:true,content:content({code:'unsupported_capability',message:'This connection targets a browser Simulator. Device shell, desktop capture and hardware lifecycle tools are unavailable.'})};
        return await channel.request(name,values);
      } catch(error){return {isError:true,content:content({code:error.code||'connection_interrupted',message:error.message||'The browser request did not complete.'})};}
      finally{entry.requests--;}
    };
    active.set(record.id,entry);setState(record.id,resume?'resuming':'connecting');
    try{await channel.start();}catch(error){notify({type:'ended',code:error.code||'transport_disconnected'});throw error;}
  }
  const replies = [];
  const catalogBridge = createTerminalMCP({toolCatalog: 'stable', send: message => replies.push(message)});
  await catalogBridge.receive({jsonrpc: '2.0', id: 1, method: 'initialize'});
  await catalogBridge.receive({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  const initialize = {...replies[0].result, serverInfo: {name: 'vrch-mcp-remote', version: '0.1.7-remote-dev' + (buildRevision === 'unknown' ? '' : '+' + buildRevision)}};
  initialize.capabilities.tools.listChanged = true;
  initialize.instructions += '\nHosted tools always require the explicit connectionRef. Hosted terminal tools reuse the device terminal capability, current control owner, Private Input and approval checks; this remains an ordinary device user shell, not a project-only sandbox. Read terminal_events for terminal output. Sending input does not confirm execution; never replay shell input after an uncertain response. Device screenshots are not web Preview screenshots; apps_state reports the Preview runtime errors. Use apps_read_text/apps_write_text for bounded UTF-8 source edits in the current workspace. Hosted general file staging is not available; never treat local file paths as uploadable. Pairing does not replace the human Invite AI and Allow AI decisions.';
  initialize.instructions += '\n' + hostedInstructions;
  if(browserTargets)initialize.instructions += '\nA browser Simulator is a distinct approved target. It runs and stores Apps in the local browser; it has no device shell, device screenshot or hardware launch. Use apps_observe for honestly labeled DOM/layout, canvas pixel layers and App-reported logs. This is not a full screenshot. Browser disconnection does not queue or replay mutations.';
  const catalog = [...replies[1].result.tools.filter(tool => !tool.name.startsWith('file_') && !hostedExcluded.has(tool.name)), ...workspaceTextTools, sdkReferenceTool, ...previewTools, ...(browserTargets ? [browserObservationTool] : [])].map(original => {
    const tool = structuredClone(original);
    tool.outputSchema = {type: 'object', properties: {connectionRef: {type: 'string'}, phase: {type: 'string'}, retryable: {type: 'boolean'}}, required: ['phase', 'retryable'], additionalProperties: true};
    if (tool.name === 'terminal_connect') {
      tool.inputSchema = {type: 'object', properties: {url: {type: 'string'}, attemptId: {type: 'string', format: 'uuid'}, connectionRef: {type: 'string'}, resume: {type: 'boolean'}}, additionalProperties: false};
      tool.description = 'Join a new invitation with url and a newly generated lowercase UUID attemptId, or explicitly resume only the original connectionRef with resume:true. Reuse the original attemptId after a lost response; never select a recent device.';
    } else {
      tool.inputSchema.properties.connectionRef = {type: 'string'};
      tool.inputSchema.required = [...tool.inputSchema.required, 'connectionRef'];
      if (durable.has(tool.name)) {tool.inputSchema.properties.operationId = {type: 'string', format: 'uuid'}; if (!tool.inputSchema.required.includes('operationId')) tool.inputSchema.required.push('operationId');}
      if (tool.name === 'apps_operation_status') tool.inputSchema.properties.originalAction.description = 'Original durable action without apps_: create, open, publish_preview, publish, save, launch or write_text. Not control/interface input; keep the original connectionRef and operationId.';
      if (tool.name === 'terminal_events') {tool.inputSchema.properties.waitSeconds.maximum = 20; tool.inputSchema.properties.waitSeconds.description = 'Optional; omit for 20 seconds. Valid range 0..20; returns early when events arrive.'; tool.description = 'Read this connection’s repeatable approval/connection state and queued events. waitSeconds defaults to 20 and cannot exceed 20; ending this wait never cancels approval or a sent operation.';}
    }
    return tool;
  });
  const catalogInfo={revision:digest(canonical(catalog)),toolCount:catalog.length};
  catalogBridge.close();
  async function connect(identity, args) {
    if (args.resume === true) {
      if (args.url !== undefined || args.attemptId !== undefined) throw fail('invalid_connection_arguments');
      const record = load(identity, args.connectionRef);
      if (['connecting', 'pending', 'approved', 'resuming', 'ready'].includes(record.phase) && active.has(record.id)) return envelopes(snapshot(record));
      if (['removed', 'denied', 'request_disconnected', 'expired', 'cancelled', 'failed'].includes(record.phase)) throw fail('approval_required');
      await attach(identity, record, record.origin + (record.device.startsWith('web_') ? '/synth/target' : '/apps/ai'), true);
      return envelopes(snapshot(load(identity, record.id)));
    }
    if (args.connectionRef !== undefined || !uuid(args.attemptId) || typeof args.url !== 'string') throw fail('invalid_connection_arguments');
    const url = new URL(args.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.pathname !== '/apps/ai' && !(browserTargets && url.pathname === '/synth/target')) || !url.searchParams.get('invite')) throw fail('invalid_invitation');
    const key = owner(identity), hash = digest(url.href);
    let record = db.prepare('SELECT * FROM connections WHERE owner=? AND attempt=?').get(key, args.attemptId);
    if (record) {if (record.invitation_hash !== hash) throw fail('attempt_conflict'); return envelopes(snapshot(record));}
    const browser=url.pathname==='/synth/target';
    const target = await (browser ? browserTargets.resolve(url.href,{resume:false}) : resolveRegisteredTarget(url.href,{resume:false}));
    if (target.origin !== url.origin || !target.deviceId || (browser ? target.kind!=='browser' || !target.deviceId.startsWith('web_') : typeof target.WebSocketImpl !== 'function' || target.deviceId.startsWith('web_'))) throw fail('target_unavailable');
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
    let value = result.structuredContent; if (!value) {try {value = JSON.parse(result.content?.[0]?.text);} catch {}}
    const code = result.isError ? (value?.code || /^([a-z_]+):/.exec(result.content?.[0]?.text || '')?.[1] || 'operation_failed') : null;
    return {phase: result.isError ? value?.delivery === 'not_sent' ? 'failed' : value?.phase === 'outcome_unknown' ? 'outcome_unknown' : ['connection_interrupted', 'operation_pending', 'disconnected', 'transport_disconnected', 'request_timeout'].includes(code) ? 'outcome_unknown' : 'failed' : 'succeeded', retryable: false,
      ...(code ? {code, message: (value?.message || result.content?.[0]?.text?.replace(/^[a-z_]+:\s*/, '') || 'Operation failed.').slice(0,1024)} : {}), ...(value && typeof value === 'object' ? {result: value} : {})};
  }
  async function call(identity, name, args) {
    if (!catalog.some(tool => tool.name === name)) throw fail('unsupported_tool');
    if (name === 'terminal_connect') return connect(identity, args);
    const record = load(identity, args.connectionRef), entry = active.get(record.id);
    if (name === 'terminal_events' && (!entry || record.phase !== 'ready' && record.phase !== 'pending')) return envelopes(snapshot(record));
    // Local receipts remain readable on their original reference while offline.
    // Never infer an outcome from another connection, even on the same device.
    const {connectionRef: ignoredReference, ...receiptArgs} = args;
    if (name === 'apps_operation_status') {
      if (!uuid(args.originalOperationId) || typeof args.originalAction !== 'string') throw fail('invalid_operation_query');
      const receipt = db.prepare('SELECT * FROM operations WHERE connection=? AND id=?').get(record.id, args.originalOperationId);
      if (receipt && receipt.action.slice(5) !== args.originalAction) throw fail('operation_conflict');
      if (receipt && ['succeeded','failed'].includes(receipt.phase)) return envelopes(JSON.parse(receipt.result));
      if (!entry || record.phase !== 'ready') return envelopes({connectionRef:record.id,operationId:args.originalOperationId,
        phase:'outcome_unknown',retryable:false,resumable:resumable(record),code:record.code||'disconnected',
        message:resumable(record)?'No completed receipt is available. Resume this original connectionRef, then query this operation again; do not replay it or switch connections.':'No completed receipt is available and this connection is not resumable now. Retain the original operation identity; another connection cannot prove its outcome.'});
    }
    if (durable.has(name) && !entry) {
      if (!uuid(args.operationId)) throw fail('operation_id_required');
      const receipt = db.prepare('SELECT * FROM operations WHERE connection=? AND id=?').get(record.id,args.operationId);
      if (receipt) {
        if (receipt.action !== name || receipt.digest !== digest(canonical(receiptArgs))) throw fail('operation_conflict');
        if (['succeeded','failed'].includes(receipt.phase)) return envelopes(JSON.parse(receipt.result));
        return envelopes({connectionRef:record.id,operationId:args.operationId,phase:'outcome_unknown',retryable:false,resumable:resumable(record),
          code:record.code||'disconnected',message:resumable(record)?'This operation was already accepted. Resume the original connection and query its result before any retry.':'This operation was already accepted but this connection cannot resume now. Do not infer its outcome or replay it.'});
      }
      return envelopes({connectionRef:record.id,operationId:args.operationId,phase:'failed',retryable:false,resumable:resumable(record),
        code:record.code||'disconnected',delivery:'not_sent',
        message:resumable(record)?'This call was not sent to the device. Resume this original connectionRef and inspect current state before retrying.':'This call was not sent to the device. This connection cannot resume now; inspect its authorization state before another action.'},{isError:true});
    }
    if (!entry) return envelopes({connectionRef:record.id,phase:'failed',retryable:false,code:record.code||'disconnected',...recovery(record)},{isError:true});
    entry.lastCall = Date.now(); if (record.phase === 'ready') armIdle(entry);
    if (name === 'terminal_disconnect') {entry.shutdown(); active.delete(record.id); return envelopes(snapshot(load(identity, record.id)));}
    if (!['terminal_events', 'ai_report', 'ai_capabilities'].includes(name) && record.phase !== 'ready') throw fail('approval_required');
    if (name === 'apps_sdk_reference') return envelopes({connectionRef: record.id, phase:'succeeded', retryable:false, result:reference}, {content:content({reference:'My Apps SDK v1',body:'structuredContent.result.text'})});
    const {connectionRef, ...values} = args;
    if (name === 'terminal_events' && (typeof (values.waitSeconds ?? 20) !== 'number' || !Number.isFinite(values.waitSeconds ?? 20) || (values.waitSeconds ?? 20) < 0 || (values.waitSeconds ?? 20) > 20)) throw fail('invalid_wait');
    const isText = name === 'apps_read_text' || name === 'apps_write_text';
    if (isText) validateWorkspaceText(name, values);
    const invoke = async () => {
      if(entry.kind==='browser'){
        const call=()=>entry.call('tools/call',{name,arguments:values});
        if(!['apps_control','apps_interface_input','apps_preview_input'].includes(name))return call();
        const epoch=entry.inputEpoch;
        const job=(entry.inputTail||Promise.resolve()).catch(()=>{}).then(()=>{if(entry.inputEpoch!==epoch)throw fail('control_changed');return call();});
        entry.inputTail=job;return job;
      }
      if(name==='apps_observe')return {isError:true,content:content({code:'unsupported_capability',message:'This connection is a device. Browser Simulator observation requires its own approved connection.'})};
      if (name === 'apps_preview_snapshot') return capturePreview(entry, values, dirname(filename));
      if (name === 'apps_publish_preview') {
        try {const {workspaceId,expectedRevision,operationId}=values;
          return {content:content(await entry.appRequest('publish_preview',{}, {workspaceId,expectedRevision,operationId}))};
        } catch (error) {return {isError:true,content:content({code:error.code||'publish_failed',message:error.message})};}
      }
      if (!isText) {
        if (!['apps_control','apps_interface_input','apps_host_input'].includes(name)) return entry.call('tools/call',{name,arguments:values});
        // Preserve complete gestures in call order. The device input sequence
        // is monotonic; concurrent host calls must not interleave click edges.
        const epoch=entry.inputEpoch;
        const job=(entry.inputTail||Promise.resolve()).catch(()=>{}).then(()=>{
          if(entry.inputEpoch!==epoch)throw fail('control_changed');
          return entry.call('tools/call',{name,arguments:values});
        });
        entry.inputTail=job;
        return job;
      }
      entry.requests++;
      try {return await workspaceText.run(connectionRef, name, values, (tool, input) => entry.call('tools/call', {name: tool, arguments: input}));}
      catch (error) {
        const code=error.code||'workspace_transfer_failed';
        const help={workspace_conflict:'This transfer requires the current active workspace and unchanged revision. Read apps_state; do not switch the user’s workspace merely to inspect another App.',file_not_found:'This workspace file does not exist. Use expectedSha256:null only when intentionally creating it.',transfer_busy:'This connection has eight queued text transfers. Wait for their results before sending more.',invalid_data:'The device refused this workspace path. It may be missing or invalid; do not overwrite an existing file without its current SHA-256.'}[code]||'Workspace transfer did not complete.';
        return {isError:true,content:[{type:'text',text:code+': '+help}]};
      }
      finally {entry.requests--;}
    };
    if (name === 'apps_operation_status') {
      if (!uuid(values.originalOperationId) || typeof values.originalAction !== 'string') throw fail('invalid_operation_query');
      const previous = db.prepare('SELECT * FROM operations WHERE connection=? AND id=?').get(connectionRef, values.originalOperationId);
      if (previous && previous.action.slice(5) !== values.originalAction) throw fail('operation_conflict');
      if (previous && ['succeeded', 'failed'].includes(previous.phase)) return envelopes(JSON.parse(previous.result));
      const query = entry.kind !== 'browser' && values.originalAction === 'write_text' ? () => entry.call('tools/call', {name, arguments: {...values, originalAction: 'file_commit'}}) : invoke;
      const response = await bounded(query(), null), queried = response && business(response);
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
    if (name === 'terminal_events' || name === 'take_screenshot' || name === 'terminal_input' && !result.isError) {
      const events = [], images = [];
      for (const item of result.content || []) {
        if (item.type !== 'text') continue;
        let event; try {event=JSON.parse(item.text);} catch {event={type:'message',message:item.text};}
        (event.type === 'screenshot' ? images : events).push(event);
      }
      const value = name === 'terminal_events' ? {...snapshot(load(identity,connectionRef)),events,images}
        : name === 'terminal_input' ? {connectionRef,phase:'succeeded',retryable:false,delivery:'sent',execution:'unconfirmed',events,images,
          message:'Input sent; execution is not confirmed. Read terminal_events for output or rejection. Never replay input automatically after an interruption.'}
        : {connectionRef,...business(result),result:{images,events}};
      return envelopes(value,{...result,content:[...content({connectionRef,phase:value.phase,...(name==='terminal_input'?{delivery:'sent',execution:'unconfirmed',message:value.message}:{}),eventCount:events.length,imageCount:images.length,body:'structuredContent'}),...(result.content||[]).filter(item=>item.type!=='text')]});
    }
    if (name === 'ai_capabilities') return envelopes({...snapshot(load(identity, connectionRef)),catalog:catalogInfo}, {...result,content:[...result.content,...content({catalog:catalogInfo,discovery:'Refresh tools/list in this conversation if the available tools differ. A catalog change does not require re-pairing.'})]});
    return envelopes({connectionRef, ...business(result)}, result);
  }
  return {catalog, async handle(identity, message) {
    owner(identity);
    if (message.method === 'initialize') return {jsonrpc: '2.0', id: message.id, result: {...initialize, instructions: initialize.instructions + ' Remote calls require their exact connectionRef. Generate a fresh attemptId for a new invitation and an operationId before each recoverable modification. Lost responses are queried with their original IDs, never replayed with new IDs.'}};
    if (message.method === 'tools/list') return {jsonrpc: '2.0', id: message.id, result: {tools: catalog,_meta:{'vrch.ai/catalog':catalogInfo}}};
    if (message.method === 'ping') return {jsonrpc: '2.0', id: message.id, result: {}};
    if (message.method !== 'tools/call') return {jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Method not found'}};
    try {return {jsonrpc: '2.0', id: message.id, result: await call(identity, message.params?.name, message.params?.arguments || {})};}
    catch (error) {
      const code = error.code || 'connection_unavailable';
      const help = code === 'invalid_connection_arguments' ? 'For a new invitation supply url and a fresh lowercase UUID attemptId. To resume supply only the original connectionRef and resume:true.'
        : code === 'unsupported_tool' ? hostedInstructions : code === 'control_changed' ? 'Control changed while this input was queued. Read the current state before deciding on a new action; do not replay automatically.' : undefined;
      const value = {phase: 'failed', retryable: false, code, ...(help ? {message:help} : {})};
      return {jsonrpc: '2.0', id: message.id, result: envelopes(value, {isError: true, content: content(value)})};
    }
  }, close() {if (closed) return; for (const entry of active.values()) entry.shutdown('service_restarted'); active.clear(); closed = true; db.close();}};
}
