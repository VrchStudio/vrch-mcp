import {readJSON} from './read-json.mjs';

// Only the two selected hosted clients are fetched. Request-supplied URLs never
// become discovery targets, and native/loopback callbacks are not enabled here.
export const WEB_CLIENTS = [
  {name: 'ChatGPT', id: 'https://chatgpt.com/oauth/client.json', callback: 'https://chatgpt.com/connector_platform_oauth_redirect'},
  {name: 'Claude', id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', callback: 'https://claude.ai/api/mcp/auth_callback'}
];
export async function loadWebClients({fetchImpl = fetch} = {}) {
  const clients = new Map(), unavailable = [];
  await Promise.all(WEB_CLIENTS.map(async client => {
    try {
      const response = await fetchImpl(client.id, {redirect: 'error', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw Error('Metadata unavailable');
      const metadata = await readJSON(response, 65536);
      const methods = metadata.token_endpoint_auth_methods_supported || [metadata.token_endpoint_auth_method];
      if (metadata.client_id !== client.id || !Array.isArray(methods) || !methods.includes('none')
          || !Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.includes(client.callback)) throw Error('Invalid metadata');
      clients.set(client.id, {tokenEndpointAuthMethod: 'none', redirectUris: [client.callback]});
    } catch {unavailable.push(client.name);}
  }));
  return {clients, unavailable};
}
