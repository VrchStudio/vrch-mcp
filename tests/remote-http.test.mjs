import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer, request} from 'node:http';
import {createHash, randomBytes, generateKeyPairSync, sign, verify} from 'node:crypto';
import {auth as sdkAuthorize} from '@modelcontextprotocol/sdk/client/auth.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {WebSocket} from 'ws';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {relay, until} from './helpers/relay.mjs';
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = major > 22 || major === 22 && minor >= 13;
const {createPairingAuthorization} = supported ? await import('../src/remote-auth.mjs') : {};
const {createRemoteHTTPHandler} = await import('../src/remote-http.mjs');
const {createRemoteRouter} = supported ? await import('../src/remote-router.mjs') : {};

test('real HTTP OAuth pairing and official SDK Streamable HTTP use the shared MCP catalog only after auth', {skip: !supported}, async () => {
  const issuer = 'https://mcp-sg.example', resource = issuer + '/synth', clientId = 'https://chatgpt.com/oauth/client.json';
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect', keys = generateKeyPairSync('ed25519');
  const clients = new Map([[clientId, {tokenEndpointAuthMethod: 'none', redirectUris: [redirectUri]}]]);
  clients.set(issuer + '/sdk-client.json', {tokenEndpointAuthMethod: 'none', redirectUris: [issuer + '/sdk-callback']});
  const auth = createPairingAuthorization({filename: ':memory:', issuer, resource, clients, verifyPairing: async (expected, proof) => {
    if (proof.deviceId !== 'fixture-130' || !verify(null, Buffer.from(JSON.stringify(expected)), keys.publicKey, Buffer.from(proof.signature, 'base64url')))
      throw Object.assign(Error('invalid_pairing_proof'), {code: 'invalid_pairing_proof'});
    return {deviceId: proof.deviceId};
  }});
  const remote = await relay(), directory = mkdtempSync(join(tmpdir(), 'vrch-mcp-http-'));
  const socketOrigin = new URL(remote.url).origin.replace(/^http/, 'ws');
  class DeviceSocket extends WebSocket {constructor(url) {super(socketOrigin + new URL(url).pathname);}}
  const router = await createRemoteRouter({filename: join(directory, 'router.sqlite'), credentialDirectory: join(directory, 'credentials'), encryptionKey: randomBytes(32),
    resolveRegisteredTarget: async url => {
      assert.equal(new URL(url).origin, 'https://registered.example');
      return {deviceId: 'fixture-130', origin: 'https://registered.example', WebSocketImpl: DeviceSocket};
    }});
  let dispatched = 0;
  const handler = createRemoteHTTPHandler({auth, resource, sdkValidation: true, handleMCP: async (identity, message) => {
    assert.equal(identity.oauthClientId, clientId); assert.equal(identity.resource, resource); dispatched++;
    return router.handle(identity, message);
  }});
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  const call = (path, {method = 'GET', headers = {}, value = ''} = {}) => new Promise((resolve, reject) => {
    const req = request(address + path, {method, headers: {Host: 'mcp-sg.example', ...headers}}, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({status: response.statusCode, headers: response.headers, text: body, json: () => JSON.parse(body)}));
    }); req.on('error', reject); req.end(value);
  });
  const json = value => ({method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'}, value: JSON.stringify(value)});
  let sdk;
  try {
    assert.equal((await call('/synth', json({jsonrpc: '2.0', id: 1, method: 'tools/list'}))).status, 401);
    assert.equal(dispatched, 0);
    assert.equal((await call('/mcp')).status,404);
    const browserInvitation = await call('/synth/target?invite=' + 'a'.repeat(43));
    assert.equal(browserInvitation.status,200);
    assert(browserInvitation.text.includes('My Apps Simulator'));
    assert(!browserInvitation.text.includes('a'.repeat(43)));
    assert.equal((await call('/.well-known/oauth-protected-resource/mcp')).status,404);
    const sdkMetadata = (await call('/sdk-client.json')).json();
    assert.deepEqual(sdkMetadata.redirect_uris, [issuer + '/sdk-callback']);
    assert(!(await call('/sdk-callback?code=never-reflect-this')).text.includes('never-reflect-this'));
    let sdkTokens, sdkVerifier, authorizationURL;
    const provider = {redirectUrl: issuer + '/sdk-callback', clientMetadata: sdkMetadata,
      clientInformation: () => ({client_id: issuer + '/sdk-client.json', issuer}),
      tokens: () => sdkTokens, saveTokens: value => {sdkTokens = value;},
      saveCodeVerifier: value => {sdkVerifier = value;}, codeVerifier: () => sdkVerifier,
      state: () => 'sdk-session-state', redirectToAuthorization: url => {authorizationURL = url;}};
    const fetchSDK = async (input, init = {}) => {
      const url = new URL(input); assert.equal(url.origin, issuer);
      const value = await call(url.pathname + url.search, {method: init.method, headers: Object.fromEntries(new Headers(init.headers)), value: init.body?.toString() || ''});
      return new Response(value.text || null, {status: value.status, headers: value.headers});
    };
    assert.equal(await sdkAuthorize(provider, {serverUrl: resource, fetchFn: fetchSDK}), 'REDIRECT');
    const sdkStart = await call(authorizationURL.pathname + authorizationURL.search);
    const sdkPair = sdkStart.headers.location, sdkCookie = sdkStart.headers['set-cookie'][0].split(';')[0];
    const codePage=await call(sdkPair,{headers:{Cookie:sdkCookie}});
    assert.equal(codePage.status,200);
    assert(codePage.text.includes('id="pairingCode"'));
    assert(codePage.text.includes('value="'+sdkPair.split('/').at(-1)+'"'));
    assert(codePage.text.includes('Paste this code in My Apps to authorize the connection.'));
    assert(!codePage.text.includes('vrch-110')&&!codePage.text.includes('vrch-130')&&!codePage.text.includes('<a '));
    const sdkChallenge = (await call(sdkPair + '/challenge')).json();
    assert.equal(sdkChallenge.clientId, issuer + '/sdk-client.json');
    await call(sdkPair + '/approve', json({deviceId: 'fixture-130', signature: sign(null, Buffer.from(JSON.stringify({...sdkChallenge, decision: 'approve'})), keys.privateKey).toString('base64url')}));
    const sdkFinish = (await call(sdkPair + '/status', {method: 'POST', headers: {Cookie: sdkCookie, Origin: issuer}})).json();
    const sdkCallback = new URL(sdkFinish.redirect);
    assert.equal(sdkCallback.searchParams.get('state'), 'sdk-session-state');
    assert.equal(sdkCallback.searchParams.get('iss'), issuer);
    assert.equal(await sdkAuthorize(provider, {serverUrl: resource, authorizationCode: sdkCallback.searchParams.get('code'), fetchFn: fetchSDK}), 'AUTHORIZED');
    assert(sdkTokens.access_token && sdkTokens.refresh_token);
    assert.equal(auth.authenticate(sdkTokens.access_token).oauthClientId, issuer + '/sdk-client.json');

    const discover = await call('/.well-known/oauth-protected-resource/synth');
    assert.equal(discover.json().authorization_servers[0], issuer);
    assert.equal((await call('/.well-known/oauth-authorization-server')).json().code_challenge_methods_supported[0], 'S256');
    assert.equal((await call('/synth', {headers: {Origin: 'https://evil.example'}})).status, 403);
    assert.equal((await call('/synth', {headers: {Host: 'evil.example'}})).status, 403);
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, resource, scope: 'vrch:mcp', response_type: 'code', state: 'preserved', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')});
    const start = await call('/authorize?' + query);
    assert.equal(start.status, 303); const pairPath = start.headers.location;
    let cookie = start.headers['set-cookie'][0].split(';')[0];
    assert.match(start.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Lax/);
    const parallel = await call('/authorize?' + new URLSearchParams({...Object.fromEntries(query),state:'parallel'}));
    const secondCookie = parallel.headers['set-cookie'][0].split(';')[0];
    assert.notEqual(cookie.split('=')[0],secondCookie.split('=')[0]);
    const legacy = auth.begin({...Object.fromEntries(query),state:'legacy'});
    cookie += '; ' + secondCookie + '; __Host-vrch-mcp-pairing=' + legacy.id + '.' + legacy.browserSecret;
    for (const path of [pairPath,parallel.headers.location,'/pair/'+legacy.id]) {
      const status = await call(path+'/status',{method:'POST',headers:{Cookie:cookie,Origin:issuer}});
      assert.equal(status.json().phase,'pending');
    }
    assert.equal((await call(pairPath+'/status',{method:'POST',headers:{Cookie:secondCookie,Origin:issuer}})).status,400);

    const wait = await call(pairPath + '/status', {method: 'POST', headers: {Cookie: cookie, Origin: issuer}});
    assert.equal(wait.json().phase, 'pending');
    assert.equal((await call(pairPath + '/status', {method: 'POST', headers: {Cookie: cookie}})).status, 403);
    const challenge = (await call(pairPath + '/challenge')).json();
    const approved = await call(pairPath + '/approve', json({deviceId: 'fixture-130', signature: sign(null, Buffer.from(JSON.stringify({...challenge, decision: 'approve'})), keys.privateKey).toString('base64url')}));
    assert.equal(approved.json().phase, 'approved');
    const finish = (await call(pairPath + '/status', {method: 'POST', headers: {Cookie: cookie, Origin: issuer}})).json();
    const callback = new URL(finish.redirect); assert.equal(callback.searchParams.get('iss'), issuer); assert.equal(callback.searchParams.get('state'), 'preserved');
    const tokens = (await call('/token', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, value: new URLSearchParams({grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, resource, code: callback.searchParams.get('code'), code_verifier: verifier}).toString()})).json();
    assert(tokens.access_token);
    sdk = new Client({name: 'remote-http-contract', version: '1.0.0'});
    // Test uses loopback HTTP and an explicit Host header. Public delivery still
    // requires HTTPS. Device proof and registration are local fixtures.
    const transport = new StreamableHTTPClientTransport(new URL(address + '/synth'), {
      requestInit: {headers: {Authorization: 'Bearer ' + tokens.access_token}},
      fetch: async (input, init = {}) => {
        const url = new URL(input);
        const response = await call(url.pathname + url.search, {method: init.method, headers: Object.fromEntries(new Headers(init.headers)), value: init.body || ''});
        return new Response(response.text || null, {status: response.status, headers: response.headers});
      }
    });
    await sdk.connect(transport);
    assert.equal(sdk.getServerVersion().icons[0].src, issuer + '/assets/vrch-logo-f4e2d43e2ea1.png');
    const catalog = await sdk.listTools(); assert(catalog.tools.some(tool => tool.name === 'apps_state')); assert(catalog.tools.some(tool => tool.name === 'apps_publish'));
    assert(dispatched >= 2);
    const connected = await sdk.callTool({name: 'terminal_connect', arguments: {url: 'https://registered.example/apps/ai?invite=fixture', attemptId: (await import('node:crypto')).randomUUID()}});
    const connectionRef = connected.structuredContent.connectionRef;
    assert(connectionRef);
    await until(() => remote.frames.some(frame => frame.type === 'ai_join')); remote.approve();
    let ready;
    for (let i = 0; i < 100; i++) {
      ready = await sdk.callTool({name: 'terminal_events', arguments: {connectionRef, waitSeconds: 0}});
      if (ready.structuredContent.phase === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(ready.structuredContent.phase, 'ready');
    const state = await sdk.callTool({name: 'apps_state', arguments: {connectionRef}});
    assert.equal(state.structuredContent.phase, 'succeeded');
    assert.equal((await sdk.callTool({name: 'apps_state', arguments: {}})).structuredContent.code, 'connection_required');
    await call('/revoke', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, value: new URLSearchParams({client_id: clientId, token: tokens.refresh_token}).toString()});
    const denied = await call('/synth', {...json({jsonrpc: '2.0', id: 99, method: 'tools/list'}), headers: {...json({}).headers, Authorization: 'Bearer ' + tokens.access_token}});
    assert.equal(denied.status, 401); assert.match(denied.headers['www-authenticate'], /oauth-protected-resource\/synth/);
  } finally {await sdk?.close(); handler.close(); router.close(); auth.close(); await remote.close(); await new Promise(resolve => server.close(resolve)); rmSync(directory, {recursive: true, force: true});}
});
