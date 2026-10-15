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
