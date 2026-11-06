import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWebClients, WEB_CLIENTS} from '../remote/clients.mjs';

test('selected web clients use verified published identities and exact hosted callbacks', async () => {
  const seen = [];
  const {clients, unavailable} = await loadWebClients({fetchImpl: async (url, options) => {
    seen.push(url); assert.equal(options.redirect, 'error');
    const client = WEB_CLIENTS.find(value => value.id === url); assert(client);
    return Response.json({client_id: url, redirect_uris: [client.callback, 'http://localhost/callback'], token_endpoint_auth_method: 'none'});
  }});
  assert.deepEqual(unavailable, []); assert.equal(clients.size, 2);
  for (const client of WEB_CLIENTS) assert.deepEqual(clients.get(client.id).redirectUris, [client.callback]);
  assert.deepEqual(seen.sort(), WEB_CLIENTS.map(value => value.id).sort());
});

test('an unavailable or changed client document is never trusted and does not disable the other client', async () => {
  for (const fault of ['network', 'identity', 'callback', 'method', 'oversized']) {
    const {clients, unavailable} = await loadWebClients({fetchImpl: async url => {
      const client = WEB_CLIENTS.find(value => value.id === url), bad = client.name === 'Claude';
      if (bad && fault === 'network') throw Error('network unavailable');
      if (bad && fault === 'oversized') return new Response('x'.repeat(65537));
      return Response.json({client_id: bad && fault === 'identity' ? 'https://other.example' : url,
        redirect_uris: [bad && fault === 'callback' ? 'https://other.example/callback' : client.callback],
        token_endpoint_auth_method: bad && fault === 'method' ? 'client_secret_basic' : 'none'});
    }});
    assert.equal(clients.size, 1); assert(clients.has(WEB_CLIENTS[0].id)); assert.deepEqual(unavailable, ['Claude']);
  }
});
