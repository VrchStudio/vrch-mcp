# Current local MCP verification

2026-10-23 independent check of public release **0.1.3**, source
`3333498d5208d1b09fd97698cf1caba7e024056f`. This is a local STDIO server;
hosted `mcp.vrch.ai`, remote authentication and cloud file staging remain phase two.

| Boundary | Result checked in this session |
| --- | --- |
| Linux / Node 22.23.3 / npm 10.9.9 | Generated bundles match source; 20 tests passed, one older-runtime-only test skipped |
| Official MCP SDK 1.32.1 | Actual STDIO and WebSocket boundaries passed with simulated devices; no real device was connected |
| Public release | Anonymous download matches both SHA256SUMS and release.json; all 23 packaged files match the recorded source |
| Public-package installation | Scripts-disabled isolated production installation passed; zero production dependencies; actual STDIO exposed 30 tools and refused unconnected App access |
| Public CI at this source | [Linux/macOS and Node 22.4/22/24 workflow passed](https://github.com/VrchStudio/vrch-mcp/actions/runs/38953768222) |

The downloaded tarball SHA-256 is
`4ff2754a0f550abd011aeb0e23b711426248d5dc6b62ce1ec4378e0a7df08bbd`.
The short guide archived in the 0.1.3 package contains an incorrect copied
checksum. The public source guide now directs verification to the release's
generated checksum files; published assets and the package version are retained.

The initial sandbox run could not open loopback listeners or reliably launch test
subprocesses (EPERM). Repeating the same checks with the normal test permissions
passed; that environment failure is distinct from a product assertion failure.
The shell's default Node 12 was not used for acceptance.

This check does not repeat a model-led first installation, user Mac/Desktop
acceptance, real-device revocation/re-invitation, or the separate dual-surface
Allow AI device acceptance. Existing grants and Apps were untouched. Historical
host/device results below apply only to their recorded versions and boundaries.

## Direct setup and same-conversation loading (R10)

2026-10-15: `docs/connect.md` is the direct plain-text first-connection entry;
it pins the existing0.1.1 release. No MCP protocol/code/version or release asset
changed. Codex CLI0.162.1 `/mcp` lists tools, not a configuration reload.
An isolated actual Opus5.5/high host probe created a conversation without VRCH,
registered the public MCP, then used native `codex exec resume` on that exact
thread. It retained the first-turn marker and discovered/called the newly loaded
`ai_capabilities` tool, which correctly refused before any device connection.
This validates retained context and newly configured tool loading after a CLI
reload. It does not claim in-turn hot loading or a device test. The independent
invitation-only 110 benchmark follows.


### Third invitation-only test: direct guide and the same conversation

Exact Opus 5.5/high, Codex CLI 0.162.1, Linux and Node 22.23.3 / npm 10.9.9.
A newly isolated empty HOME/workspace had no MCP installation/configuration,
credentials, old conversation, private repositories or visible harness. The model
received only the actual copied invitation, fetched public `docs/connect.md`,
installed fixed 0.1.1 itself with scripts disabled and registered it using normal
approvals. The host then used native `codex exec resume` with the exact original
thread ID and only a neutral "Continue." turn. The invitation and setup context
carried over; no new chat, repasted invitation, parent setup commands, nested AI
or standalone client. This reloads the CLI, not tools inside the original turn.

| Cumulative seconds / boundary | Previous R9 | R10 valid test |
| --- | ---: | ---: |
| Public package installed | 60.6 | 32.4 |
| MCP registered | 66.3 | 57.8 |
| First turn completed | 72.8 | 67.9 |
| Second host turn started | 73.1 (new context) | 68.2 (same conversation) |
| terminal_connect returned | 87.9 | 87.7 |
| Actual ai_pending | 88.0 | 87.8 |
| Actual ai_approved | 125.9 | 105.6 |
| Capabilities/list/state all read | 129.4 | 114.7 |
| ai_report delivered | 133.9 | 126.2 |
| Ready/process completion | 139.1 | 132.9 |
| Reload/dispatch gap | 0.3 | 0.3 |
| Pending-to-approved window | 37.9 | 17.9 |
| Approximate execution excluding those windows | 100.8 | 114.8 |

The short guide arrived at 17.2s and matched public source exactly; zero web
searches, versus the previous failed 25.7s README search. Installation finished
28.1s earlier but registration only 8.5s earlier: the model then separately fetched
the tarball, verified its SHA-256 and compared npm lock SHA-512 integrity.
The measured pending time is effectively unchanged. Overall completion improved
6.2s (4.5%), while the approval window shrank 20.1s; approximate execution grew
14.0s. These single runs do not prove total processing became faster or establish
an SLA. Tool discovery, checksum work and report generation still take model time.

Both terminal_events calls used `{}`. All seven MCP calls succeeded without
retry. The real human approved the device request; actual capabilities, five
saved Apps and device/preview state were read, followed by a delivered 188-character
English report consistent with the results. No App ran; no App/file/input/lifecycle
operation was attempted. The 958 App files matched the post-update baseline after
both runs. The client stopped without revoking the AI grant or ending the human's
Apps access; its independent resume credential is retained privately. The model's
chat summary mistyped a shortened checksum suffix as 7e57 rather than 7a57; the
actual full SHA-256 and npm integrity comparisons were correct. Do not use a chat
abbreviation as an installation integrity check.

One earlier R10 attempt was interrupted by a benchmark-recorder null-result bug
at terminal_connect start, after installation/registration and same-thread tool
loading had already succeeded. Resuming that conversation completed actual
pending/approval/report at 138.5/150.2/160.3s, total 165.2s. That interrupted run is
excluded from the comparison. After fixing and replay-checking the recorder, a
new empty environment and a human-generated fresh invitation produced the valid
run above. First attempt through final completion was 380.2s (6m20), including an
82.1s inter-attempt explanation/re-invitation/preparation interval. This full time
is distinct from the valid 132.9s, and is not attributed to product connection
latency. No invitation, credential or raw model output is published.

Viewer Pages dev edfd297a was delivered to 110 through normal Components; actual
served assets and three-width browser checks passed. No Runtime action, existing
grant takeover or hosted remote MCP deployment. This exact model/host path is
verified; Claude Code/Desktop, user Mac and other hosts remain separate acceptance.

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
