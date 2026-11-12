// Browser-owned hosted targets. A trusted Pages tab connects outward over WSS
// and keeps App source, execution and storage local. This module stores only
// target secret hashes, invitation hashes and approval lifecycle state; tool
// arguments, results and images stay in memory for one bounded call.
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {lstatSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {WebSocketServer} from 'ws';

const fail = code => Object.assign(Error(code), {code});
const sha = value => createHash('sha256').update(value).digest('hex');
const token = (size = 32) => randomBytes(size).toString('base64url');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const TARGET_ID = /^[a-f0-9]{32}$/, DEVICE_ID = /^web_([a-f0-9]{32})$/, INVITE = /^[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_-]{16,128}$/, PAIRING_ID = /^[A-Za-z0-9_-]{1,128}$/, TOOL = /^[a-z][a-z0-9_]{0,63}$/, CODE = /^[a-z_]{1,64}$/;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PROOF_KIND = 'vrch-browser-target-v1';

// Same bytes as Python json.dumps(sort_keys=True, separators=(",", ":")) used by
// the existing Apps pairing review, so one reviewDigest means one challenge.
export function reviewDigest(challenge) {
  const sort = value => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  const text = JSON.stringify(sort(challenge)).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return sha(text);
}

function openDatabase(filename) {
  if (filename !== ':memory:') {
    const parent = lstatSync(dirname(filename));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw fail('unsafe_target_storage');
    try {
      const info = lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('unsafe_target_storage');
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS browser_targets(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, origin TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS browser_invites(hash TEXT PRIMARY KEY, target TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS browser_approvals(id TEXT PRIMARY KEY, target TEXT NOT NULL, connection_ref TEXT NOT NULL UNIQUE,
      oauth_client TEXT NOT NULL, epoch INTEGER NOT NULL, owner TEXT NOT NULL, paused INTEGER NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS browser_approvals_target ON browser_approvals(target, state);`);
  if (!db.prepare('PRAGMA table_info(browser_targets)').all().some(column => column.name === 'last_seen'))
    db.exec('ALTER TABLE browser_targets ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0');
  return db;
}

export function createBrowserTargets({filename, issuer, allowedOrigins, clock = () => Date.now(), onDiagnostic = () => {},
  helloTimeoutMs = 10000, callTimeoutMs = 45000, pingMs = 20000, inviteTtlMs = 600000,
  registrationLimit = 20, registrationWindowMs = 60000, maxSockets = 512,
  maxTargets = 4096, idleTargetMs = 24 * 3600000, sweepMs = 3600000,
  maxPayload = 7 * 1024 * 1024, maxControlBytes = 65536, maxCallBytes = 2 * 1024 * 1024, maxPending = 8,
  maxImages = 4, maxImageBase64 = 1398104, maxTotalImageBase64 = 6 * 1024 * 1024} = {}) {
  const issuerURL = new URL(issuer);
  if (issuerURL.protocol !== 'https:' || issuerURL.origin !== issuer || !Array.isArray(allowedOrigins) || !allowedOrigins.length) throw fail('invalid_configuration');
  const origins = new Set(allowedOrigins.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw fail('invalid_configuration');
    return value;
  }));
  for (const value of [helloTimeoutMs, callTimeoutMs, pingMs, inviteTtlMs, registrationLimit, registrationWindowMs, maxSockets, maxTargets, idleTargetMs, sweepMs, maxPayload, maxControlBytes, maxCallBytes, maxPending, maxImages, maxImageBase64, maxTotalImageBase64])
    if (!Number.isSafeInteger(value) || value < 1) throw fail('invalid_configuration');
  const db = openDatabase(filename);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try {const result = fn(); db.exec('COMMIT'); return result;} catch (error) {db.exec('ROLLBACK'); throw error;}
  };
  const wss = new WebSocketServer({noServer: true, maxPayload, perMessageDeflate: false, clientTracking: false});
  const sessions = new Map(), live = new Set(), proofs = new Map();
  let registrations = [], auth = null, closed = false;

  const approvalOf = targetId => db.prepare("SELECT * FROM browser_approvals WHERE target=? AND state='active'").get(targetId) || null;
  const grantOf = row => row ? {connectionRef: row.connection_ref, approvalId: row.id, epoch: row.epoch, owner: row.owner, paused: !!row.paused} : null;
  const send = (session, frame) => {if (session?.ws.readyState === 1) session.ws.send(JSON.stringify(frame));};
  const envelope = value => ({isError: true, content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value});
  const notSent = code => envelope({phase: 'failed', code, delivery: 'not_sent', retryable: false});
  const unknown = code => envelope({phase: 'outcome_unknown', code, retryable: false});

  const heartbeat = setInterval(() => {
    for (const ws of live) {
      if (ws.vrchAlive === false) {ws.vrchCloseReason='browser_heartbeat_timeout';ws.terminate(); continue;}
      ws.vrchAlive = false; try {ws.ping();} catch {}
    }
  }, pingMs);
  heartbeat.unref();

  // Idle targets without an active approval, and expired invitations, do not
  // accumulate behind the public entry. Approved or connected targets stay.
  let lastSweep = -Infinity;
  function sweep(force = false) {
    const now = clock();
    if (!force && now - lastSweep < 60000) return;
    lastSweep = now;
    transaction(() => {
      db.prepare('DELETE FROM browser_invites WHERE expires<=?').run(now);
      const stale = db.prepare("SELECT id FROM browser_targets WHERE last_seen<=? AND id NOT IN (SELECT target FROM browser_approvals WHERE state='active')").all(now - idleTargetMs);
      for (const {id} of stale) {
        if (sessions.has(id)) continue;
        db.prepare('DELETE FROM browser_invites WHERE target=?').run(id);
        db.prepare('DELETE FROM browser_approvals WHERE target=?').run(id);
        db.prepare('DELETE FROM browser_targets WHERE id=?').run(id);
      }
    });
  }
  const sweeper = setInterval(() => {try {sweep(true);} catch {}}, sweepMs);
  sweeper.unref();
  const targetCount = () => db.prepare('SELECT COUNT(*) AS count FROM browser_targets').get().count;

  function emit(binding, event) {
    if (binding.phase === 'ended' && event.type !== 'ended') return;
    try {binding.onEvent(event);} catch {}
  }
  function settle(call, result) {
    if (call.done) return;
    call.done = true; clearTimeout(call.timer);
    call.binding.calls.delete(call.id); call.session.calls.delete(call.id);
    call.resolve(result);
  }
  function end(binding, code) {
    if (binding.phase === 'ended') return;
    binding.phase = 'ended';
    for (const call of [...binding.calls.values()]) settle(call, unknown('connection_interrupted'));
    const session = binding.session;
    if (session?.pending?.binding === binding) {
      clearTimeout(session.pending.timer);
      send(session, {type: 'ai_join_cancel', requestId: session.pending.requestId, code});
      session.pending = null;
    }
    if (session?.binding === binding) {
      session.binding = null;
      send(session, {type: 'ai_presence', connectionRef: binding.connectionRef, present: false, code});
    }
    emit(binding, {type: 'ended', code});
  }
  function collaboration(session, row) {
    return {type: 'collaboration', epoch: row.epoch, owner: row.owner, paused: !!row.paused, approvalId: row.id,
      assistantCapabilities: session.capabilities ? structuredClone(session.capabilities) : {}};
  }
  function bind(session, binding, row, event) {
    binding.phase = 'attached'; binding.session = session; session.binding = binding;
    emit(binding, event);
    emit(binding, collaboration(session, row));
    send(session, {type: 'ai_presence', connectionRef: binding.connectionRef, present: true});
  }

  function start(binding) {
    if (binding.started) return;
    binding.started = true;
    if (closed) return end(binding, 'service_restarted');
    const {targetId} = binding.target, session = sessions.get(targetId), row = approvalOf(targetId);
    if (binding.resume) {
      if (!row || row.connection_ref !== binding.connectionRef || !same(row.oauth_client, binding.oauthClientId)) return end(binding, 'ai_resume_denied');
      if (!session) return end(binding, 'browser_offline');
      if (session.binding && session.binding !== binding) end(session.binding, 'browser_connection_replaced');
      return bind(session, binding, row, {type: 'ai_resumed', leaseExpiresAt: 0});
    }
    const inviteHash = binding.target.inviteHash;
    if (row || !session || session.pending || typeof inviteHash !== 'string') return end(binding, 'invite_unavailable');
    const invite = db.prepare('SELECT * FROM browser_invites WHERE hash=? AND target=?').get(inviteHash, targetId);
    if (!invite || invite.used) return end(binding, 'invite_unavailable');
    if (invite.expires <= clock()) return end(binding, 'invite_expired');
    if (db.prepare('UPDATE browser_invites SET used=1 WHERE hash=? AND used=0').run(inviteHash).changes !== 1) return end(binding, 'invite_unavailable');
    const requestId = token(16), expiresAt = invite.expires;
    const pending = {requestId, binding, expiresAt};
    pending.timer = setTimeout(() => {if (session.pending === pending) end(binding, 'invite_expired');}, Math.max(0, expiresAt - clock()));
    pending.timer.unref?.();
    session.pending = pending; binding.phase = 'pending'; binding.session = session;
    send(session, {type: 'ai_join', requestId, connectionRef: binding.connectionRef, clientId: binding.oauthClientId, expiresAt});
    emit(binding, {type: 'ai_pending', requestId, inviteExpiresAt: expiresAt, assistantProtocol: PROOF_KIND});
  }

  function validResult(value) {
    if (!plain(value) || !Array.isArray(value.content) || !value.content.length || value.content.length > 64) throw fail('invalid_result');
    if (value.isError !== undefined && typeof value.isError !== 'boolean') throw fail('invalid_result');
    if (value.structuredContent !== undefined && !plain(value.structuredContent)) throw fail('invalid_result');
    let images = 0, imageBytes = 0;
    const content = value.content.map(item => {
      if (plain(item) && item.type === 'text' && typeof item.text === 'string') return {type: 'text', text: item.text};
      if (plain(item) && item.type === 'image' && IMAGE_TYPES.has(item.mimeType) && typeof item.data === 'string'
          && item.data.length <= maxImageBase64 && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
        images++; imageBytes += item.data.length;
        return {type: 'image', data: item.data, mimeType: item.mimeType};
      }
      throw fail('invalid_result');
    });
    if (images > maxImages || imageBytes > maxTotalImageBase64) throw fail('invalid_result');
    return {content, ...(value.isError ? {isError: true} : {}), ...(value.structuredContent ? {structuredContent: value.structuredContent} : {})};
  }

  function request(binding, name, args) {
    const session = binding.session;
    const pendingReport=name==='ai_report'&&binding.phase==='pending'&&session?.pending?.binding===binding&&session.pending.expiresAt>clock();
    if (closed || !pendingReport&&(binding.phase !== 'attached' || session?.binding !== binding) || session?.ws.readyState !== 1) return Promise.resolve(notSent('disconnected'));
    if (typeof name !== 'string' || !TOOL.test(name) || !plain(args)) return Promise.resolve(notSent('invalid_request'));
    const row = approvalOf(binding.target.targetId);
    if (!pendingReport&&(!row || row.connection_ref !== binding.connectionRef)) return Promise.resolve(notSent('approval_required'));
    if (row?.paused) return Promise.resolve(notSent('ai_paused'));
    if (binding.calls.size >= maxPending) return Promise.resolve(notSent('busy'));
    if(pendingReport&&(typeof args.message!=='string'||!args.message.trim()||args.message.length>280))return Promise.resolve(notSent('invalid_request'));
    const id = token(16), deadlineAt = clock() + callTimeoutMs;
    let frame;
    try {frame = JSON.stringify({type: pendingReport?'pending_report':'call', ...(pendingReport?{requestId:session.pending.requestId}:{}), id, connectionRef: binding.connectionRef, approvalId: row?.id, epoch: row?.epoch, name, arguments: args, deadlineAt, timeoutMs: callTimeoutMs});}
    catch {return Promise.resolve(notSent('invalid_request'));}
    if (Buffer.byteLength(frame) > maxCallBytes) return Promise.resolve(notSent('request_too_large'));
    return new Promise(resolve => {
      const call = {id, epoch: row?.epoch, binding, session, resolve, done: false};
      call.timer = setTimeout(() => settle(call, unknown('request_timeout')), callTimeoutMs);
      call.timer.unref?.();
      binding.calls.set(id, call); session.calls.set(id, call);
      session.ws.send(frame, error => {if (error) settle(call, unknown('connection_interrupted'));});
    });
  }

  function detach(session, code) {
    if (sessions.get(session.targetId) === session) sessions.delete(session.targetId);
    if (session.pending) end(session.pending.binding, code);
    if (session.binding) end(session.binding, code);
    for (const call of [...session.calls.values()]) settle(call, unknown('connection_interrupted'));
    session.reviews.clear();
  }

  const handlers = {
    invite(session) {
      if (approvalOf(session.targetId)) throw fail('ai_already_approved');
      if (session.pending) throw fail('request_pending');
      const invite = token(), expiresAt = clock() + inviteTtlMs;
      transaction(() => {
        db.prepare('DELETE FROM browser_invites WHERE target=?').run(session.targetId);
        db.prepare('INSERT INTO browser_invites(hash,target,expires) VALUES(?,?,?)').run(sha(invite), session.targetId, expiresAt);
      });
      return {url: issuer + '/synth/target?invite=' + invite, expiresAt};
    },
    decision(session, {requestId, connectionRef, allow, owner = 'human'}) {
      const pending = session.pending;
      if (typeof allow !== 'boolean' || !['human','ai'].includes(owner) || !pending || pending.requestId !== requestId || pending.binding.connectionRef !== connectionRef) throw fail('request_unavailable');
      const binding = pending.binding;
      if (pending.expiresAt <= clock()) {end(binding, 'invite_expired'); throw fail('request_unavailable');}
      clearTimeout(pending.timer); session.pending = null;
      if (!allow) {end(binding, 'invite_rejected'); return {phase: 'denied'};}
      let row;
      try {
        row = transaction(() => {
          if (approvalOf(session.targetId)) throw fail('ai_already_approved');
          const id = token(16);
          db.prepare("INSERT INTO browser_approvals(id,target,connection_ref,oauth_client,epoch,owner,paused,state,updated) VALUES(?,?,?,?,1,?,0,'active',?)")
            .run(id, session.targetId, binding.connectionRef, binding.oauthClientId, owner, clock());
          db.prepare('DELETE FROM browser_invites WHERE target=?').run(session.targetId);
          return approvalOf(session.targetId);
        });
      } catch (error) {end(binding, 'approval_storage_failed'); throw fail(error.code === 'ai_already_approved' ? error.code : 'approval_storage_failed');}
      send(session, {type: 'grant', grant: grantOf(row)});
      bind(session, binding, row, {type: 'ai_approved', requestId, leaseExpiresAt: 0});
      return {phase: 'approved', grant: grantOf(row)};
    },
    revoke(session, {connectionRef}) {
      if (session.pending && session.pending.binding.connectionRef === connectionRef) {end(session.pending.binding, 'invite_canceled'); return {grant: grantOf(approvalOf(session.targetId))};}
      const row = approvalOf(session.targetId);
      if (!row || row.connection_ref !== connectionRef) throw fail('grant_unavailable');
      db.prepare("UPDATE browser_approvals SET state='revoked',updated=? WHERE id=?").run(clock(), row.id);
      if (session.binding?.connectionRef === connectionRef) end(session.binding, 'ai_revoked');
      send(session, {type: 'grant', grant: null});
      return {grant: null};
    },
    control(session, {connectionRef, owner, paused}) {
      if (!['human', 'ai'].includes(owner) || typeof paused !== 'boolean') throw fail('invalid_request');
      const row = transaction(() => {
        const current = approvalOf(session.targetId);
        if (!current || current.connection_ref !== connectionRef) throw fail('grant_unavailable');
        db.prepare('UPDATE browser_approvals SET epoch=epoch+1,owner=?,paused=?,updated=? WHERE id=?').run(owner, paused ? 1 : 0, clock(), current.id);
        return approvalOf(session.targetId);
      });
      const binding = session.binding;
      if (binding?.connectionRef === connectionRef) {
        for (const call of [...binding.calls.values()]) if (call.epoch !== row.epoch) settle(call, unknown('control_changed'));
        emit(binding, collaboration(session, row));
      }
      send(session, {type: 'grant', grant: grantOf(row)});
      return {grant: grantOf(row)};
    },
    pair_prepare(session, {pairingId}) {
      if (!auth) throw fail('pairing_unavailable');
      if (typeof pairingId !== 'string' || !PAIRING_ID.test(pairingId)) throw fail('invalid_request');
      const challenge = auth.challenge(pairingId), digest = reviewDigest(challenge);
      session.reviews.delete(pairingId); session.reviews.set(pairingId, digest);
      while (session.reviews.size > 4) session.reviews.delete(session.reviews.keys().next().value);
      return {...challenge, reviewDigest: digest};
    },
    async pair_decide(session, {pairingId, allow, expectedDigest}) {
      if (!auth) throw fail('pairing_unavailable');
      if (typeof pairingId !== 'string' || !PAIRING_ID.test(pairingId) || typeof allow !== 'boolean') throw fail('invalid_request');
      const reviewed = session.reviews.get(pairingId);
      if (!reviewed || !same(reviewed, expectedDigest)) throw fail('pairing_changed');
      const challenge = auth.challenge(pairingId);
      if (!same(reviewDigest(challenge), expectedDigest)) throw fail('pairing_changed');
      if (session.pairing) throw fail('busy');
      const proof = token();
      proofs.set(proof, {targetId: session.targetId, expected: {...challenge, decision: allow ? 'approve' : 'deny'}, expires: clock() + 60000});
      session.pairing = true;
      try {
        const result = await (allow ? auth.approve : auth.deny)(pairingId, {kind: PROOF_KIND, proof});
        session.reviews.delete(pairingId);
        return {phase: result.phase};
      } finally {proofs.delete(proof); session.pairing = false;}
    }
  };

  function hello(ws, origin, message) {
    if (!plain(message) || message.type !== 'hello') throw fail('hello_required');
    let capabilities = null;
    if (message.capabilities !== undefined) {
      if (!plain(message.capabilities) || JSON.stringify(message.capabilities).length > 16384) throw fail('invalid_request');
      capabilities = message.capabilities;
    }
    let targetId, secret = null;
    if (message.targetId === undefined && message.secret === undefined) {
      const now = clock();
      registrations = registrations.filter(time => time > now - registrationWindowMs);
      if (registrations.length >= registrationLimit) throw fail('rate_limited');
      sweep();
      if (targetCount() >= maxTargets) {sweep(true); if (targetCount() >= maxTargets) throw fail('capacity');}
      registrations.push(now);
      targetId = randomBytes(16).toString('hex'); secret = token();
      db.prepare('INSERT INTO browser_targets(id,secret_hash,origin,created,last_seen) VALUES(?,?,?,?,?)').run(targetId, sha(secret), origin, now, now);
    } else {
      if (typeof message.targetId !== 'string' || !TARGET_ID.test(message.targetId) || typeof message.secret !== 'string' || message.secret.length > 128) throw fail('target_unauthorized');
      const row = db.prepare('SELECT * FROM browser_targets WHERE id=?').get(message.targetId);
      if (!row || !same(row.secret_hash, sha(message.secret)) || row.origin !== origin) throw fail('target_unauthorized');
      targetId = row.id;
      // One live owner socket per target. A dead network peer is cleared by
      // the heartbeat; a second tab never silently takes over. A tab of the same
      // browser (it holds the target secret) where the person asked for AI sends
      // takeOver: the old socket is told target_moved and closed (4410), and its
      // bound AI ends as when a tab closes.
      if (message.takeOver !== undefined && typeof message.takeOver !== 'boolean') throw fail('invalid_request');
      const current = sessions.get(targetId);
      if (current) {
        if (message.takeOver !== true) throw fail('target_busy');
        detach(current, 'disconnected');
        try {current.ws.send(JSON.stringify({type: 'error', code: 'target_moved'}));} catch {}
        current.ws.close(4410, 'target_moved');
      }
      db.prepare('UPDATE browser_targets SET last_seen=? WHERE id=?').run(clock(), targetId);
    }
    const session = {targetId, ws, capabilities, pending: null, binding: null, calls: new Map(), reviews: new Map(), pairing: false};
    sessions.set(targetId, session);
    ws.send(JSON.stringify({type: 'hello', targetId, ...(secret ? {secret} : {}), grant: grantOf(approvalOf(targetId))}));
    return session;
  }

  function frame(session, message, size) {
    if (!plain(message) || typeof message.type !== 'string') {session.ws.close(1008, 'invalid_frame'); return;}
    if (message.type === 'result') {
      const call = typeof message.id === 'string' ? session.calls.get(message.id) : null;
      if (!call) return; // Late, stale-epoch or foreign results are discarded.
      try {settle(call, validResult(message.result));} catch {settle(call, unknown('invalid_result'));}
      return;
    }
    if (size > maxControlBytes) {session.ws.close(1009, 'frame_too_large'); return;}
    const id = message.id;
    if (!(typeof id === 'string' && id.length >= 1 && id.length <= 64 || Number.isSafeInteger(id))) {session.ws.close(1008, 'invalid_frame'); return;}
    const handler = Object.hasOwn(handlers, message.type) ? handlers[message.type] : null;
    const reply = body => send(session, {type: 'result', id, ...body});
    if (!handler) return reply({error: {code: 'unsupported_request'}});
    Promise.resolve().then(() => handler(session, message)).then(result => reply({result}),
      error => reply({error: {code: typeof error?.code === 'string' && CODE.test(error.code) ? error.code : 'request_failed'}}));
  }

  function onSocket(ws, origin) {
    live.add(ws); ws.vrchAlive = true;const openedAt=clock();
    let session = null;
    const timer = setTimeout(() => ws.close(4408, 'hello_timeout'), helloTimeoutMs);
    ws.on('pong', () => {ws.vrchAlive = true;});
    ws.on('error', () => {ws.vrchCloseReason||='browser_socket_error';});
    ws.on('message', (data, binary) => {
      if (binary) {ws.close(1003, 'text_only'); return;}
      let message;
      try {message = JSON.parse(data.toString('utf8'));} catch {ws.close(1007, 'invalid_json'); return;}
      if (session) return frame(session, message, data.length);
      clearTimeout(timer);
      if (data.length > maxControlBytes) {ws.close(1009, 'frame_too_large'); return;}
      try {session = hello(ws, origin, message);}
      catch (error) {
        const closeCodes = {rate_limited: 4429, invalid_request: 1008, target_busy: 4409, capacity: 4503, target_unauthorized: 4401};
        const code = Object.hasOwn(closeCodes, error.code) ? error.code : 'target_unauthorized';
        ws.send(JSON.stringify({type: 'error', code}));
        ws.close(closeCodes[code], code);
      }
    });
    ws.on('close', (closeCode) => {
      clearTimeout(timer); live.delete(ws);
      if (session && sessions.get(session.targetId) === session) {
        const code=closed?'service_restarted':ws.vrchCloseReason||(closeCode===1000||closeCode===1001||closeCode===1005?'browser_peer_closed':closeCode===1006?'browser_connection_lost':'browser_protocol_closed');
        try{onDiagnostic({event:'browser_disconnected',code,closeCode,inFlight:session.calls.size,uptimeMs:Math.max(0,clock()-openedAt)});}catch{}
        detach(session, code);
        if (!closed) db.prepare('UPDATE browser_targets SET last_seen=? WHERE id=?').run(clock(), session.targetId);
      }
    });
  }

  return {
    upgrade(req, socket, head) {
      const reject = (status, text) => {try {socket.write('HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');} catch {} socket.destroy();};
      if (closed) return reject(503, 'Service Unavailable');
      let url;
      try {url = new URL(req.url, issuer);} catch {return reject(400, 'Bad Request');}
      if (url.pathname !== '/synth/targets' || url.search) return reject(404, 'Not Found');
      const origin = req.headers.origin;
      if (req.headers.host !== issuerURL.host || typeof origin !== 'string' || origin === 'null' || !origins.has(origin)) return reject(403, 'Forbidden');
      if (live.size >= maxSockets) return reject(503, 'Service Unavailable');
      wss.handleUpgrade(req, socket, head, ws => onSocket(ws, origin));
    },
    async resolve(invitation, {deviceId, resume = false} = {}) {
      if (closed) throw fail('service_unavailable');
      if (resume === true) {
        const match = typeof deviceId === 'string' && DEVICE_ID.exec(deviceId);
        if (!match || !db.prepare('SELECT id FROM browser_targets WHERE id=?').get(match[1])) throw fail('target_unavailable');
        return {kind: 'browser', deviceId, origin: issuer, targetId: match[1]};
      }
      let url;
      try {url = new URL(invitation);} catch {throw fail('target_unavailable');}
      const value = url.searchParams.get('invite');
      if (url.origin !== issuer || url.pathname !== '/synth/target' || url.username || url.password || url.hash
          || [...url.searchParams.keys()].join() !== 'invite' || !INVITE.test(value || '')) throw fail('target_unavailable');
      const inviteHash = sha(value);
      const invite = db.prepare('SELECT * FROM browser_invites WHERE hash=?').get(inviteHash);
      if (!invite || invite.used || invite.expires <= clock() || deviceId !== undefined && deviceId !== 'web_' + invite.target) throw fail('target_unavailable');
      return {kind: 'browser', deviceId: 'web_' + invite.target, origin: issuer, targetId: invite.target, inviteHash};
    },
    attach(target, {connectionRef, oauthClientId, resume = false, onEvent} = {}) {
      if (!target || target.kind !== 'browser' || !TARGET_ID.test(target.targetId || '') || target.deviceId !== 'web_' + target.targetId
          || typeof connectionRef !== 'string' || !REF.test(connectionRef) || typeof oauthClientId !== 'string' || !oauthClientId || oauthClientId.length > 2048
          || typeof onEvent !== 'function') throw fail('invalid_attachment');
      const binding = {target: {targetId: target.targetId, inviteHash: resume ? null : target.inviteHash}, connectionRef, oauthClientId,
        resume: resume === true, onEvent, phase: 'idle', started: false, session: null, calls: new Map()};
      return {
        start: () => start(binding),
        request: (name, args = {}) => request(binding, name, args),
        close: reason => end(binding, typeof reason === 'string' && CODE.test(reason) ? reason : 'client_closed')
      };
    },
    bindPairing(value) {
      if (!value || typeof value.challenge !== 'function' || typeof value.approve !== 'function' || typeof value.deny !== 'function') throw fail('invalid_configuration');
      auth = value;
    },
    async verifyPairing(expected, proof) {
      const entry = plain(proof) && proof.kind === PROOF_KIND && typeof proof.proof === 'string' ? proofs.get(proof.proof) : null;
      if (entry) proofs.delete(proof.proof);
      const keys = entry && Object.keys(entry.expected).sort();
      if (!entry || entry.expires <= clock() || !plain(expected) || keys.join() !== Object.keys(expected).sort().join()
          || keys.some(key => entry.expected[key] !== expected[key])) throw fail('invalid_pairing_proof');
      return {deviceId: 'web_' + entry.targetId};
    },
    close() {
      if (closed) return;
      closed = true; clearInterval(heartbeat); clearInterval(sweeper);
      for (const session of [...sessions.values()]) {detach(session, 'service_restarted'); session.ws.close(1012, 'service_restarted');}
      for (const ws of live) ws.terminate();
      proofs.clear(); wss.close(); db.close();
    }
  };
}
