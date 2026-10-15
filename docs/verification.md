# Verification status

Candidate **0.1.0-rc.1**. Software tests, actual AI-host integration and real-device
acceptance are separate evidence.

| Boundary | Evidence |
| --- | --- |
| Linux / Node 22.23.3 | 17 passed; one older-runtime-only test skipped |
| Official MCP SDK 1.32.1 | Real STDIO and WebSocket, simulated device; modular/standalone entries passed |
| File V2 | Binary round trip, hash identity and destination no-overwrite passed against simulated device |
| Screenshots | PNG decode, adapter acceptance, privacy race and receipt behavior passed against simulated device |
| Package | Clean tarball install with scripts disabled, zero production dependencies and installed STDIO passed |
| Linux/macOS / Node 22.4, 22, 24 CI | Pending public CI |
| Codex / Claude Code / Gemini CLI | Setup examples; actual host acceptance pending |
| User Mac / Claude Desktop | Not yet accepted on user's machine |
| vrch-110 | Pending public-version install and human invitation/Allow; existing grants preserved |
| Windows / browser-only chat / hosted MCP | Not supported by this local release |

Local fixtures do not measure model thinking, host setup approval, human waiting
or actual device state. A local tarball check is not a public-download test.

Real acceptance starts with the fixed public release and covers connect/pending,
one Allow, capabilities, Chinese progress and Apps state; files, images, input,
signals and lifecycle; and affected reject/disconnect/resume/Remove/re-invite
states. Preserve original packages/data and Hardware Check content. Real invites
and approvals remain human actions; historical permission to replace a connection
does not authorize replacing a current unrelated session.
