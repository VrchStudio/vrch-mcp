// Standard HTTP/OAuth boundary. Tool execution and verified device pairing stay
// in their own adapters. No bare URL, cookie or MCP session authenticates a tool.
import {randomBytes} from 'node:crypto';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cookies = header => Object.fromEntries(String(header || '').split(';').map(part => part.trim().split('=')));
const oauthErrors = new Set(['invalid_request', 'invalid_client', 'invalid_redirect_uri', 'invalid_grant', 'invalid_target', 'unsupported_grant_type', 'invalid_token', 'pairing_unavailable', 'invalid_pairing_proof', 'pairing_conflict', 'invalid_browser_session']);

export function createRemoteHTTPHandler({auth, resource, handleMCP, pairingDevices = [], sdkValidation = false}) {
  const target = new URL(resource), origin = target.origin, metadata = auth.metadata();
  if (typeof handleMCP !== 'function' || new URL(metadata.issuer).origin !== origin) throw Error('Invalid remote HTTP configuration.');
  const protectedPath = '/.well-known/oauth-protected-resource' + (target.pathname === '/' ? '' : target.pathname);
  function send(response, status, value, headers = {}) {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    response.writeHead(status, {'Content-Type': typeof value === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers}); response.end(body);
  }
  async function body(request, limit = 65536) {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw Object.assign(Error('invalid_request'), {code: 'invalid_request'});
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  function objectParams(values) {
    const result = {};
    for (const [name, value] of values) {if (Object.hasOwn(result, name)) throw Object.assign(Error('invalid_request'), {code: 'invalid_request'}); result[name] = value;}
    return result;
  }
  function browserSecret(request, id) {
    const value = cookies(request.headers.cookie)['__Host-vrch-mcp-pairing'];
    return value?.startsWith(id + '.') ? value.slice(id.length + 1) : '';
  }
  return async (request, response) => {
    try {
      if (request.headers.host !== target.host || request.headers.origin && request.headers.origin !== origin) {
        send(response, 403, {error: 'forbidden'}); return;
      }
      const url = new URL(request.url, origin), path = url.pathname;
      if (sdkValidation && request.method === 'GET' && path === '/sdk-client.json') {
        send(response, 200, {client_id: origin + '/sdk-client.json', client_name: 'VRCH SDK validation',
          redirect_uris: [origin + '/sdk-callback'], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'vrch:mcp'}); return;
      }
      if (sdkValidation && request.method === 'GET' && path === '/sdk-callback') {
        send(response, 200, '<!doctype html><meta charset="utf-8"><title>VRCH SDK validation</title><p>Return to the SDK validation task.</p>',
          {'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"}); return;
      }
      if (request.method === 'GET' && path === protectedPath) {
        send(response, 200, {resource, authorization_servers: [metadata.issuer], scopes_supported: ['vrch:mcp'], bearer_methods_supported: ['header']}); return;
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {send(response, 200, metadata); return;}
      if (request.method === 'GET' && path === '/authorize') {
        const started = auth.begin(objectParams(url.searchParams));
        send(response, 303, '', {Location: '/pair/' + started.id, 'Set-Cookie': '__Host-vrch-mcp-pairing=' + started.id + '.' + started.browserSecret + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600'}); return;
      }
      const paired = /^\/pair\/([A-Za-z0-9_-]{43})(?:\/(status|challenge|approve|deny))?$/.exec(path);
      if (paired) {
        const [, id, action] = paired;
        if (action === 'challenge' && request.method === 'GET') {send(response, 200, auth.challenge(id)); return;}
        if (['approve', 'deny'].includes(action) && request.method === 'POST') {
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') {send(response, 415, {error: 'invalid_request'}); return;}
          let proof; try {proof = JSON.parse(await body(request, 8192));} catch {send(response, 400, {error: 'invalid_request'}); return;}
          send(response, 200, await auth[action](id, proof)); return;
        }
        if (action === 'status' && request.method === 'POST') {
          if (request.headers.origin !== origin) {send(response, 403, {error: 'forbidden'}); return;}
          send(response, 200, auth.finish(id, browserSecret(request, id))); return;
        }
        if (!action && request.method === 'GET') {
          // Check browser possession without issuing a code. Approval is a
          // separate, device-signed action; rendering this page grants nothing.
          auth.challenge(id);
          if (!browserSecret(request, id)) {send(response, 403, {error: 'invalid_browser_session'}); return;}
          const nonce = randomBytes(24).toString('base64url');
          const links = pairingDevices.map(device => {
            const link = new URL('/apps', device.origin);
            link.searchParams.set('mcpPairing', origin + '/pair/' + id);
            return '<li><a target="_blank" rel="noopener" href="' + escape(link.href) + '">' + escape(device.name) + '</a></li>';
          }).join('');
          send(response, 200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect vrch MCP</title>'
            + '<style nonce="' + nonce + '">:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#101114;color:#f2f3f5}*{box-sizing:border-box}body{margin:0;padding:48px 20px;display:grid;min-height:100vh;place-items:center}main{width:min(100%,480px);padding:32px;border:1px solid #35373e;border-radius:18px;background:#1c1d22}h1{font-size:26px;line-height:1.2;margin:0 0 18px}p{color:#b8bbc5}ul{list-style:none;padding:0;display:grid;gap:12px;margin:28px 0}a{display:block;padding:12px 18px;border:1px solid #555963;border-radius:9px;color:#f2f3f5;text-decoration:none;text-align:center}a:hover,a:focus-visible{background:#30323b;outline:2px solid #a4b8ff;outline-offset:2px}#status{min-height:24px;margin-bottom:0}@media(max-width:480px){body{padding:20px 16px}main{padding:24px}}</style><main><h1>Connect vrch MCP</h1><p>Open My Apps on your device and approve this pairing. Device editing still requires Invite AI and Allow AI.</p><ul>' + links + '</ul><p id="status" role="status">Waiting for your approval.</p></main>'
            + '<script nonce="' + nonce + '">let stopped=false;async function check(){if(stopped)return;try{const r=await fetch(location.pathname+"/status",{method:"POST"});const v=await r.json();if(!r.ok){stopped=true;document.getElementById("status").textContent="Pairing unavailable. Start the connection again.";return;}if(v.phase==="authorized"){stopped=true;location.replace(v.redirect);return;}if(v.phase==="connected"){stopped=true;document.getElementById("status").textContent="Connected. Return to your AI client.";return;}}catch(_){}setTimeout(check,1500);}check();</script>',
            {'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}); return;
        }
        send(response, 405, {error: 'method_not_allowed'}); return;
      }
      if (['/token', '/revoke'].includes(path) && request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {send(response, 415, {error: 'invalid_request'}); return;}
        const params = objectParams(new URLSearchParams(await body(request, 8192)));
        if (path === '/token') send(response, 200, auth.exchange(params));
        else {auth.revoke(params.token, params.client_id); send(response, 200, {});}
        return;
      }
      if (path === target.pathname) {
        let identity;
        try {identity = auth.authenticate(/^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization || '')?.[1]);}
        catch {send(response, 401, {error: 'invalid_token'}, {'WWW-Authenticate': 'Bearer resource_metadata="' + origin + protectedPath + '", scope="vrch:mcp"'}); return;}
        if (request.method !== 'POST') {send(response, 405, {error: 'method_not_allowed'}, {Allow: 'POST'}); return;}
        if (!request.headers.accept?.includes('application/json') || !request.headers.accept?.includes('text/event-stream')) {send(response, 406, {error: 'not_acceptable'}); return;}
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {send(response, 415, {error: 'invalid_request'}); return;}
        let message;
        try {message = JSON.parse(await body(request));} catch {send(response, 400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); return;}
        if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id !== undefined && !(typeof message.id === 'string' || Number.isSafeInteger(message.id))) {send(response, 400, {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid Request'}}); return;}
        if (message.id === undefined) {response.writeHead(202, {'Cache-Control': 'no-store'}); response.end(); return;}
        // The execution adapter must retain sent operations if the HTTP peer
        // closes. The socket is not an authorization or cancellation scope.
        const reply = await handleMCP(identity, message);
        send(response, 200, reply); return;
      }
      send(response, 404, {error: 'not_found'});
    } catch (error) {
      if (!response.headersSent && request.method === 'GET' && new URL(request.url, origin).pathname === '/authorize' && oauthErrors.has(error.code)) {
        try {send(response, 303, '', {Location: auth.authorizationError(objectParams(new URL(request.url, origin).searchParams), error.code)}); return;} catch {}
      }
      if (!response.headersSent) send(response, oauthErrors.has(error.code) ? 400 : 503, {error: oauthErrors.has(error.code) ? error.code : 'temporarily_unavailable'});
      else response.end();
    }
  };
}
