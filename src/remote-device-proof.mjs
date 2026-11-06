import {createPublicKey, verify} from 'node:crypto';
const failure = () => Object.assign(Error('invalid_pairing_proof'), {code: 'invalid_pairing_proof'});
const fields = ['purpose', 'issuer', 'resource', 'pairingId', 'challenge', 'clientId', 'redirectUri', 'scope', 'expiresAt', 'decision'];

// Device Manager authenticates its current registered device before signing.
// This verifier accepts only the separate, short-lived MCP attestation type.
export function createDevicePairingVerifier({publicKey, issuer, clock = () => Date.now()}) {
  const key = typeof publicKey === 'object' && publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || typeof issuer !== 'string' || !issuer) throw Error('Invalid device attestation verifier configuration.');
  return async (expected, proof) => {
    try {
      if (!proof || typeof proof.assertion !== 'string' || proof.assertion.length > 8192) throw failure();
      const parts = proof.assertion.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw failure();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (header.alg !== 'EdDSA' || header.typ !== 'vrch-mcp-pairing+jwt'
          || !verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw failure();
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), now = Math.floor(clock() / 1000);
      if (claims.iss !== issuer || claims.aud !== expected.resource || !/^dvc_[0-9a-f]{32}$/.test(claims.sub || '')
          || claims.sub !== proof.deviceId || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
          || claims.iat > now + 30 || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 60
          || claims.exp > expected.expiresAt || fields.some(field => claims.pairing?.[field] !== expected[field])) throw failure();
      return {deviceId: claims.sub};
    } catch {throw failure();}
  };
}
