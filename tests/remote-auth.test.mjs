import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash, randomBytes, generateKeyPairSync, sign, verify} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;
const {createPairingAuthorization} = supported ? await import('../src/remote-auth.mjs') : {};
const issuer = 'https://mcp-sg.example', resource = issuer + '/mcp';
const clientId = 'https://chatgpt.com/oauth/client.json', redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const clients = new Map([[clientId, {tokenEndpointAuthMethod: 'none', redirectUris: [redirect]}], ['other-client', {tokenEndpointAuthMethod: 'none', redirectUris: [redirect]}]]);
const claudeId = 'https://claude.ai/oauth/mcp-oauth-client-metadata', claudeRedirect = 'https://claude.ai/api/mcp/auth_callback';
clients.set(claudeId, {tokenEndpointAuthMethod: 'none', redirectUris: [claudeRedirect]});
const codeVerifier = () => randomBytes(32).toString('base64url');
const params = verifier => ({client_id: clientId, redirect_uri: redirect, resource, response_type: 'code', scope: 'vrch:mcp', state: 'retained-state', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')});
const keys = generateKeyPairSync('ed25519');
const proof = (expected, decision = 'approve') => ({deviceId: 'registered-130', signature: sign(null, Buffer.from(JSON.stringify({...expected, decision})), keys.privateKey).toString('base64url')});
const verifyPairing = async (expected, value) => {
  if (value?.deviceId !== 'registered-130' || !verify(null, Buffer.from(JSON.stringify(expected)), keys.publicKey, Buffer.from(value.signature || '', 'base64url'))) throw Object.assign(Error('invalid_pairing_proof'), {code: 'invalid_pairing_proof'});
  return {deviceId: value.deviceId};
};
const open = (filename = ':memory:', clock) => createPairingAuthorization({filename, issuer, resource, clients, verifyPairing, clock});
const exchange = (code, verifier, overrides = {}) => ({grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource, ...overrides});

test('pairing approval, PKCE, exact resource/client/callback and one-time code survive restart', {skip: !supported}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vrch-oauth-')), filename = join(directory, 'auth.sqlite');
  let auth = open(filename);
  try {
    const verifier = codeVerifier(), started = auth.begin(params(verifier));
    assert.deepEqual(auth.finish(started.id, started.browserSecret), {phase: 'pending'});
    assert.throws(() => auth.finish(started.id, 'wrong'), {code: 'invalid_browser_session'});
    const challenge = auth.challenge(started.id);
    await assert.rejects(auth.approve(started.id, proof({...challenge, clientId: 'other-client'})), {code: 'invalid_pairing_proof'});
    await auth.approve(started.id, proof(challenge));
    auth.close(); auth = open(filename);
    const first = new URL(auth.finish(started.id, started.browserSecret).redirect);
    assert.equal(first.searchParams.get('state'), 'retained-state');
    assert.equal(first.searchParams.get('iss'), issuer);
    const second = new URL(auth.finish(started.id, started.browserSecret).redirect);
    assert.throws(() => auth.exchange(exchange(first.searchParams.get('code'), verifier)), {code: 'invalid_grant'});
    const code = second.searchParams.get('code');
    for (const bad of [{resource: 'https://other.example/mcp'}, {client_id: 'other-client'}, {redirect_uri: redirect + '/evil'}, {code_verifier: codeVerifier()}])
      assert.throws(() => auth.exchange(exchange(code, verifier, bad)));
    const issued = auth.exchange(exchange(code, verifier));
    assert.throws(() => auth.exchange(exchange(code, verifier)), {code: 'invalid_grant'});
    assert.deepEqual(auth.finish(started.id, started.browserSecret), {phase: 'connected'});
    assert.deepEqual(await auth.approve(started.id, proof(challenge)), {phase: 'approved'});
    const identity = auth.authenticate(issued.access_token);
    assert.equal(identity.oauthClientId, clientId); assert.equal(identity.pairedDeviceId, 'registered-130'); assert.equal(identity.resource, resource);
    assert.throws(() => auth.authenticate(issued.refresh_token), {code: 'invalid_token'});
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert(!readFileSync(filename).includes(Buffer.from(issued.access_token)));
    assert(!readFileSync(filename).includes(Buffer.from(issued.refresh_token)));
    auth.close(); auth = open(filename);
    assert.deepEqual(auth.authenticate(issued.access_token), identity);
    const renewed = auth.exchange({grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: issued.refresh_token});
    assert.deepEqual(auth.authenticate(renewed.access_token), identity);
    assert.throws(() => auth.exchange({grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: issued.refresh_token}), {code: 'invalid_grant'});
    assert.throws(() => auth.authenticate(renewed.access_token), {code: 'invalid_token'});
    assert.throws(() => auth.authenticate(issued.access_token), {code: 'invalid_token'});
  } finally {auth.close(); rmSync(directory, {recursive: true, force: true});}
});

test('pairing expiry, unknown clients, missing redirect and wrong PKCE are rejected before authorization', {skip: !supported}, async () => {
  let time = 1000000; const auth = open(':memory:', () => time);
  try {
    const verifier = codeVerifier();
    for (const bad of [{client_id: 'unknown'}, {redirect_uri: undefined}, {redirect_uri: 'https://evil.example'}, {code_challenge_method: 'plain'}, {resource: issuer}, {scope: 'admin'}])
      assert.throws(() => auth.begin({...params(verifier), ...bad}));
    const started = auth.begin(params(verifier)), signed = proof(auth.challenge(started.id));
    time += 600001;
    await assert.rejects(auth.approve(started.id, signed), {code: 'pairing_unavailable'});
    assert.throws(() => auth.finish(started.id, started.browserSecret), {code: 'pairing_unavailable'});
  } finally {auth.close();}
});

test('service token revocation and expiration preserve independent paired identities', {skip: !supported}, async () => {
  let time = 1000000; const auth = open(':memory:', () => time);
  async function login() {
    const verifier = codeVerifier(), started = auth.begin(params(verifier));
    await auth.approve(started.id, proof(auth.challenge(started.id)));
    const code = new URL(auth.finish(started.id, started.browserSecret).redirect).searchParams.get('code');
    return auth.exchange(exchange(code, verifier));
  }
  try {
    const first = await login(), second = await login();
    assert.notEqual(auth.authenticate(first.access_token).principal, auth.authenticate(second.access_token).principal);
    auth.revoke(first.refresh_token, 'other-client'); assert(auth.authenticate(first.access_token));
    auth.revoke(first.refresh_token, clientId);
    assert.throws(() => auth.authenticate(first.access_token), {code: 'invalid_token'});
    assert(auth.authenticate(second.access_token));
    time += 900001;
    assert.throws(() => auth.authenticate(second.access_token), {code: 'invalid_token'});
    assert(auth.exchange({grant_type: 'refresh_token', resource, client_id: clientId, refresh_token: second.refresh_token}).access_token);
  } finally {auth.close();}
});

test('a signed refusal cannot approve a pairing, and errors return the exact issuer only to an allowed callback', {skip: !supported}, async () => {
  const auth = open();
  try {
    const verifier = codeVerifier(), started = auth.begin(params(verifier)), expected = auth.challenge(started.id);
    await assert.rejects(auth.approve(started.id, proof(expected, 'deny')), {code: 'invalid_pairing_proof'});
    assert.deepEqual(await auth.deny(started.id, proof(expected, 'deny')), {phase: 'denied'});
    const callback = new URL(auth.finish(started.id, started.browserSecret).redirect);
    assert.equal(callback.searchParams.get('error'), 'access_denied');
    assert.equal(callback.searchParams.get('iss'), issuer);
    assert.equal(callback.searchParams.get('state'), 'retained-state');
    assert.equal(callback.searchParams.has('code'), false);
    await assert.rejects(auth.approve(started.id, proof(expected)), {code: 'pairing_conflict'});
    assert.throws(() => auth.authorizationError({...params(verifier), redirect_uri: 'https://evil.example'}, 'invalid_request'), {code: 'invalid_redirect_uri'});
  } finally {auth.close();}
});


test('Claude web pairing uses its exact callback and cannot exchange ChatGPT codes', {skip: !supported}, async () => {
  const auth = open();
  try {
    const verifier = codeVerifier();
    assert.throws(() => auth.begin({...params(verifier), client_id: claudeId}), {code: 'invalid_redirect_uri'});
    const started = auth.begin({...params(verifier), client_id: claudeId, redirect_uri: claudeRedirect});
    const challenge = auth.challenge(started.id);
    assert.equal(challenge.clientId, claudeId); assert.equal(challenge.redirectUri, claudeRedirect);
    await auth.approve(started.id, proof(challenge));
    const callback = new URL(auth.finish(started.id, started.browserSecret).redirect);
    assert.equal(callback.origin + callback.pathname, claudeRedirect);
    const code = callback.searchParams.get('code');
    assert.throws(() => auth.exchange(exchange(code, verifier)), {code: 'invalid_grant'});
    const tokens = auth.exchange(exchange(code, verifier, {client_id: claudeId, redirect_uri: claudeRedirect}));
    assert.equal(auth.authenticate(tokens.access_token).oauthClientId, claudeId);
    assert.throws(() => auth.exchange({grant_type: 'refresh_token', client_id: clientId, resource, refresh_token: tokens.refresh_token}), {code: 'invalid_grant'});
    assert(auth.exchange({grant_type: 'refresh_token', client_id: claudeId, resource, refresh_token: tokens.refresh_token}).access_token);
  } finally {auth.close();}
});
