import {readJSON} from './read-json.mjs';
import {createServer} from 'node:http';
import {readFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createPairingAuthorization} from '../src/remote-auth.mjs';
import {createDevicePairingVerifier} from '../src/remote-device-proof.mjs';
import {createRemoteRouter} from '../src/remote-router.mjs';
import {createRemoteHTTPHandler} from '../src/remote-http.mjs';
import {createRegisteredTargetResolver} from './targets.mjs';

const required = name => {const value = process.env[name]; if (!value) throw Error('Missing configuration: ' + name); return value;};
const issuer = required('VRCH_MCP_ISSUER'), resource = issuer + '/mcp', directory = required('VRCH_MCP_DATA');
mkdirSync(directory, {recursive: true, mode: 0o700});
const key = Buffer.from(readFileSync(required('VRCH_MCP_ENCRYPTION_KEY_FILE'), 'utf8').trim(), 'base64');
if (key.length !== 32) throw Error('Invalid recovery encryption key.');
const clientId = 'https://chatgpt.com/oauth/client.json';
const metadataResponse = await fetch(clientId, {redirect: 'error', signal: AbortSignal.timeout(10000)});
if (!metadataResponse.ok) throw Error('ChatGPT client metadata is unavailable.');
const metadata = await readJSON(metadataResponse, 65536);
const methods = metadata.token_endpoint_auth_methods_supported || [metadata.token_endpoint_auth_method];
if (metadata.client_id !== clientId || !methods.includes('none')
    || !metadata.redirect_uris?.includes('https://chatgpt.com/connector_platform_oauth_redirect')) throw Error('Unsupported ChatGPT client metadata.');
const clients = new Map([[clientId, {tokenEndpointAuthMethod: 'none', redirectUris: metadata.redirect_uris}]]);
const sdkValidation = process.env.VRCH_MCP_SDK_VALIDATION === 'true';
if (sdkValidation) clients.set(issuer + '/sdk-client.json', {tokenEndpointAuthMethod: 'none', redirectUris: [issuer + '/sdk-callback']});
const auth = createPairingAuthorization({filename: join(directory, 'auth.sqlite'), issuer, resource, clients,
  verifyPairing: createDevicePairingVerifier({publicKey: readFileSync(required('VRCH_MCP_DEVICE_VERIFY_KEY_FILE')), issuer: required('VRCH_MCP_DEVICE_ISSUER')})});
const router = await createRemoteRouter({filename: join(directory, 'connections.sqlite'), credentialDirectory: join(directory, 'credentials'), encryptionKey: key,
  resolveRegisteredTarget: createRegisteredTargetResolver({directoryURL: required('VRCH_MCP_DIRECTORY_URL')})});
const authMetadata = auth.metadata;
auth.metadata = () => ({...authMetadata(), client_id_metadata_document_supported: true});
const pairingDevices = JSON.parse(process.env.VRCH_MCP_PAIRING_DEVICES || '[]');
const server = createServer(createRemoteHTTPHandler({auth, resource, handleMCP: router.handle, pairingDevices, sdkValidation}));
server.requestTimeout = 30000; server.headersTimeout = 10000;
server.listen(Number(process.env.VRCH_MCP_PORT || 18916), '127.0.0.1', () => process.stdout.write('VRCH MCP listening on loopback.\n'));
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  let released = false;
  const release = () => {if (!released) {released = true; router.close(); auth.close();}};
  const deadline = setTimeout(() => {server.closeAllConnections(); release(); process.exit(0);}, 25000);
  deadline.unref();
  server.close(() => {clearTimeout(deadline); release();});
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
