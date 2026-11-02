import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createDevicePairingVerifier} from '../src/remote-device-proof.mjs';
const keys = generateKeyPairSync('ed25519'), time = 1800000000, issuer = 'vrch-device-manager-sg', deviceId = 'dvc_' + 'a'.repeat(32);
const expected = {purpose: 'vrch-mcp-pairing-v1', issuer: 'https://mcp-sg.example', resource: 'https://mcp-sg.example/mcp', pairingId: 'a'.repeat(43), challenge: 'b'.repeat(43), clientId: 'https://chatgpt.com/oauth/client.json', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect', scope: 'vrch:mcp', expiresAt: time + 600, decision: 'approve'};
const verify = createDevicePairingVerifier({publicKey: keys.publicKey, issuer, clock: () => time * 1000});
function proof(changes = {}, header = {}) {
  const head = Buffer.from(JSON.stringify({alg: 'EdDSA', typ: 'vrch-mcp-pairing+jwt', ...header})).toString('base64url');
  const body = Buffer.from(JSON.stringify({iss: issuer, aud: expected.resource, sub: deviceId, iat: time, exp: time + 60, pairing: expected, ...changes})).toString('base64url');
  const message = head + '.' + body;
  return {deviceId, assertion: message + '.' + sign(null, Buffer.from(message), keys.privateKey).toString('base64url')};
}

test('Device Manager attestation binds purpose, device, issuer, audience and every pairing challenge field', async () => {
  assert.deepEqual(await verify(expected, proof()), {deviceId});
  for (const changes of [{iss: 'vrch-device-manager-ea'}, {aud: 'device-management'}, {sub: 'dvc_' + 'b'.repeat(32)}, {exp: time}, {exp: time + 61}, {iat: time + 31}, {iat: time - 61}])
    await assert.rejects(verify(expected, proof(changes)), {code: 'invalid_pairing_proof'});
  for (const field of Object.keys(expected)) {
    const pairing = {...expected, [field]: typeof expected[field] === 'number' ? expected[field] + 1 : expected[field] + '-other'};
    await assert.rejects(verify(expected, proof({pairing})), {code: 'invalid_pairing_proof'});
  }
  await assert.rejects(verify(expected, proof({}, {typ: 'vrch-device-credential+jwt'})), {code: 'invalid_pairing_proof'});
  await assert.rejects(verify(expected, {...proof(), deviceId: 'other'}), {code: 'invalid_pairing_proof'});
  const wrong = createDevicePairingVerifier({publicKey: generateKeyPairSync('ed25519').publicKey, issuer, clock: () => time * 1000});
  await assert.rejects(wrong(expected, proof()), {code: 'invalid_pairing_proof'});
});
