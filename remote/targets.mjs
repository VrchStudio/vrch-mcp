import {readJSON} from './read-json.mjs';
import {resolve4} from 'node:dns/promises';
import {isIP} from 'node:net';
import {WebSocket} from 'ws';
const fail = () => Object.assign(Error('target_unavailable'), {code: 'target_unavailable'});
export function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}
export function createRegisteredTargetResolver({directoryURL, fetchImpl = fetch, resolve = resolve4, WebSocketImpl = WebSocket}) {
  const directory = new URL(directoryURL);
  if (!['https:', 'http:'].includes(directory.protocol) || directory.username || directory.password || directory.search || directory.hash
      || directory.protocol === 'http:' && directory.hostname !== '127.0.0.1') throw Error('Invalid trusted directory URL.');
  return async (invitation, {deviceId} = {}) => {
    try {
      const target = new URL(invitation);
      if (target.protocol !== 'https:' || target.port || target.username || target.password || isIP(target.hostname)) throw fail();
      const lookup = new URL(directory); lookup.searchParams.set('self_host', target.hostname);
      const response = await fetchImpl(lookup, {redirect: 'error', signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw fail();
      const document = await readJSON(response, 262144), entry = (document.data || document).self;
      if (!entry || !/^dvc_[a-f0-9]{32}$/.test(entry.device_uid) || !Array.isArray(entry.hosts) || !entry.hosts.includes(target.hostname)
          || deviceId && deviceId !== entry.device_uid) throw fail();
      // The first SG targets have public IPv4. Pin that verified result into
      // the TLS socket, with the registered hostname still used for SNI/certs.
      // IPv6-only targets remain unsupported until that transport is tested.
      const addresses = await resolve(target.hostname);
      if (!addresses.length || addresses.some(address => !publicIPv4(address))) throw fail();
      const address = addresses[0], socketURL = 'wss://' + target.host + '/vrch-ws/apps-terminal-assist';
      class RegisteredSocket extends WebSocketImpl {
        constructor(url) {
          if (url !== socketURL) throw fail();
          super(url, {followRedirects: false, handshakeTimeout: 10000, rejectUnauthorized: true, servername: target.hostname,
            maxPayload: 17 * 1024 * 1024,
            lookup: (_host, options, callback) => options?.all ? callback(null, [{address, family: 4}]) : callback(null, address, 4)});
        }
      }
      return {deviceId: entry.device_uid, origin: target.origin, WebSocketImpl: RegisteredSocket};
    } catch {throw fail();}
  };
}
