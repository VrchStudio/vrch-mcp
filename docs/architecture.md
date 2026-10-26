# Local architecture and source ownership

This phase delivers local STDIO MCP and public fixed-version distribution. It
adds no hosted service, account/OAuth dependency, device patch or cloud staging.
The host executes tools and retains its approvals. The device is authoritative
for Invite/Allow, scope, control, Private, target generation and revocation.

| Source | Owner and consumer |
| --- | --- |
| `src/client.mjs` | Public native WebSocket, credential and Apps/file/image client |
| `src/mcp.mjs` | Public tools, results, catalogs and initialization instructions |
| `src/cli.mjs`, `bin/` | Process entry; no automatic host configuration changes |
| `src/file-transfer.mjs` and its two hash resources | Public canonical File V2 source; Pages consumes pinned release copies |
| `dist/vrch-mcp.mjs` | Generated self-contained local MCP executable |
| `dist/vrch_terminal_ai_client.mjs` | Generated legacy adapter for Pages download/callers |
| Device relay/agent and Apps browser | Viewer Pages; outside this package |

`UPSTREAM.json` records migration source and original byte hashes. No private
checkout, historical commit or author directory is required to build/test/install.
Test dependencies use public npm and the lockfile; production uses Node built-ins.

Shared protocol fixes start in this repository's source, are tested/released,
then imported into Pages at a fixed version with checksums. Do not independently
edit Pages copies or generated bundles. Device/browser behavior changes still
use Pages dev and normal Components/Runtime delivery; publishing a native package
does not itself update a device or authorize server deployment.

The client sends requests to the invited device. It does not execute commands
received from the device on the AI computer. Local file tools use explicit paths
and granted purposes; snapshot, transfer, commit, publish and save are separate.
Stable catalogs reveal metadata before approval, not permissions; dynamic mode
retains the five-tool initial catalog and list-change notifications. Wire names
are unchanged and mutations remain non-read-only.

Local App RPC follows the original device wait, up to 120 seconds. Interrupted
results do not authorize replay; retain operation IDs where supported and read
actual App/instance state. Remote connectionRef, principal isolation and service
operation persistence remain outside this phase.


`apps_host_input` is a separate device-only operation for Menu/Device. It uses
whole-host coordinates, requires a live App binding and current AI input scope,
and routes through the same owner/epoch/privacy checks as App input. The trusted
Player allows only the named active surface and excludes access/permission and
lifecycle controls. Clicks/drags use native touch events; interrupted gestures
are canceled. It accepts no caller script, selector, URL or CDP method.
