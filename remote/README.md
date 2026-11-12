# Vrch Synth - Hosted MCP 0.1.1

This separately versioned, private service package adds Streamable HTTP and device-approved OAuth. SG has real ChatGPT/Codex and Claude connections; Claude and the installed SG plugin have completed My Apps editing, observation and device checks. Gemini automatic registration reached the pairing page; its complete OAuth/tool acceptance is still pending. The dependency-free local STDIO release remains 0.1.7. The production endpoint `https://mcp.vrch.ai/synth` is deployed under the name **Vrch Synth**, without an environment suffix. SG testing uses `https://mcp-sg.vrch.ai/synth` and the connector label **Vrch Synth (SG Test)**. Production Claude OAuth/pairing and complete editing/observation checks passed on110 and130 with the same connector identity. Each device used its own invitation and approval; the original saved packages and device revisions were preserved. ChatGPT published-client metadata currently returns HTTP403 from the production host, so first-time ChatGPT OAuth there remains unavailable. See the [deployment record and release procedure](RELEASE.md).

Use Node 22.23.4 and `npm ci --prefix remote --omit=dev --ignore-scripts`.
The hosted-only `ws` dependency pins a public DNS result into the TLS connection,
while retaining the registered device hostname for certificate verification.
The common MCP/client code stays in `src/`. Hosted file staging is not implemented;
general `file_*` tools are omitted. The hosted App catalog supplies `apps_sdk_reference`, `apps_read_text`
and `apps_write_text` for UTF-8 source files up to 64 KiB. Terminal tools reuse the common MCP client and existing device approval, ownership, Private Input and resumption semantics; this is an ordinary device user shell, not an OS sandbox or a project-only device grant. Device screenshots do not capture the browser Preview.

Read a file with explicit `connectionRef`, `workspaceId` and relative `path`.
The SDK reference also returns `size` (UTF-8 bytes), `sha256`, `reviewedPagesRevision` and `serviceRevision` (the image build commit, or `unknown` in an unlabelled local run). Its digest identifies the exact text independently of a cached client tool description.

Source and SDK bodies are returned both as complete plain `content` text blocks and as `structuredContent.result.text`, alongside SHA-256 and UTF-8 byte size. This supports clients that expose only text blocks. Write with that SHA as `expectedSha256` (null only
for a new file), `content` and a fresh `operationId`. Each file uses existing File
V2 transfer plus atomic workspace commit. There is no whole-project transaction:
read `apps_state` for the new draftRevision before publishing/saving. An uncertain
write is queried with the original ID and `originalAction: "write_text"`, never
replayed under a new ID. Read access is checked on the device again after download. Up to eight parallel
text requests are queued per connection onto its single File V2 channel.
Temporary payloads are private, bounded, removed after the call and cleared on
restart; they are not a user-facing staging/download service or draft storage.
These text tools do not publish, save or run an App implicitly.

Publication is asynchronous. While pendingInstanceId is present, pendingErrors
are early candidate diagnostics and error:null is not an application-success
receipt. A candidate may still call ready after an exception; the normal startup
deadline is10 seconds after mounting, plus loading time. Wait for the pending
candidate to resolve, then compare appliedRevision or error.revision with the
requested revision. Do not re-publish an unresolved candidate.

previewObservation describes the latest browser heartbeat. In particular,
not_ready/awaiting_report means no report has arrived for the current instance;
background timers may delay that report. With the current binding, call
apps_observe serially and use its actual result/error. This heartbeat is not an
additional prerequisite for observation. Handle the first App Guide through
guide_start before the intended test input.

The SDK reference includes camera frame lifetime/errors and negotiated settings, audio PCM/node APIs and input inventory, system/IMU response shapes, and the distinction between browser media consent and launch communication grants. Device availability is not analog plug detection or a physical health check.

Completed operation receipts remain queryable using their original connectionRef while disconnected. A new modification refused before invocation reports delivery:not_sent and the retained disconnect reason; an already accepted unresolved operation remains outcome_unknown. A recoverable disconnected state reports `resumable:true` and explicit resume instructions; `retryable:false` still prohibits blind operation replay. Resume attempts continue to enforce the retained authorization. Resume the original reference before querying the device. A new connection is not a substitute operation namespace, and no retry or reconnection is implicit.

Hosted capabilities reflect actual device terminal/private-command/cancel support; the adapter does not grant an unsupported capability. General
file purposes are empty, and workspaceText reports actual text transfer
support. Package import/export and raw workspace transfer tools are omitted until
a complete hosted transfer path exists. Shared screenshots wait for terminal_events
or take_screenshot; ordinary App calls do not consume image batches. Screenshot results expose
`structuredContent.result.images` metadata; events expose `events`/`images` in
structuredContent so a preceding App event cannot hide capture timestamps.
Hosted control/interface/menu calls serialize complete gestures; queued input is
refused if its control epoch changes. Hardware input is not put on this queue. Device grants
and the local STDIO catalog are unchanged.

Terminal input returns `delivery:sent` and `execution:unconfirmed`; read `terminal_events`
for output or a subsequent device rejection. Terminal events are bounded by the
common core and kept out of App/file tool drains. Terminal text lives in
`structuredContent.events`; the short content summary does not duplicate it.
Raw commands are not durable App operations and are never automatically replayed
on timeout, disconnect or restart. Resume the same connectionRef explicitly.
Human takeover and Private Input keep blocking ordinary input. Cancel follows the
existing private-state restoration (return to the previous owner);
`resumeAI:false` does not force a new transfer to AI or force control to human.
`terminal_run_private` requires actual `privateCommand:true`; Apps sessions still
report false because the specialized command flow is Recovery-only. Ordinary
human Private Input remains available; never substitute ordinary input for a
credential command. This change requires no new pairing or device grant.

After changing the catalog during development, verify the actual client's Tool
permissions includes the text tools and SDK reference. The service advertises tools/listChanged and supports an authenticated GET notification stream. A client may still freeze an existing conversation's catalogue; use its normal tool refresh and retain OAuth/connectionRef. Runtime fixes behind existing tools take effect without a catalogue refresh. Removing and pairing
a connector again creates a new identity and is not a transparent refresh. A service
restart reports service_restarted and supports explicit resume of the original
connection; idle cleanup reports idle_timeout. Neither is invitation expiration.

Build from a clean, pushed commit with:

```
docker build -f remote/Dockerfile --build-arg COMMIT=<full-sha> -t vrch-mcp:<short-sha> .
```

Configure `remote/compose.yaml` using an external, private environment file.
Set issuer `https://mcp-sg.vrch.ai` and its resource `/synth` on SG. Configure the
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

First pairing uses the code shown on the OAuth page. In the already-connected
My Apps page, choose AI Assistant > Authorize MCP Connection, paste the code and approve.
The code is the existing short-lived pairing request ID; there is no account or
short-code database. The current device's helper resolves its configured service
origin and uses the existing signed proof. Legacy pairing links remain valid.
No fixed device list or per-device MCP service configuration is used.
Every App connection still needs its original invitation and human Allow AI;
subsequent tools require the explicit connectionRef. Re-pairing a connector creates
a new identity; ordinary device switching does not require re-pairing.

Before changing SG, record the current affected image/config and preserve its
private state. Recreate only the MCP service and, when its new attestation route
is needed, Device Manager with `--no-deps`. No database migration is required.
EA preparation is authorized; deployment is not. Check discovery, unauthenticated 401,
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
Real Claude web acceptance on SG includes OAuth, retained-reference resume after updates, complete source/SDK reads, Preview observation, publishing/saving, device input and failed-update recovery. Test devices 110 and 130 retained packages and App data.

Endpoints are environment-specific: SG testing uses `https://mcp-sg.vrch.ai/synth`; EA uses `https://mcp.vrch.ai/synth` only after its separately authorized deployment. Never point the formal hostname at SG for testing. The old /mcp resource has no redirect or token migration. A changed issuer/resource starts with a fresh private state directory and recovery key; retain old stopped state only for rollback. The pairing device is provenance, not an exclusive target: every subsequent registered device still needs its own Invite/Allow and connectionRef. Do not combine first pairing with session approval in this cutover.

Terminal input/output is available through terminal_input and terminal_events, with explicit connectionRef. Terminal event arrays and image metadata are returned in structuredContent; actual images remain native MCP content. App/file calls do not drain the terminal event queue. The common queue remains bounded at 128 KiB, not an unlimited transcript archive. terminal_input reports delivery:sent and execution:unconfirmed; inspect output or rejection, never automatically replay commands. Raw command bodies/output are not added to the durable App operation journal or service access logs.
Private Input/cancel tools retain core descriptions and device checks. Existing My Apps grants may expose manual Private Input and cancellation while privateCommand remains false (the dedicated private command protocol is currently Recovery-only). Do not override that guard, send credentials via ordinary input, or claim all listed stable-catalog tools are available on every device. Hosted tooling still accepts Apps invitations only; this change does not add Recovery invitation routing or a cloud shell.
Deploy with the existing issuer, state volume and encryption key. Preserve OAuth grants and connectionRef identities, and explicitly resume the original connection after the service restarts; never re-pair or generate a replacement device invitation to refresh tools. Refresh client tool metadata through its normal controls.

Google web onboarding uses `POST /register`, advertised by OAuth discovery. DCR
supports `none`, `client_secret_basic` (RFC default), and `client_secret_post`,
while ChatGPT/Claude keep their existing published client identities. Only
Google's documented `oauth-redirect`, `oauth-redirect-sandbox` and `oauth-redirect-test` on `googleusercontent.com`
`/r/` and `/a/` HTTPS callback families are accepted; every registered callback
is then matched exactly during authorization/code exchange. User-supplied
client names and metadata URLs are not trusted identities or fetch targets.
Client secrets are returned once and stored only as SHA-256 hashes. Registration
does not grant device access: PKCE, resource binding, human device pairing and
Invite/Allow still apply. Existing grants and connectionRefs are not migrated.
Registration bodies are limited to 8 KiB; the complete six-callback Google list
is accepted without a separate callback-count cap. Existing edge rate
limits apply. Abandoned registrations older than a day can be removed, preserving
clients referenced by grants or unexpired pairings; total retained clients are
bounded at 10,000. Google persistent-linking refresh semantics are not silently
substituted for the existing refresh-token rotation/replay detection contract.
The actual Gemini redirect URI, OAuth round trip and refresh remain client
acceptance checks; protocol fixtures are not a real Gemini login.

Each OAuth pairing uses its own Secure/HttpOnly browser cookie, so concurrent
platform tabs do not replace one another. The previous shared-cookie format is
accepted for existing in-flight requests only; grants, tokens and connectionRefs
are unchanged. My Apps approval is distinct from completing the platform OAuth
exchange and from joining a device through Invite/Allow.


## Browser Simulator targets (SG development)

Set `VRCH_MCP_BROWSER_ORIGINS` to an explicit comma-separated HTTPS origin list
(for the current development page: `https://dev-3090.vrch.ai`). An empty setting
leaves the browser target feature disabled. The nginx template upgrades
`/synth/targets` to the same hosted process; it is not a separate content service.

The trusted Simulator tab connects outward and retains its owner credential in
that browser. Source files, App packages, execution and App data stay local.
Only approved tool requests/results pass through the service. `browser-targets.sqlite`
retains target credential hashes, invitation hashes and approval metadata; the
existing operation journal retains bounded durable outcomes, never project files
or observation images. Preserve that database together with the existing OAuth
and connection databases during service updates. Do not rotate the recovery key.

Existing OAuth identities may join a browser invitation, but must receive a new
human Invite/Allow decision for that target. A user without hardware may approve
first-time OAuth from the Simulator using the normal pairing-code dialog. This
proves control of that browser target, not ownership of registered hardware.
Device proof verification and each device's separate Invite/Allow stay intact.

Browser targets have no terminal, device screenshot or hardware launch. Use the
additional `apps_observe` tool for explicitly labeled DOM/layout, Canvas pixel
layers and App-reported logs; it is not a full page screenshot. The original
`apps_preview_snapshot` remains a native shared web Preview capture for device
connections. All calls still use an explicit connectionRef, exact instance and
stable mutation operation IDs. A disconnected browser does not queue/replay writes.
A live browser owner is never displaced by another socket. Idle unapproved targets
expire after a day; active approvals remain until revoked, within the configured
capacity bound. New source and this configuration require SG validation before EA.


The hosted `apps_observe` also reads the actual maker Preview through its existing
approved device connection after normal Components/Runtime installation. It uses
bounded `preview_observe_*` requests and `app-observation` File V2 results (up to
four 1 MiB PNG layers, 6 MiB total JSON), checks the exact binding and authorization
again after transfer, and removes transient bytes. No Share Preview, second
browser invitation or device desktop capture is involved. `apps_state` reports
`previewObservation` readiness and the requesting AI's `lastObservation`; absent
support is an honest unavailable result. This tool also retains the independent
browser-target path. The catalog remains 29 tools.

On an approved maker connection, explicit `apps_publish_preview` may prepare and
show the AI-selected workspace in the person's web Preview while AI holds control;
`apps_open` alone still selects only the AI workspace. Failed candidates retain
the previous applied instance. Saved packages and device running revisions are
unchanged by Preview-only publication and observation. The original native PNG
`apps_preview_snapshot` contract remains separate and still requires sharing.

A retained AI connection belongs to one approved My Apps access session. Refreshing that same tab and ordinary service/agent restarts preserve it. Ending or replacing the human access session ends its AI approval; the old connectionRef must not resume into a replacement session. OAuth connector authorization is separate. `resumable:true` offers an attempt against retained device authorization, not permission to resurrect ended access.

## Hosted request limits

The edge trusts `CF-Connecting-IP` only from the local Cloudflare proxy on
127.0.0.1. Connector setup and WebSocket upgrades use a separate per-IP budget
(40 requests/second, burst 200). `/synth` delegates its limit to the authenticated
HTTP handler: 5 requests/second, burst 30, per issuer/principal/OAuth client.
Access-token refresh retains the same allowance; one user's excess traffic does
not consume another user's budget. HTTP 429 includes `Retry-After`; rejected
requests are not dispatched to tools. Invalid credentials still return 401.

`VRCH_MCP_BROWSER_REGISTRATION_LIMIT` sets new browser identities per minute for
the service (default 20; the SG capacity setting is 200). Reconnecting a retained
identity does not consume that registration allowance. The 512-socket and
4096-record limits are unchanged. The nginx template and this environment setting
are deployment inputs; changing source does not alter an existing EA deployment.
