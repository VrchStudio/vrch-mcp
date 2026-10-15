## Patch 0.1.1: first-connection guidance

2026-10-15: the patch clarifies the next event call/default20/limit25, preserves
invitation reuse through host setup/reload, and moves optional long-operation
configuration out of first connection. No new capabilities or permissions.
Local Node22.23.3: 17 tests passed, one older-runtime-only check skipped; real
STDIO/WebSocket boundaries with simulated device and clean production-package
installation passed. An invalid wait value is rejected even when events are
queued; those events remain available to the next valid call. [All six Linux/macOS CI jobs passed](https://github.com/VrchStudio/vrch-mcp/actions/runs/38789448957).
[Fixed Release0.1.1](https://github.com/VrchStudio/vrch-mcp/releases/tag/v0.1.1)
source is825986318b381eb1a28a03adbb4d9d6d21d7964f. Anonymous tarball SHA-256
`2ae4ac64cd33f775400fa5c53e8cbaeaaa8410a0819ed0dc505c4a9e190e7a57`
matched. Viewer Pages dev792e9293 was installed through normal Components on110;
five actual served resources matched. Existing969App files/access digests were
unchanged across that update. No Runtime action, session replacement or remote
MCP deployment was performed. Historical0.1.0 evidence below remains distinct.

### Second invitation-only Opus test, 0.1.1

Exact `anthropic/claude-opus-5-5` / `high`, same Codex CLI0.162.1 and
Node22.23.3/Linux, new isolated empty HOME/workspace, no MCP installation/config,
credentials, old conversation or private repository visible. Only the actual
new copied invitation was supplied. The model fetched public0.1.1 itself,
verified the Release tarball against SHA256SUMS, installed with no install
scripts and registered MCP through normal host approvals. A new conversation
loaded those tools and received only the same original invitation, no coaching.
The second conversation is not itself an uninstalled cold environment.

| Cumulative seconds / boundary | First0.1.0 trial | Second0.1.1 trial |
| --- | ---: | ---: |
| Package installed | 30.0 | 60.6 |
| MCP registered | 38.5 | 66.3 |
| First conversation finished | 57.6 | 72.8 |
| New conversation started | 106.8 | 73.1 |
| Actual ai_pending event | 122.2 | 88.0 |
| Actual human ai_approved | 140.5 | 125.9 |
| Capabilities returned | 143.6 | 129.3 |
| Apps list/state read | Not called | Both before129.4 |
| ai_report delivered | 147.8 | 133.9 |
| Ready and process completion | 153.9 | 139.1 |
| Host reopening/dispatch gap | 49.2 | 0.3 |
| Pending-to-approved window | 18.4 | 37.9 |
| Approximate execution excluding those windows | 86.4 | 100.8 |

The total valid run shortened14.9s, but installation was30.6s slower. The model
spent25.7s on a web search that did not find the public README before fetching it
directly, and chose checksum verification. Most total-time improvement came from
immediate host reopening; human approval timing varied. This single observation
does not establish faster execution, an onboarding SLA or any other host's support.

No unsupported re-invitation request or invalid wait argument occurred. All three
terminal_events calls used `{}`; zero MCP tool errors. After real human Allow,
capabilities/list/state supported the delivered report: five saved Apps, Metronome
selected, no running preview/device instance. This test made no App/file/input or
Launch/Exit mutations. English was explicitly acceptable. Host restart was still
required in this noninteractive host; the model's suggestion that `/mcp` could
reload has not been established for this CLI. It also spoke too confidently that
the invitation was still valid; successful reuse, not that assertion, is evidence.

Test preparation was separately faulty: copying Node without preserving symlinks
broke npm; two invalid host attempts were stopped before any device connection.
A genuinely NEW environment was then rebuilt and node/npm/npx/Codex/noMCP checked
before the valid trial. Conversation UTC first attempted start through final
ready was286.9s (about4m47), with148.3s before the valid conversation; the table's
139.1s is the valid trial, not a hidden all-attempt total. Earlier implementation
and environment preparation are not timed as onboarding. Raw logs/invitations
are not published.

An existing MCP Acceptance App was deleted through normal Apps at18:59:53 UTC,
before the first test model started at19:00:23; it was not restored. Remaining
original App files kept identical hashes. The human's Remove/reinvite/Allow
changed the Apps authorization as expected. Host exit disconnected the test
client without revoking that new grant; its independent resume credential is
retained privately. No other device or shared server was changed.

# Verification status

Initial release **0.1.0**. The unchanged collaboration implementation was accepted
from public candidate **0.1.0-rc.1** on 2026-10-15; the release changes version and
documentation only. Software, actual AI-host integration and device acceptance
are separate evidence.

| Boundary | Evidence |
| --- | --- |
| Linux / Node 22.23.3 | 17 passed; one older-runtime-only test skipped |
| Official MCP SDK 1.32.1 | Real STDIO and WebSocket, simulated device; modular/standalone entries passed |
| Linux/macOS / Node 22.4, 22, 24 | All six public CI jobs passed, including clean package installation |
| Public installation | Anonymous fixed v0.1.0 GitHub Release download, SHA-256 check and scripts-disabled production install passed; zero production dependencies |
| Codex 0.162.1 / Linux | Actual MCP host initialized and discovered all 30 tools; real tool calls reached vrch-110 |
| Opus 5.5/high, Codex CLI 0.162.1 / Linux | Empty isolated environment, invitation only: model installed public 0.1.0, registered MCP, requested a new conversation, connected to110 after human Allow, read capabilities and delivered ai_report. Full timing and limits below |
| Claude Code 2.1.236 / Linux | Normal user-scope STDIO setup in an isolated profile; actual host health reported Connected; model-to-device use not tested |
| Gemini CLI 0.64.0 / Linux | Normal user-scope setup accepted in an isolated profile; host correctly suppressed connection in an untrusted workspace. Trust was not bypassed; connected/model-to-device acceptance pending |
| User Mac / Claude Desktop | Not yet accepted on user's machine |
| vrch-110 / actual human Allow | Approved invitation, Chinese ai_report, capability brief, list/state, normal workspace edit/save and terminal output passed |
| Device files | 190,003 bytes uploaded, committed, exported and downloaded; identical SHA-256 `34217354970dce1cf2b28dacbcc082e5bb591011a3c9825dd1bea6d7290734a2`; transfer alone did not publish/save |
| Device screen/input | Native screenshot viewed; Guide blocked an ordinary click, guide_start opened it; English text, Backspace, click, drag, scroll and E1-E4/K2-K4 results visible; K1 opened system Menu |
| Device lifecycle/recovery | Test App launched/exited; saved revision retained; disconnect/resume and candidate-to-public-0.1.0 upgrade/resume retained AI control and scope; original five App packages, revisions and drafts unchanged |
| Reject/removal/expiry/control races | Real STDIO/WebSocket software tests with simulated device; no new real-device revoke/re-invite sequence performed |
| Windows / browser-only chat / hosted MCP | Not supported by this local release |

[Release CI](https://github.com/VrchStudio/vrch-mcp/actions/runs/38767726378)

The initial release check used Codex's MCP host without a model conversation.
A separate actual Opus first-install model test is recorded below; one measured
run does not establish a general onboarding time or SLA.
The dedicated MCP Acceptance App remains saved for inspection and is not running.
No existing Apps access or AI authorization was revoked. Viewer Pages integration
`f16df8d4` was installed through normal Components on vrch-110; the invitation
guide and four affected entry/client responses matched the published source
(HTML compared after identifying Cloudflare analytics insertion). No device
patch, Runtime action or shared hosted MCP deployment was used. Components shows
an unrelated Runtime172 pending action from other previously published changes;
it was left pending and is not needed by these static MCP instructions.

Real invites and approvals remain human actions. Fixtures do not prove acceptance
on every AI product, model, account or network. Actual Mac desktop and additional
host tests remain follow-up acceptance work, not claims made by this release.


## Opus first-install test, 2026-10-15

Model `anthropic/claude-opus-5-5`, effort `high`, no fallback; Codex CLI0.162.1,
Linux, Node22.23.3 already available. An isolated empty home/workspace hid existing
VRCH installations, credentials, repositories, previous conversations and the
harness. Both model conversations received only the verbatim copied invitation.
Normal on-request/automatic approvals remained enabled. The model installed
public GitHub Release0.1.0 itself; no setup commands were supplied by the parent.

| Milestone | Cumulative seconds |
| --- | ---: |
| Public package installed | 30.0 |
| MCP registered | 38.5 |
| First conversation ended and requested a fresh host session | 57.6 |
| New context received the same invitation | 106.8 |
| terminal_connect returned | 119.0 |
| ai_pending observed | 122.2 |
| Human ai_approved observed | 140.5 |
| ai_capabilities / ai_report delivered | 143.6 / 147.8 |
| Ready report and process completion | 153.9 |

The reload/test-dispatch gap was49.2s. The pending-to-approved window was18.4s,
including notification, human action and polling, not a precise reaction time.
A prior invalid harness attempt lacked Codex's code-mode executable and stopped
at15.5s before any installation/connection; repair and a new empty environment
added39.2s before the valid test. First attempted launch through final ready was
193.1s. Environment preparation before the first launch was not measured.

Observed issues: one new conversation was required to load tools; the model
incorrectly guessed the invitation had probably expired after setup (the same
invitation worked); one waitSeconds=55 call exceeded the documented25 limit and
was corrected; and the English-only invitation produced English progress reports.
The supplied copy lacked the newer direct public setup URL; the model discovered
the public package through the device guide. Current-copy speed was not measured.
Initial sandbox DNS restriction was resolved through normal network approval.
Installation was not denied and no denied startup was repeated.

This proves first installation and approved capability/reporting for this exact
model/host. The model stopped ready for instructions without apps_list/state,
App edits, files, input or lifecycle operations; earlier capability acceptance
is separate. It does not validate Claude Code's approval behavior or user Mac.
The temporary client stopped; the device grant was not revoked and its private
resume credential is retained separately. No real invitation or raw model output
is published. No product code or Runtime was changed by this test.
