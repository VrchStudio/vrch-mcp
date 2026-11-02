# Hosted Remote MCP (development)

This private service package adds Streamable HTTP and device-approved OAuth for
ChatGPT and Claude web. It is separate from the published dependency-free STDIO package (0.1.7).
It is not a published MCP release or a claim of ChatGPT/device acceptance.

Use Node 22.23.4 and `npm ci --prefix remote --omit=dev --ignore-scripts`.
The hosted-only `ws` dependency pins a public DNS result into the TLS connection,
while retaining the registered device hostname for certificate verification.
The common MCP/client code stays in `src/`. Hosted file staging is not implemented;
general `file_*` tools are omitted. The hosted App catalog supplies `apps_sdk_reference`, `apps_read_text`
and `apps_write_text` for UTF-8 source files up to 64 KiB. It omits shell input,
private command tools and terminal transcripts; this is not an OS sandbox or a
project-only device grant. Device screenshots do not capture the browser Preview.

Read a file with explicit `connectionRef`, `workspaceId` and relative `path`.
The source is `structuredContent.result.text`, alongside its verified SHA-256
and size. The SDK reference body uses the same field. A short content block
avoids duplicating large source text; structured-only hosts receive the full body. Write with that SHA as `expectedSha256` (null only
for a new file), `content` and a fresh `operationId`. Each file uses existing File
V2 transfer plus atomic workspace commit. There is no whole-project transaction:
read `apps_state` for the new draftRevision before publishing/saving. An uncertain
write is queried with the original ID and `originalAction: "write_text"`, never
replayed under a new ID. Read access is checked on the device again after download. Up to eight parallel
text requests are queued per connection onto its single File V2 channel.
Temporary payloads are private, bounded, removed after the call and cleared on
restart; they are not a user-facing staging/download service or draft storage.
These text tools do not publish, save or run an App implicitly.

Hosted capabilities reflect this adapter: terminal/private-command flags are false,
general file purposes are empty, and workspaceText reports actual text transfer
support. Package import/export and raw workspace transfer tools are omitted until
a complete hosted transfer path exists. Shared screenshots wait for terminal_events
or take_screenshot; ordinary App calls do not consume image batches. Screenshot results expose
`structuredContent.result.images` metadata; events expose `events`/`images` in
structuredContent so a preceding App event cannot hide capture timestamps.
Hosted control/interface/menu calls serialize complete gestures; queued input is
refused if its control epoch changes. Hardware input is not put on this queue. Device grants
and the local STDIO catalog are unchanged.

After changing the catalog during development, verify the actual client's Tool
permissions includes the text tools and SDK reference. The current JSON-only HTTP
transport does not advertise tools/listChanged or deliver background SSE events;
do not claim a list_changed notification refreshed Claude. Use the host's normal
catalog refresh and retain OAuth/connectionRef where supported. Removing and pairing
a connector again creates a new identity and is not a transparent refresh. A service
restart reports service_restarted and supports explicit resume of the original
connection; idle cleanup reports idle_timeout. Neither is invitation expiration.

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
A human has completed the Claude web OAuth connection on SG. Device Invite/Allow AI,
App editing and hardware acceptance remain separate evidence.
