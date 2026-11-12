import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {createHash, randomBytes} from 'node:crypto';
import {createPrincipalRateLimit} from '../src/remote-rate-limit.mjs';
import {createRemoteHTTPHandler} from '../src/remote-http.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;

test('principal allowance refills without letting another client or grant spend it', () => {
  let now = 0;
  const limiter = createPrincipalRateLimit({requestsPerSecond: 2, burst: 2, clock: () => now});
  const a = {issuer: 'https://issuer.test', principal: 'a', oauthClientId: 'client'};
  assert.equal(limiter.take(a), 0); assert.equal(limiter.take(a), 0); assert.equal(limiter.take(a), 1);
  assert.equal(limiter.take({...a, principal: 'b'}), 0);
  assert.equal(limiter.take({...a, oauthClientId: 'other'}), 0);
  now = 499; assert.equal(limiter.take(a), 1);
  now = 500; assert.equal(limiter.take(a), 0); assert.equal(limiter.take(a), 1);
  now = 61000; assert.equal(limiter.take(a), 0); assert.equal(limiter.take(a), 0); assert.equal(limiter.take(a), 1);
  limiter.clear(); assert.equal(limiter.take(a), 0);
  assert.throws(() => createPrincipalRateLimit({requestsPerSecond: 0}));
});

test('real OAuth grants on one HTTP peer have independent limits, including after token refresh', {skip: !supported}, async () => {
  const {createPairingAuthorization} = await import('../src/remote-auth.mjs');
  const issuer = 'https://limits.test', resource = issuer + '/synth', clientId = issuer + '/client', redirect = issuer + '/callback';
  const auth = createPairingAuthorization({filename: ':memory:', issuer, resource,
    clients: new Map([[clientId, {tokenEndpointAuthMethod: 'none', redirectUris: [redirect]}]]),
    // Only the human's pairing proof is a fixture; tokens, refresh/revoke and HTTP authentication are real.
    verifyPairing: async () => ({deviceId: 'fixture-browser'})});
  async function grant() {
    const verifier = randomBytes(32).toString('base64url');
    const pending = auth.begin({client_id: clientId, redirect_uri: redirect, resource, scope: 'vrch:mcp', response_type: 'code', state: 'limit-test',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')});
    await auth.approve(pending.id, {});
    const code = new URL(auth.finish(pending.id, pending.browserSecret).redirect).searchParams.get('code');
    return auth.exchange({grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource});
  }
  let now = 0, dispatched = 0;
  const handler = createRemoteHTTPHandler({auth, resource, requestLimit: {requestsPerSecond: 1, burst: 2, clock: () => now},
    handleMCP: async (identity, message) => {dispatched++; return {jsonrpc: '2.0', id: message.id, result: {principal: identity.principal}};}});
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = token => new Promise((resolve, reject) => {
    const req = request({hostname: '127.0.0.1', port: server.address().port, path: '/synth', method: 'POST',
      headers: {Host: 'limits.test', Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'}}, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: JSON.parse(body)}));
    }); req.on('error', reject); req.end(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'apps_save', arguments: {operationId: 'fixture'}}}));
  });
  try {
    const a = await grant(), b = await grant();
    assert.equal((await call(a.access_token)).status, 200); assert.equal((await call(a.access_token)).status, 200);
    const limited = await call(a.access_token); assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '1');
    assert.equal(limited.headers['cache-control'], 'no-store'); assert.equal(dispatched, 2, 'A rejected mutation never reaches the dispatcher');
    const refreshed = auth.exchange({grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: clientId, resource});
    assert.equal((await call(refreshed.access_token)).status, 429, 'Refresh cannot mint another budget');
    assert.equal((await call(b.access_token)).status, 200, 'Same source IP, different authorization');
    for (let i = 0; i < 5; i++) assert.equal((await call('unapproved-' + i)).status, 401);
    assert.equal((await call(b.access_token)).status, 200, 'Invalid bearers do not spend a valid allowance');
    now = 1000; assert.equal((await call(refreshed.access_token)).status, 200);
    auth.revoke(refreshed.access_token, clientId); assert.equal((await call(refreshed.access_token)).status, 401);
    const others = await Promise.all(Array.from({length: 100}, () => grant()));
    assert((await Promise.all(others.map(v => call(v.access_token)))).every(v => v.status === 200), '100 grants on one IP each receive their own allowance');
  } finally {handler.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); auth.close();}
});
