// Hosted OAuth state. The HTTP adapter owns cookies/CSRF, client metadata and
// registered-device proof verification; none of those inputs come from MCP tools.
// This optional hosted module requires Node >=22.13 (node:sqlite).
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {lstatSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';

const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const short = value => typeof value === 'string' && value.length <= 2048;

export function createPairingAuthorization({filename, issuer, resource, clients, verifyPairing, clock = () => Date.now()}) {
  for (const value of [issuer, resource]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw fail('invalid_configuration');
  }
  if (!(clients instanceof Map) || typeof verifyPairing !== 'function') throw fail('invalid_configuration');
  if (filename !== ':memory:') {
    const parent = lstatSync(dirname(filename));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) throw fail('unsafe_auth_storage');
    try {
      const info = lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw fail('unsafe_auth_storage');
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS pairing (
      id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, challenge TEXT NOT NULL,
      client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, pkce TEXT NOT NULL,
      state TEXT NOT NULL, expires INTEGER NOT NULL, phase TEXT NOT NULL,
      principal TEXT, device_id TEXT, code_hash TEXT, code_expires INTEGER);
    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, client_id TEXT NOT NULL,
      device_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tokens (
      hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL,
      expires INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);`);
  const now = () => Math.floor(clock() / 1000);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try {const result = fn(); db.exec('COMMIT'); return result;} catch (error) {db.exec('ROLLBACK'); throw error;}
  };
  function client(id, redirect) {
    const registered = clients.get(id);
    if (!registered || registered.tokenEndpointAuthMethod !== 'none') throw fail('invalid_client');
    if (redirect !== undefined && !registered.redirectUris.includes(redirect)) throw fail('invalid_redirect_uri');
    return registered;
  }
  function begin(params) {
    if (!short(params.redirect_uri) || !params.redirect_uri) throw fail('invalid_request');
    client(params.client_id, params.redirect_uri);
    if (params.response_type !== 'code' || params.resource !== resource || params.scope !== 'vrch:mcp'
        || params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge || '')
        || !short(params.state)) throw fail('invalid_request');
    const id = token(), browserSecret = token(), challenge = token();
    db.prepare('INSERT INTO pairing(id,browser_hash,challenge,client_id,redirect_uri,pkce,state,expires,phase) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, hash(browserSecret), challenge, params.client_id, params.redirect_uri, params.code_challenge, params.state, now() + 600, 'pending');
    return {id, browserSecret, expiresAt: now() + 600};
  }
  function pending(id) {
    const value = db.prepare('SELECT * FROM pairing WHERE id=?').get(id);
    if (!value || value.expires <= now() || !['pending', 'approved', 'issued', 'denied', 'used'].includes(value.phase)) throw fail('pairing_unavailable');
    return value;
  }
  function challenge(id) {
    const value = pending(id);
    return {purpose: 'vrch-mcp-pairing-v1', issuer, resource, pairingId: id, challenge: value.challenge,
      clientId: value.client_id, redirectUri: value.redirect_uri, scope: 'vrch:mcp', expiresAt: value.expires};
  }
  async function decide(id, proof, allow) {
    const expected = {...challenge(id), decision: allow ? 'approve' : 'deny'};
    // The verifier must check a current registered device and a signature over
    // this exact challenge after the person's normal Apps pairing approval.
    const identity = await verifyPairing(expected, proof);
    if (!identity || typeof identity.deviceId !== 'string' || !identity.deviceId || identity.deviceId.length > 256) throw fail('invalid_pairing_proof');
    return transaction(() => {
      const value = pending(id);
      if (value.phase !== 'pending') {
        if (value.device_id !== identity.deviceId || (value.phase === 'denied') === allow) throw fail('pairing_conflict');
        return {phase: allow ? 'approved' : 'denied'};
      }
      const phase = allow ? 'approved' : 'denied', principal = allow ? token() : null;
      db.prepare('UPDATE pairing SET phase=?,principal=?,device_id=? WHERE id=?').run(phase, principal, identity.deviceId, id);
      return {phase};
    });
  }
  function finish(id, browserSecret) {
    if (typeof browserSecret !== 'string' || browserSecret.length > 128) throw fail('invalid_browser_session');
    return transaction(() => {
      const value = pending(id);
      if (!same(value.browser_hash, hash(browserSecret))) throw fail('invalid_browser_session');
      if (value.phase === 'pending') return {phase: 'pending'};
      if (value.phase === 'used') return {phase: 'connected'};
      if (value.phase === 'denied') return {phase: 'authorized', redirect: authorizationError({client_id: value.client_id, redirect_uri: value.redirect_uri, state: value.state}, 'access_denied')};
      // An explicit browser retry rotates an unconsumed code. It cannot create
      // a second service grant or repeat any device/App action.
      const code = token();
      db.prepare('UPDATE pairing SET phase=?,code_hash=?,code_expires=? WHERE id=?').run('issued', hash(code), now() + 120, id);
      const redirect = new URL(value.redirect_uri);
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', value.state); redirect.searchParams.set('iss', issuer);
      return {phase: 'authorized', redirect: redirect.href};
    });
  }
  function authorizationError(params, code) {
    client(params.client_id, params.redirect_uri);
    if (!short(params.redirect_uri) || !params.redirect_uri || !short(params.state)) throw fail('invalid_request');
    const redirect = new URL(params.redirect_uri);
    redirect.searchParams.set('error', code); redirect.searchParams.set('state', params.state); redirect.searchParams.set('iss', issuer);
    return redirect.href;
  }
  function issue(grant) {
    const accessToken = token(), refreshToken = token();
    db.prepare('INSERT INTO tokens(hash,grant_id,kind,expires) VALUES(?,?,?,?)').run(hash(accessToken), grant.id, 'access', now() + 900);
    db.prepare('INSERT INTO tokens(hash,grant_id,kind,expires) VALUES(?,?,?,?)').run(hash(refreshToken), grant.id, 'refresh', now() + 30 * 86400);
    return {access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 900, scope: 'vrch:mcp'};
  }
  function exchange(params) {
    client(params.client_id);
    if (params.resource !== resource) throw fail('invalid_target');
    if (params.grant_type === 'authorization_code') {
      if (!verifierPattern.test(params.code_verifier || '') || typeof params.code !== 'string' || params.code.length > 128) throw fail('invalid_grant');
      return transaction(() => {
        const value = db.prepare('SELECT * FROM pairing WHERE code_hash=?').get(hash(params.code));
        const challenge = createHash('sha256').update(params.code_verifier).digest('base64url');
        if (!value || value.phase !== 'issued' || value.code_expires <= now() || value.client_id !== params.client_id
            || value.redirect_uri !== params.redirect_uri || !same(challenge, value.pkce)) throw fail('invalid_grant');
        const grant = {id: token(), principal: value.principal, clientId: value.client_id, deviceId: value.device_id};
        db.prepare('INSERT INTO grants(id,principal,client_id,device_id) VALUES(?,?,?,?)').run(grant.id, grant.principal, grant.clientId, grant.deviceId);
        db.prepare('UPDATE pairing SET phase=? WHERE id=?').run('used', value.id);
        return issue(grant);
      });
    }
    if (params.grant_type !== 'refresh_token' || typeof params.refresh_token !== 'string' || params.refresh_token.length > 128) throw fail('unsupported_grant_type');
    const result = transaction(() => {
      const row = db.prepare('SELECT tokens.*, grants.client_id, grants.revoked FROM tokens JOIN grants ON grants.id=tokens.grant_id WHERE tokens.hash=? AND kind=?')
        .get(hash(params.refresh_token), 'refresh');
      if (!row || row.client_id !== params.client_id || row.revoked || row.expires <= now()) return null;
      if (row.spent) {
        db.prepare('UPDATE grants SET revoked=1 WHERE id=?').run(row.grant_id);
        return null;
      }
      db.prepare('UPDATE tokens SET spent=1 WHERE hash=?').run(row.hash);
      return issue({id: row.grant_id});
    });
    if (!result) throw fail('invalid_grant');
    return result;
  }
  function authenticate(accessToken) {
    if (typeof accessToken !== 'string' || accessToken.length > 128) throw fail('invalid_token');
    const value = db.prepare('SELECT tokens.expires, grants.* FROM tokens JOIN grants ON grants.id=tokens.grant_id WHERE tokens.hash=? AND tokens.kind=?')
      .get(hash(accessToken), 'access');
    if (!value || value.revoked || value.expires <= now()) throw fail('invalid_token');
    return {issuer, principal: value.principal, oauthClientId: value.client_id, pairedDeviceId: value.device_id, scope: 'vrch:mcp', resource};
  }
  function revoke(value, clientId) {
    client(clientId);
    if (typeof value !== 'string' || value.length > 128) return;
    db.prepare('UPDATE grants SET revoked=1 WHERE client_id=? AND id IN (SELECT grant_id FROM tokens WHERE hash=?)').run(clientId, hash(value));
  }
  return {begin, challenge, approve: (id, proof) => decide(id, proof, true), deny: (id, proof) => decide(id, proof, false), finish, authorizationError, exchange, authenticate, revoke, close: () => db.close(),
    metadata: () => ({issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', revocation_endpoint: issuer + '/revoke',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['vrch:mcp'], authorization_response_iss_parameter_supported: true})};
}
