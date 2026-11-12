// A refreshed access token keeps its grant's budget. Only authenticated identities
// reach this limiter; IPs, bearer strings and caller-supplied connection refs do not.
export function createPrincipalRateLimit({requestsPerSecond = 5, burst = 30, clock = () => performance.now()} = {}) {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || !Number.isSafeInteger(burst) || burst < 1)
    throw Error('Invalid authenticated request limit.');
  const buckets = new Map(), idleMs = Math.max(60000, burst / requestsPerSecond * 1000);
  let sweepAt = 0;
  return {
    take(identity) {
      const now = clock();
      if (now >= sweepAt) {
        for (const [key, value] of buckets) if (now - value.at >= idleMs) buckets.delete(key);
        sweepAt = now + idleMs;
      }
      const key = JSON.stringify([identity.issuer, identity.principal, identity.oauthClientId]);
      const previous = buckets.get(key);
      const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, now - previous.at) * requestsPerSecond / 1000) : burst;
      buckets.set(key, {tokens: tokens >= 1 ? tokens - 1 : tokens, at: now});
      return tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - tokens) / requestsPerSecond));
    },
    clear() {buckets.clear();}
  };
}
