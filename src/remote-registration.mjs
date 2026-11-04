// Dynamic registration for the Google Connected Apps callback families only.
// Registration creates a client, never a user grant or device authorization.
import {createHash, randomBytes} from 'node:crypto';
const fail = code => Object.assign(Error(code), {code});
const hosts = new Set(['oauth-redirect.googleusercontent.com', 'oauth-redirect-sandbox.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com']);
export function googleRedirect(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return value === url.href && url.protocol === 'https:' && hosts.has(url.hostname) && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/(r|a)\/[A-Za-z0-9_./~-]+$/.test(url.pathname) && !url.pathname.split('/').includes('..');
  } catch {return false;}
}
export function createDynamicRegistration(db, now) {
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY, metadata TEXT NOT NULL, secret_hash TEXT, created INTEGER NOT NULL);`);
  function register(value) {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw fail('invalid_client_metadata');
    const redirects = value.redirect_uris;
    if (!Array.isArray(redirects) || !redirects.length || redirects.length > 4 || !redirects.every(googleRedirect)
        || new Set(redirects).size !== redirects.length) throw fail('invalid_redirect_uri');
    const method = value.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) throw fail('invalid_client_metadata');
    const grants = value.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.some(v => !['authorization_code', 'refresh_token'].includes(v))
        || new Set(grants).size !== grants.length || value.response_types !== undefined && (!Array.isArray(value.response_types) || value.response_types.length !== 1 || value.response_types[0] !== 'code')
        || value.scope !== undefined && value.scope !== 'vrch:mcp') throw fail('invalid_client_metadata');
    // Ignore self-asserted names, logos and arbitrary metadata URLs. They are not
    // verified client identity and must never become fetch targets or consent copy.
    const metadata = {redirect_uris: redirects, token_endpoint_auth_method: method, grant_types: grants, response_types: ['code'], scope: 'vrch:mcp'};
    // Bound anonymous registration storage; retain every client with a grant or
    // an in-flight pairing. Old abandoned registrations need no recovery state.
    db.prepare(`DELETE FROM oauth_clients WHERE created < ? AND id NOT IN (SELECT client_id FROM grants)
      AND id NOT IN (SELECT client_id FROM pairing WHERE expires > ?)`).run(now() - 86400, now());
    if (db.prepare('SELECT COUNT(*) AS count FROM oauth_clients').get().count >= 10000) throw fail('registration_limit');
    const id = 'vrch_dcr_' + randomBytes(32).toString('base64url'), secret = method === 'none' ? null : randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO oauth_clients(id,metadata,secret_hash,created) VALUES(?,?,?,?)')
      .run(id, JSON.stringify(metadata), secret && createHash('sha256').update(secret).digest('hex'), now());
    return {...metadata, client_id: id, client_id_issued_at: now(), ...(secret ? {client_secret: secret, client_secret_expires_at: 0} : {})};
  }
  function get(id) {
    if (typeof id !== 'string') return;
    const row = db.prepare('SELECT metadata,secret_hash FROM oauth_clients WHERE id=?').get(id);
    if (!row) return;
    const data = JSON.parse(row.metadata);
    return {tokenEndpointAuthMethod: data.token_endpoint_auth_method, redirectUris: data.redirect_uris, secretHash: row.secret_hash, grantTypes: data.grant_types};
  }
  return {register, get};
}
