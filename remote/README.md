# Hosted Remote MCP (development)

This private service package adds Streamable HTTP and device-approved OAuth for
ChatGPT and Claude web. It is separate from the published dependency-free STDIO package (0.1.7).
It is not a published MCP release or a claim of ChatGPT/device acceptance.

Use Node 22.23.4 and `npm ci --prefix remote --omit=dev --ignore-scripts`.
The hosted-only `ws` dependency pins a public DNS result into the TLS connection,
while retaining the registered device hostname for certificate verification.
The common MCP/client code stays in `src/`. Hosted file staging is not implemented;
file tools are omitted. Device screenshots do not capture the browser Preview.

Build from a clean, pushed commit with:

```
docker build -f remote/Dockerfile --build-arg COMMIT=<full-sha> -t vrch-mcp:<short-sha> .
```

Configure `remote/compose.yaml` using an external, private environment file.
Set issuer `https://mcp-sg.vrch.ai` and its resource `/mcp` on SG. Configure the
trusted Device Manager public directory and signing issuer; mount its public
Ed25519 verification key only. Generate an independent random 32-byte recovery
key encoded as base64, owned/readable by container uid 1000. The persistent data
directory must be owned by that uid with mode 0700. Do not replace the key when
recreating the container. OAuth tokens are stored as hashes; device recovery
credentials are encrypted with identity, client, device and connection bindings.

Render `nginx.conf.template` with the exact host and install in nginx's http
context. Its loopback listener is 18917; the service listens on 18916. Publish
18917 through the existing SG HTTPS edge. Preserve unrelated ingress entries.
Access logging is disabled on this OAuth route to avoid persisting codes.
The service validates Host and Origin itself; the public edge must retain Origin.

`VRCH_MCP_PAIRING_DEVICES` is a JSON array of trusted `{name,origin}` objects for
the human pairing page. These links do not authorize or select a tool connection.
Every tool connection still needs its original invitation and human Allow AI;
subsequent tools require the explicit connectionRef. Reconnecting ChatGPT creates
a new paired identity; it does not inherit another connection's credentials.

Before changing SG, record the current affected image/config and preserve its
private state. Recreate only the MCP service and, when its new attestation route
is needed, Device Manager with `--no-deps`. No database migration is required.
EA has no deployment authorization. Check discovery, unauthenticated 401,
OAuth denial/approval, cross-identity refusal, restart and lost-response queries.
Local tests use a real HTTP/SDK/WebSocket boundary with a simulated device; real
ChatGPT, human decisions, Components/Runtime and physical App results remain
separate acceptance evidence.

For the authorized standard-SDK validation on SG, set `VRCH_MCP_SDK_VALIDATION=true`.
This registers a separate public client at `/sdk-client.json` with one exact HTTPS
callback, `/sdk-callback`. It uses the same PKCE and human device pairing as
ChatGPT, never ChatGPT's client identity. It does not grant an invitation or
approve itself. The validation browser receives the authorization code; the
SDK keeps its verifier and tokens locally. The callback reflects no parameters
and loads no external resources. Disable the option when this validation ends.

The service verifies the selected hosted clients from their published CIMD URLs
in `remote/clients.mjs`. Only their exact hosted callbacks are enabled; native
Claude Code callbacks are outside this slice. A failed metadata fetch disables
that client's new authorization on this process start, without trusting an
unverified document or preventing the other verified client from starting.
Actual Claude account connection and App editing remain separate acceptance.
