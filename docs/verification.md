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
| Public installation | Anonymous fixed GitHub Release download, SHA-256 check and scripts-disabled production install passed; zero production dependencies |
| Codex 0.162.1 / Linux | Actual MCP host initialized and discovered all 30 tools; real tool calls reached vrch-110 |
| Claude Code 2.1.236 / Linux | Normal user-scope STDIO setup in an isolated profile; actual host health reported Connected; model-to-device use not tested |
| Gemini CLI 0.64.0 / Linux | Normal user-scope setup accepted in an isolated profile; host correctly suppressed connection in an untrusted workspace. Trust was not bypassed; connected/model-to-device acceptance pending |
| User Mac / Claude Desktop | Not yet accepted on user's machine |
| vrch-110 / actual human Allow | Approved invitation, Chinese ai_report, capability brief, list/state, normal workspace edit/save and terminal output passed |
| Device files | 190,003 bytes uploaded, committed, exported and downloaded; identical SHA-256 `34217354970dce1cf2b28dacbcc082e5bb591011a3c9825dd1bea6d7290734a2`; transfer alone did not publish/save |
| Device screen/input | Native screenshot viewed; Guide blocked an ordinary click, guide_start opened it; English text, Backspace, click, drag, scroll and E1-E4/K2-K4 results visible; K1 opened system Menu |
| Device lifecycle/recovery | Test App launched/exited; saved revision retained; disconnect/resume retained AI control and scope; original five App packages untouched |
| Reject/removal/expiry/control races | Real STDIO/WebSocket software tests with simulated device; no new real-device revoke/re-invite sequence performed |
| Windows / browser-only chat / hosted MCP | Not supported by this local release |

[Candidate CI](https://github.com/VrchStudio/vrch-mcp/actions/runs/38764730009)

The actual host check used Codex's MCP host, not a simulated MCP adapter or a new
model conversation. It does not measure context-free model onboarding or promise
a paste-to-ready time. User setup approvals and thinking time were not measured.
The dedicated MCP Acceptance App remains saved for inspection and is not running.
No existing Apps access or AI authorization was revoked; no device patch, Runtime
change or shared hosted service deployment was needed for the package test.

Real invites and approvals remain human actions. Fixtures do not prove acceptance
on every AI product, model, account or network. Actual Mac desktop and additional
host tests remain follow-up acceptance work, not claims made by this release.
