// Standard HTTP/OAuth boundary. Tool execution and verified device pairing stay
// in their own adapters. No bare URL, cookie or MCP session authenticates a tool.
import {randomBytes} from 'node:crypto';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cookies = header => Object.fromEntries(String(header || '').split(';').map(part => part.trim().split('=')));
const oauthErrors = new Set(['invalid_request', 'invalid_client_metadata', 'invalid_client', 'invalid_redirect_uri', 'invalid_grant', 'invalid_target', 'unsupported_grant_type', 'invalid_token', 'pairing_unavailable', 'invalid_pairing_proof', 'pairing_conflict', 'invalid_browser_session']);

export function createRemoteHTTPHandler({auth, resource, handleMCP, sdkValidation = false}) {
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
      if (request.method === 'POST' && path === '/register') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {send(response, 415, {error: 'invalid_request'}); return;}
        let value; try {value = JSON.parse(await body(request, 8192));} catch {send(response, 400, {error: 'invalid_client_metadata'}); return;}
        send(response, 201, auth.register(value)); return;
      }
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
          send(response, 200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect vrch</title>'
            + '<style nonce="' + nonce + '">:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#101010;color:#f2f2f2}*{box-sizing:border-box}body{margin:0;padding:48px 20px;display:grid;min-height:100vh;place-items:center}main{width:min(100%,480px);padding:32px;border:1px solid #444;background:#181818}h1{font-size:26px;line-height:1.2;margin:0 0 18px}p{color:#bbb}label{display:block;margin:24px 0 8px}input,button{width:100%;min-height:44px;border:1px solid #555;border-radius:0;color:inherit;background:#101010;padding:10px 12px;font:inherit}input{font-family:monospace}button{margin-top:12px;cursor:pointer}button:hover,button:focus-visible{background:#303030;outline:2px solid #aaa;outline-offset:2px}button:disabled{opacity:.5;cursor:default}#status{min-height:24px;margin-bottom:0}@media(max-width:480px){body{padding:20px 16px}main{padding:24px}}</style><main><h1>Connect vrch</h1><p>Copy this code. In the My Apps page you are using, open the menu and choose Connect AI service.</p><label for="pairingCode">Pairing code</label><input id="pairingCode" readonly autocomplete="off" spellcheck="false" value="' + escape(id) + '"><button id="copyCode" type="button">Copy code</button><p id="status" role="status">Waiting for your approval in My Apps.</p></main>'
            + '<script nonce="' + nonce + '">const code=document.getElementById("pairingCode"),copy=document.getElementById("copyCode");code.onclick=()=>code.select();copy.onclick=async()=>{try{await navigator.clipboard.writeText(code.value);copy.textContent="Copied";}catch(_){code.focus();code.select();copy.textContent="Select and copy the code";}};let stopped=false;async function check(){if(stopped)return;try{const r=await fetch(location.pathname+"/status",{method:"POST"});const v=await r.json();if(!r.ok){stopped=true;copy.disabled=true;document.getElementById("status").textContent="Pairing unavailable. Start the connection again.";return;}if(v.phase==="authorized"){stopped=true;location.replace(v.redirect);return;}if(v.phase==="connected"){stopped=true;copy.disabled=true;document.getElementById("status").textContent="Connected. Return to your AI client.";return;}}catch(_){}setTimeout(check,1500);}check();</script>',
            {'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}); return;
        }
        send(response, 405, {error: 'method_not_allowed'}); return;
      }
      if (['/token', '/revoke'].includes(path) && request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {send(response, 415, {error: 'invalid_request'}); return;}
        const params = objectParams(new URLSearchParams(await body(request, 8192)));
        let basic;
        if (request.headers.authorization !== undefined) {
          const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(request.headers.authorization);
          if (!match) {send(response, 401, {error: 'invalid_client'}); return;}
          const decoded = Buffer.from(match[1], 'base64').toString('utf8'), colon = decoded.indexOf(':');
          try {if (colon < 1) throw Error(); basic = {id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '))};}
          catch {send(response, 401, {error: 'invalid_client'}); return;}
        }
        if (path === '/token') send(response, 200, auth.exchange(params, basic));
        else {auth.revoke(params.token, params.client_id, {params, basic}); send(response, 200, {});}
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
        try {message = JSON.parse(await body(request, 262144));} catch {send(response, 400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); return;}
        if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id !== undefined && !(typeof message.id === 'string' || Number.isSafeInteger(message.id))) {send(response, 400, {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid Request'}}); return;}
        if (message.id === undefined) {response.writeHead(202, {'Cache-Control': 'no-store'}); response.end(); return;}
        // The execution adapter must retain sent operations if the HTTP peer
        // closes. The socket is not an authorization or cancellation scope.
        const reply = await handleMCP(identity, message);
        send(response, 200, reply); return;
      }
      send(response, 404, {error: 'not_found'});
    } catch (error) {
      if (!response.headersSent && error.code === 'invalid_client' && request.headers.authorization !== undefined && ['/token','/revoke'].includes(new URL(request.url, origin).pathname)) {send(response, 401, {error: 'invalid_client'}, {'WWW-Authenticate': 'Basic realm="vrch-mcp"'}); return;}
      if (!response.headersSent && error.code === 'registration_limit') {send(response, 429, {error: 'temporarily_unavailable'}, {'Retry-After': '60'}); return;}
      if (!response.headersSent && request.method === 'GET' && new URL(request.url, origin).pathname === '/authorize' && oauthErrors.has(error.code)) {
        try {send(response, 303, '', {Location: auth.authorizationError(objectParams(new URL(request.url, origin).searchParams), error.code)}); return;} catch {}
      }
      if (!response.headersSent) send(response, oauthErrors.has(error.code) ? 400 : 503, {error: oauthErrors.has(error.code) ? error.code : 'temporarily_unavailable'});
      else response.end();
    }
  };
}
