import {loadWebClients} from './clients.mjs';
import {createServer} from 'node:http';
import {readFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createPairingAuthorization} from '../src/remote-auth.mjs';
import {createDevicePairingVerifier} from '../src/remote-device-proof.mjs';
import {createRemoteRouter} from '../src/remote-router.mjs';
import {createRemoteHTTPHandler} from '../src/remote-http.mjs';
import {createBrowserTargets} from './browser-targets.mjs';
import {createRegisteredTargetResolver} from './targets.mjs';

const required = name => {const value = process.env[name]; if (!value) throw Error('Missing configuration: ' + name); return value;};
const issuer = required('VRCH_MCP_ISSUER'), resource = issuer + '/synth', directory = required('VRCH_MCP_DATA');
mkdirSync(directory, {recursive: true, mode: 0o700});
const key = Buffer.from(readFileSync(required('VRCH_MCP_ENCRYPTION_KEY_FILE'), 'utf8').trim(), 'base64');
if (key.length !== 32) throw Error('Invalid recovery encryption key.');
const {clients, unavailable} = await loadWebClients();
for (const name of unavailable) process.stderr.write('OAuth client metadata unavailable: ' + name + '\n');
const sdkValidation = process.env.VRCH_MCP_SDK_VALIDATION === 'true';
if (sdkValidation) clients.set(issuer + '/sdk-client.json', {tokenEndpointAuthMethod: 'none', redirectUris: [issuer + '/sdk-callback']});
// Dynamic Google registration remains available if a CIMD host is temporarily offline.
const browserOrigins=(process.env.VRCH_MCP_BROWSER_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
const browserTargets=browserOrigins.length?createBrowserTargets({filename:join(directory,'browser-targets.sqlite'),issuer,allowedOrigins:browserOrigins}):null;
const deviceVerifier=createDevicePairingVerifier({publicKey:readFileSync(required('VRCH_MCP_DEVICE_VERIFY_KEY_FILE')),issuer:required('VRCH_MCP_DEVICE_ISSUER')});
const auth = createPairingAuthorization({filename: join(directory, 'auth.sqlite'), issuer, resource, clients,
  verifyPairing: (expected,proof)=>proof?.kind==='vrch-browser-target-v1'&&browserTargets?browserTargets.verifyPairing(expected,proof):deviceVerifier(expected,proof)});
browserTargets?.bindPairing(auth);
const router = await createRemoteRouter({browserTargets,buildRevision:process.env.VRCH_MCP_BUILD || 'unknown',filename: join(directory, 'connections.sqlite'), credentialDirectory: join(directory, 'credentials'), encryptionKey: key,
  resolveRegisteredTarget: createRegisteredTargetResolver({directoryURL: required('VRCH_MCP_DIRECTORY_URL')})});
const authMetadata = auth.metadata;
auth.metadata = () => ({...authMetadata(), client_id_metadata_document_supported: true});
const handler = createRemoteHTTPHandler({auth, resource, handleMCP: router.handle, sdkValidation, onRegistrationFailure: value => process.stderr.write(JSON.stringify({event:'oauth_registration_rejected',...value}) + '\n')});
const server=createServer(handler);
if(browserTargets)server.on('upgrade',(request,socket,head)=>browserTargets.upgrade(request,socket,head));
server.requestTimeout = 30000; server.headersTimeout = 10000;
server.listen(Number(process.env.VRCH_MCP_PORT || 18916), '127.0.0.1', () => process.stdout.write('VRCH MCP listening on loopback.\n'));
let stopping = false;
function stop() {
  if (stopping) return; stopping = true; handler.close();
  let released = false;
  const release = () => {if (!released) {released = true; router.close(); browserTargets?.close(); auth.close();}};
  const deadline = setTimeout(() => {server.closeAllConnections(); release(); process.exit(0);}, 25000);
  deadline.unref();
  server.close(() => {clearTimeout(deadline); release();});
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
