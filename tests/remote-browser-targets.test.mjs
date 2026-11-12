import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
const [major,minor]=process.versions.node.split('.').map(Number);
const hostedSupported=major>22||major===22&&minor>=13;
const {createBrowserTargets,reviewDigest}=hostedSupported?await import('../remote/browser-targets.mjs'):{};
const {createPairingAuthorization}=hostedSupported?await import('../src/remote-auth.mjs'):{};
const {createRemoteRouter}=hostedSupported?await import('../src/remote-router.mjs'):{};
const hostedTest=(name,run)=>test(name,{skip:!hostedSupported},run);

const ISSUER = 'https://mcp.example.test', HOST = 'mcp.example.test';
const ORIGIN = 'https://pages.example.test', ORIGIN2 = 'https://dev-pages.example.test';
const CID = 'https://chatgpt.com/oauth/client.json', CID2 = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const REF1 = 'ref1' + 'A'.repeat(28), REF2 = 'ref2' + 'B'.repeat(28), REF3 = 'ref3' + 'C'.repeat(28);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

async function harness(options = {}) {
  const dir = options.dir || mkdtempSync(join(tmpdir(), 'vrch-browser-targets-'));
  const filename = join(dir, 'targets.sqlite');
  const make = () => createBrowserTargets({filename, issuer: ISSUER, allowedOrigins: [ORIGIN, ORIGIN2], callTimeoutMs: 600, ...options});
  const state = {targets: make(), dir, filename};
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => state.targets.upgrade(req, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  state.port = server.address().port;
  state.restart = () => {state.targets.close(); state.targets = make();};
  state.stop = () => {state.targets.close(); server.close();};
  return state;
}

function rejected(port, {path = '/synth/targets', origin = ORIGIN, host = HOST} = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + path, {headers: {Host: host}, ...(origin === null ? {} : {origin})});
    ws.on('unexpected-response', (_req, res) => {resolve(res.statusCode); ws.terminate();});
    ws.on('open', () => {resolve('opened'); ws.close();});
    ws.on('error', () => resolve('error'));
  });
}

async function browser(port, {origin = ORIGIN, hello = {}, options = {}} = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/synth/targets', {headers: {Host: HOST}, origin, ...options});
  const queue = [], waiters = [];
  const closed = new Promise(resolve => ws.on('close', code => resolve(code)));
  ws.on('message', data => {
    const message = JSON.parse(data);
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else queue.push(message);
  });
  await once(ws, 'open');
  const next = (match = () => true, ms = 2000) => {
    const index = queue.findIndex(match);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {match, resolve}; waiters.push(waiter);
      setTimeout(() => {const at = waiters.indexOf(waiter); if (at >= 0) {waiters.splice(at, 1); reject(Error('browser frame timeout'));}}, ms);
    });
  };
  let sequence = 0;
  const call = async (type, fields = {}) => {
    const id = 'r' + ++sequence;
    ws.send(JSON.stringify({type, id, ...fields}));
    return next(message => message.type === 'result' && message.id === id);
  };
  ws.send(JSON.stringify({type: 'hello', ...hello}));
  const welcome = await next(message => message.type === 'hello' || message.type === 'error');
  return {ws, next, call, welcome, closed, queue, send: value => ws.send(JSON.stringify(value))};
}

function agent(targets, target, options) {
  const events = [];
  const handle = targets.attach(target, {oauthClientId: CID, ...options, onEvent: event => events.push(event)});
  const until = async (match, ms = 2000) => {
    for (const started = Date.now(); Date.now() - started < ms; await delay(5)) {const found = events.find(match); if (found) return found;}
    throw Error('event timeout: ' + JSON.stringify(events));
  };
  return {...handle, events, until, ended: () => until(event => event.type === 'ended')};
}
const code = result => result.structuredContent?.code;

hostedTest('browser targets keep approvals across restart without replaying calls', async () => {
  const h = await harness();
  try {
    assert.equal(await rejected(h.port, {path: '/synth/other'}), 404);
    assert.equal(await rejected(h.port, {path: '/synth/targets?x=1'}), 404);
    assert.equal(await rejected(h.port, {origin: null}), 403);
    assert.equal(await rejected(h.port, {origin: 'null'}), 403);
    assert.equal(await rejected(h.port, {origin: 'https://evil.example'}), 403);
    assert.equal(await rejected(h.port, {host: 'other.example'}), 403);

    const a = await browser(h.port), b = await browser(h.port);
    assert.match(a.welcome.targetId, /^[a-f0-9]{32}$/); assert.equal(a.welcome.grant, null); assert.match(a.welcome.secret, /^[A-Za-z0-9_-]{43}$/);
    const idA = a.welcome.targetId, secretA = a.welcome.secret, idB = b.welcome.targetId, secretB = b.welcome.secret;
    const wrong = await browser(h.port, {hello: {targetId: idA, secret: 'x'.repeat(43)}});
    assert.deepEqual(wrong.welcome, {type: 'error', code: 'target_unauthorized'}); assert.equal(await wrong.closed, 4401);
    const otherOrigin = await browser(h.port, {origin: ORIGIN2, hello: {targetId: idA, secret: secretA}});
    assert.equal(otherOrigin.welcome.code, 'target_unauthorized');

    const invite = (await a.call('invite')).result;
    assert.match(invite.url, /^https:\/\/mcp\.example\.test\/synth\/target\?invite=[A-Za-z0-9_-]{43}$/);
    await assert.rejects(h.targets.resolve(invite.url, {deviceId: 'web_' + idB}), {code: 'target_unavailable'});
    await assert.rejects(h.targets.resolve(invite.url.replace('mcp.example.test', 'evil.example')), {code: 'target_unavailable'});
    await assert.rejects(h.targets.resolve(invite.url + '&x=1'), {code: 'target_unavailable'});
    await assert.rejects(h.targets.resolve(undefined, {deviceId: 'web_' + 'f'.repeat(32), resume: true}), {code: 'target_unavailable'});
    const target = await h.targets.resolve(invite.url);
    assert.equal(target.kind, 'browser'); assert.equal(target.deviceId, 'web_' + idA); assert.equal(target.origin, ISSUER); assert.equal(target.targetId, idA);

    const ai = agent(h.targets, target, {connectionRef: REF1});
    ai.start();
    const join = await a.next(message => message.type === 'ai_join');
    assert.equal(join.connectionRef, REF1); assert.equal(join.clientId, CID); assert.equal(join.expiresAt, invite.expiresAt);
    assert.equal(ai.events[0].type, 'ai_pending'); assert.equal(ai.events[0].inviteExpiresAt, invite.expiresAt);
    assert.equal((await a.call('invite')).error.code, 'request_pending');
    assert.equal((await b.call('decision', {requestId: join.requestId, connectionRef: REF1, allow: true})).error.code, 'request_unavailable');
    const reused = agent(h.targets, target, {connectionRef: REF2}); reused.start();
    assert.equal((await reused.ended()).code, 'invite_unavailable');

    const decision = await a.call('decision', {requestId: join.requestId, connectionRef: REF1, allow: true});
    assert.equal(decision.result.phase, 'approved');
    assert.deepEqual({...decision.result.grant, approvalId: 'x'}, {connectionRef: REF1, approvalId: 'x', epoch: 1, owner: 'human', paused: false});
    await ai.until(event => event.type === 'ai_approved' && event.requestId === join.requestId);
    assert.equal((await ai.until(event => event.type === 'collaboration')).epoch, 1);
    assert.equal((await a.call('invite')).error.code, 'ai_already_approved');

    const first = ai.request('apps_state', {probe: 1});
    const frame = await a.next(message => message.type === 'call');
    assert.deepEqual({...frame, id: 0, deadlineAt: 0}, {type: 'call', id: 0, connectionRef: REF1, approvalId: decision.result.grant.approvalId, epoch: 1, name: 'apps_state', arguments: {probe: 1}, deadlineAt: 0, timeoutMs: 600});
    a.send({type: 'result', id: frame.id, result: {content: [{type: 'text', text: 'RESULT_MARKER'}, {type: 'image', data: PNG, mimeType: 'image/png'}], structuredContent: {ok: true}, extra: 1}});
    assert.deepEqual(await first, {content: [{type: 'text', text: 'RESULT_MARKER'}, {type: 'image', data: PNG, mimeType: 'image/png'}], structuredContent: {ok: true}});

    const foreign = ai.request('apps_state', {});
    const foreignFrame = await a.next(message => message.type === 'call');
    b.send({type: 'result', id: foreignFrame.id, result: {content: [{type: 'text', text: 'FROM_B'}]}});
    await delay(50);
    a.send({type: 'result', id: foreignFrame.id, result: {content: Array.from({length: 5}, () => ({type: 'image', data: PNG, mimeType: 'image/png'}))}});
    assert.equal(code(await foreign), 'invalid_result');
    assert.equal((await foreign).structuredContent.phase, 'outcome_unknown');

    const queued = Array.from({length: 8}, () => ai.request('apps_state', {}));
    const ninth = await ai.request('apps_state', {});
    assert.equal(code(ninth), 'busy'); assert.equal(ninth.structuredContent.delivery, 'not_sent');
    const control = await a.call('control', {connectionRef: REF1, owner: 'ai', paused: false});
    assert.equal(control.result.grant.epoch, 2); assert.equal(control.result.grant.owner, 'ai');
    for (const result of await Promise.all(queued)) assert.equal(code(result), 'control_changed');
    const stale = await a.next(message => message.type === 'call');
    a.send({type: 'result', id: stale.id, result: {content: [{type: 'text', text: 'late'}]}});
    assert.equal((await ai.until(event => event.type === 'collaboration' && event.epoch === 2)).owner, 'ai');
    assert.equal((await b.call('control', {connectionRef: REF1, owner: 'human', paused: true})).error.code, 'grant_unavailable');
    assert.equal((await b.call('revoke', {connectionRef: REF1})).error.code, 'grant_unavailable');
    assert.equal(code(await ai.request('BAD-NAME', {})), 'invalid_request');
    assert.equal(code(await ai.request('apps_state', {})), 'request_timeout');

    const interrupted = ai.request('apps_state', {});
    while (!(await a.next(message => message.type === 'call')).epoch);
    a.ws.close();
    assert.equal(code(await interrupted), 'connection_interrupted');
    assert.equal((await ai.ended()).code, 'browser_peer_closed');
    assert.equal(code(await ai.request('apps_state', {})), 'disconnected');

    const a2 = await browser(h.port, {hello: {targetId: idA, secret: secretA}});
    assert.equal(a2.welcome.secret, undefined);
    assert.deepEqual({...a2.welcome.grant, approvalId: 'x'}, {connectionRef: REF1, approvalId: 'x', epoch: 2, owner: 'ai', paused: false});
    const resumeTarget = await h.targets.resolve(undefined, {deviceId: 'web_' + idA, resume: true});
    const otherRef = agent(h.targets, resumeTarget, {connectionRef: REF2, resume: true}); otherRef.start();
    assert.equal((await otherRef.ended()).code, 'ai_resume_denied');
    const otherClient = agent(h.targets, resumeTarget, {connectionRef: REF1, oauthClientId: CID2, resume: true}); otherClient.start();
    assert.equal((await otherClient.ended()).code, 'ai_resume_denied');
    const resumed = agent(h.targets, resumeTarget, {connectionRef: REF1, resume: true}); resumed.start();
    await resumed.until(event => event.type === 'ai_resumed');
    assert.equal((await resumed.until(event => event.type === 'collaboration')).epoch, 2);
    await a2.next(message => message.type === 'ai_presence' && message.present === true);
    assert.equal(a2.queue.some(message => message.type === 'call'), false);
    resumed.close('idle_timeout');
    assert.equal((await resumed.ended()).code, 'idle_timeout');
    assert.equal((await a2.next(message => message.type === 'ai_presence' && message.present === false)).code, 'idle_timeout');

    const inviteB = (await b.call('invite')).result;
    h.restart();
    assert.equal(await a2.closed, 1012);
    const a3 = await browser(h.port, {hello: {targetId: idA, secret: secretA}});
    assert.equal(a3.welcome.grant.epoch, 2);
    const afterRestart = agent(h.targets, await h.targets.resolve(undefined, {deviceId: 'web_' + idA, resume: true}), {connectionRef: REF1, resume: true});
    afterRestart.start();
    await afterRestart.until(event => event.type === 'ai_resumed');
    assert.equal((await a3.call('revoke', {connectionRef: REF1})).result.grant, null);
    assert.equal((await afterRestart.ended()).code, 'ai_revoked');
    const revokedResume = agent(h.targets, resumeTarget, {connectionRef: REF1, resume: true}); revokedResume.start();
    assert.equal((await revokedResume.ended()).code, 'ai_resume_denied');
    assert.ok((await a3.call('invite')).result.url);

    const b2 = await browser(h.port, {hello: {targetId: idB, secret: secretB}});
    const denied = agent(h.targets, await h.targets.resolve(inviteB.url), {connectionRef: REF3}); denied.start();
    const joinB = await b2.next(message => message.type === 'ai_join');
    assert.equal((await b2.call('decision', {requestId: joinB.requestId, connectionRef: REF3, allow: false})).result.phase, 'denied');
    assert.equal((await denied.ended()).code, 'invite_rejected');
    const deniedResume = agent(h.targets, await h.targets.resolve(undefined, {deviceId: 'web_' + idB, resume: true}), {connectionRef: REF3, resume: true});
    deniedResume.start();
    assert.equal((await deniedResume.ended()).code, 'ai_resume_denied');
    h.stop();
    const stored = readFileSync(h.filename).toString('latin1');
    for (const secret of ['RESULT_MARKER', secretA, secretB, invite.url.split('=')[1], PNG]) assert.equal(stored.includes(secret), false);
  } finally {h.stop();}
});

hostedTest('pairing uses one reviewed challenge and a one-time internal browser proof', async () => {
  const h = await harness();
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect', verifier = 'v'.repeat(43);
  const auth = createPairingAuthorization({filename: ':memory:', issuer: ISSUER, resource: ISSUER + '/synth',
    clients: new Map([[CID, {tokenEndpointAuthMethod: 'none', redirectUris: [redirect]}]]), verifyPairing: (expected, proof) => h.targets.verifyPairing(expected, proof)});
  const begin = () => auth.begin({client_id: CID, redirect_uri: redirect, response_type: 'code', resource: ISSUER + '/synth', scope: 'vrch:mcp',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'state-1'});
  try {
    const a = await browser(h.port), b = await browser(h.port);
    assert.equal((await a.call('pair_prepare', {pairingId: 'x'})).error.code, 'pairing_unavailable');
    h.targets.bindPairing(auth);
    const pairing = begin();
    const review = (await a.call('pair_prepare', {pairingId: pairing.id})).result;
    const {reviewDigest: digest, ...challenge} = review;
    assert.deepEqual(challenge, auth.challenge(pairing.id));
    const python = execFileSync('python3', ['-c', 'import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.loads(sys.stdin.read()),separators=(",",":"),sort_keys=True).encode()).hexdigest())'], {input: JSON.stringify(challenge)}).toString().trim();
    assert.equal(digest, python);
    const unicode = {b: 'Vrch \u00e9\u4e2d\ud83d\ude00', a: [1, {d: 'x', c: null}]};
    assert.equal(reviewDigest(unicode), execFileSync('python3', ['-c', 'import hashlib,json,sys; print(hashlib.sha256(json.dumps(json.loads(sys.stdin.read()),separators=(",",":"),sort_keys=True).encode()).hexdigest())'], {input: JSON.stringify(unicode)}).toString().trim());

    assert.equal((await a.call('pair_decide', {pairingId: pairing.id, allow: true, expectedDigest: '0'.repeat(64)})).error.code, 'pairing_changed');
    assert.equal((await b.call('pair_decide', {pairingId: pairing.id, allow: true, expectedDigest: digest})).error.code, 'pairing_changed');
    await assert.rejects(h.targets.verifyPairing({...challenge, decision: 'approve'}, {kind: 'vrch-browser-target-v1', proof: 'guess'}), {code: 'invalid_pairing_proof'});
    await assert.rejects(auth.approve(pairing.id, {kind: 'vrch-browser-target-v1', proof: 'guess'}), {code: 'invalid_pairing_proof'});

    let captured;
    const verify = h.targets.verifyPairing;
    const approved = await a.call('pair_decide', {pairingId: pairing.id, allow: true, expectedDigest: digest});
    assert.equal(approved.result.phase, 'approved');
    const finished = auth.finish(pairing.id, pairing.browserSecret);
    const tokens = auth.exchange({grant_type: 'authorization_code', code: new URL(finished.redirect).searchParams.get('code'), code_verifier: verifier,
      client_id: CID, redirect_uri: redirect, resource: ISSUER + '/synth'});
    assert.equal(auth.authenticate(tokens.access_token).pairedDeviceId, 'web_' + a.welcome.targetId);
    assert.equal((await a.call('pair_decide', {pairingId: pairing.id, allow: true, expectedDigest: digest})).error.code, 'pairing_changed');

    // A proof is bound to the exact challenge and decision, and is consumed once.
    const second = begin();
    const secondReview = (await a.call('pair_prepare', {pairingId: second.id})).result;
    h.targets.bindPairing({challenge: auth.challenge, deny: auth.deny, approve: async (id, proof) => {
      captured = proof;
      await assert.rejects(verify({...auth.challenge(id), decision: 'deny'}, proof), {code: 'invalid_pairing_proof'});
      return {phase: 'approved'};
    }});
    await a.call('pair_decide', {pairingId: second.id, allow: true, expectedDigest: secondReview.reviewDigest});
    await assert.rejects(verify({...auth.challenge(second.id), decision: 'approve'}, captured), {code: 'invalid_pairing_proof'});
    h.targets.bindPairing(auth);
    const thirdReview = (await a.call('pair_prepare', {pairingId: second.id})).result;
    assert.equal((await a.call('pair_decide', {pairingId: second.id, allow: false, expectedDigest: thirdReview.reviewDigest})).result.phase, 'denied');
  } finally {h.stop(); auth.close();}
});

hostedTest('public entry bounds registration, first frame and control frame size', async () => {
  const h = await harness({registrationLimit: 2, helloTimeoutMs: 150, maxControlBytes: 1024, inviteTtlMs: 150});
  try {
    const a = await browser(h.port);
    await browser(h.port);
    const limited = await browser(h.port);
    assert.deepEqual(limited.welcome, {type: 'error', code: 'rate_limited'}); assert.equal(await limited.closed, 4429);

    const silent = new WebSocket('ws://127.0.0.1:' + h.port + '/synth/targets', {headers: {Host: HOST}, origin: ORIGIN});
    assert.equal((await once(silent, 'close'))[0], 4408);

    const invite = (await a.call('invite')).result;
    const ai = agent(h.targets, await h.targets.resolve(invite.url), {connectionRef: REF1}); ai.start();
    const join = await a.next(message => message.type === 'ai_join');
    assert.equal((await ai.ended()).code, 'invite_expired');
    assert.equal((await a.next(message => message.type === 'ai_join_cancel')).requestId, join.requestId);
    assert.equal((await a.call('decision', {requestId: join.requestId, connectionRef: REF1, allow: true})).error.code, 'request_unavailable');
    const expired = (await a.call('invite')).result;
    await delay(200);
    await assert.rejects(h.targets.resolve(expired.url), {code: 'target_unavailable'});

    a.send({type: 'invite', id: 'big', pad: 'x'.repeat(2048)});
    assert.equal(await a.closed, 1009);
    const binary = await browser(h.port, {hello: {targetId: a.welcome.targetId, secret: a.welcome.secret}});
    binary.ws.send(Buffer.from([1, 2, 3]));
    assert.equal(await binary.closed, 1003);
  } finally {h.stop();}
});


hostedTest('a tab of the same browser takes over the live owner only when asked', async () => {
  const h=await harness();
  try {
    const a=await browser(h.port);const credentials={targetId:a.welcome.targetId,secret:a.welcome.secret};
    const invitation=(await a.call('invite')).result;
    const ai=agent(h.targets,await h.targets.resolve(invitation.url),{connectionRef:REF1});ai.start();
    const join=await a.next(m=>m.type==='ai_join');await a.call('decision',{requestId:join.requestId,connectionRef:REF1,allow:true});
    await ai.until(e=>e.type==='collaboration');
    const wrongType=await browser(h.port,{hello:{...credentials,takeOver:'yes'}});
    assert.equal(wrongType.welcome.code,'invalid_request');assert.equal(await wrongType.closed,1008);
    const stranger=await browser(h.port,{hello:{targetId:credentials.targetId,secret:'x'.repeat(43),takeOver:true}});
    assert.equal(stranger.welcome.code,'target_unauthorized');assert.equal(await stranger.closed,4401);
    const b=await browser(h.port,{hello:{...credentials,takeOver:true}});
    assert.equal(b.welcome.type,'hello');assert.equal(b.welcome.targetId,credentials.targetId);assert.equal(b.welcome.grant.connectionRef,REF1,'the approval stays with the target');
    assert.equal((await a.next(m=>m.type==='error')).code,'target_moved');assert.equal(await a.closed,4410);
    assert.equal((await ai.ended()).code,'disconnected','the AI bound to the old tab ends as when a tab closes');
    const c=await browser(h.port,{hello:credentials});
    assert.equal(c.welcome.code,'target_busy','without takeOver the new owner is not replaced');assert.equal(await c.closed,4409);
    assert.equal((await b.call('invite')).error.code,'ai_already_approved','the new tab serves the target');
  } finally {h.stop();}
});

hostedTest('a live owner cannot be replaced; idle unapproved targets expire without deleting approvals', async () => {
  let now=Date.now();const h=await harness({clock:()=>now,maxTargets:2,idleTargetMs:1000,registrationLimit:20});
  try {
    const a=await browser(h.port),b=await browser(h.port);
    const duplicate=await browser(h.port,{hello:{targetId:a.welcome.targetId,secret:a.welcome.secret}});
    assert.equal(duplicate.welcome.code,'target_busy');assert.equal(await duplicate.closed,4409);
    const invitation=(await a.call('invite')).result;
    const ai=agent(h.targets,await h.targets.resolve(invitation.url),{connectionRef:REF1});ai.start();
    const join=await a.next(m=>m.type==='ai_join');await a.call('decision',{requestId:join.requestId,connectionRef:REF1,allow:true});
    await ai.until(e=>e.type==='collaboration');
    const full=await browser(h.port);assert.equal(full.welcome.code,'capacity');assert.equal(await full.closed,4503);
    // A client-side close only proves the closing handshake reached this peer.
    // Wait for the service to detach each session: the approved target ends its
    // bound AI, and the unapproved target ends a pending join request.
    const inviteB=(await b.call('invite')).result;
    const joiningB=agent(h.targets,await h.targets.resolve(inviteB.url),{connectionRef:REF2});joiningB.start();
    await b.next(m=>m.type==='ai_join');
    a.ws.close();b.ws.close();await Promise.all([a.closed,b.closed]);
    assert.equal((await ai.ended()).code,'browser_peer_closed');
    assert.equal((await joiningB.ended()).code,'browser_peer_closed');
    now+=2000;
    const c=await browser(h.port);assert.equal(c.welcome.type,'hello');
    const restored=await browser(h.port,{hello:{targetId:a.welcome.targetId,secret:a.welcome.secret}});
    assert.equal(restored.welcome.grant.connectionRef,REF1);
    const expired=await browser(h.port,{hello:{targetId:b.welcome.targetId,secret:b.welcome.secret}});
    assert.equal(expired.welcome.code,'target_unauthorized');
  } finally {h.stop();}
});

hostedTest('router recovers only a durable browser approval after interruption before the ready callback', async()=>{
  const h=await harness();let router,drop=true;
  const identity={issuer:ISSUER,principal:'browser-test-person',oauthClientId:CID},key=randomBytes(32);
  const make=()=>createRemoteRouter({filename:join(h.dir,'router.sqlite'),credentialDirectory:join(h.dir,'credentials'),encryptionKey:key,
    resolveRegisteredTarget:async()=>{throw Error('Unexpected device lookup');},browserTargets:{resolve:(...args)=>h.targets.resolve(...args),attach:(target,options)=>h.targets.attach(target,{...options,onEvent:event=>{if(drop&&['ai_approved','collaboration'].includes(event.type))return;options.onEvent(event);}})}});
  let sequence=0;const call=async(name,args)=>(await router.handle(identity,{jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}})).result.structuredContent;
  try{
    router=await make();let owner=await browser(h.port,{hello:{capabilities:{apps:true}}});const credential={targetId:owner.welcome.targetId,secret:owner.welcome.secret,capabilities:{apps:true}};
    const invite=(await owner.call('invite')).result;
    const joined=await call('terminal_connect',{url:invite.url,attemptId:randomUUID()}),ref=joined.connectionRef;
    const request=await owner.next(m=>m.type==='ai_join');await owner.call('decision',{requestId:request.requestId,connectionRef:ref,allow:true});
    assert.equal((await call('terminal_events',{connectionRef:ref,waitSeconds:0})).phase,'pending');
    router.close();h.restart();await owner.closed;drop=false;router=await make();owner=await browser(h.port,{hello:credential});
    assert.equal((await call('terminal_events',{connectionRef:ref,waitSeconds:0})).resumable,true);
    assert.equal((await call('terminal_connect',{connectionRef:ref,resume:true})).phase,'ready');
    assert.equal(owner.welcome.grant.connectionRef,ref);assert(!owner.queue.some(m=>m.type==='ai_join'));
    await owner.call('revoke',{connectionRef:ref});const nextInvite=(await owner.call('invite')).result;
    const pending=await call('terminal_connect',{url:nextInvite.url,attemptId:randomUUID()});await owner.next(m=>m.type==='ai_join');
    router.close();h.restart();await owner.closed;router=await make();owner=await browser(h.port,{hello:credential});
    assert.equal(owner.welcome.grant,null);
    const unapproved=await call('terminal_connect',{connectionRef:pending.connectionRef,resume:true});assert.equal(unapproved.phase,'denied');assert.equal(unapproved.resumable,false);assert(!owner.queue.some(m=>m.type==='ai_join'));
  }finally{router?.close();h.stop();}
});

hostedTest('pending reports are acknowledged without granting tools; heartbeat loss has a safe reason', async () => {
  const diagnostics=[],h=await harness({pingMs:80,onDiagnostic:event=>diagnostics.push(event)});
  try{
    const b=await browser(h.port,{options:{autoPong:false}}),invite=(await b.call('invite')).result;
    const ai=agent(h.targets,await h.targets.resolve(invite.url),{connectionRef:REF1});ai.start();
    const join=await b.next(m=>m.type==='ai_join');
    assert.equal(code(await ai.request('apps_read_text',{})),'disconnected');
    const reporting=ai.request('ai_report',{message:'Waiting for approval.'}),frame=await b.next(m=>m.type==='pending_report');
    assert.equal(frame.requestId,join.requestId);assert.equal(frame.connectionRef,REF1);assert.equal(frame.approvalId,undefined);
    b.send({type:'result',id:frame.id,result:{content:[{type:'text',text:'{"reported":true}'}],structuredContent:{reported:true}}});
    assert.equal((await reporting).structuredContent.reported,true);
    assert.equal(code(await ai.request('ai_report',{message:'x'.repeat(281)})),'invalid_request');
    assert.equal((await ai.ended()).code,'browser_heartbeat_timeout');
    assert.equal(diagnostics[0].code,'browser_heartbeat_timeout');assert.equal(diagnostics[0].closeCode,1006);
    assert.deepEqual(Object.keys(diagnostics[0]).sort(),['closeCode','code','event','inFlight','uptimeMs']);
    assert.equal(code(await ai.request('ai_report',{message:'Late'})),'disconnected');
  }finally{h.stop();}
});
