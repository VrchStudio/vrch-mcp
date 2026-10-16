# First connection

Fetch this file directly; no web search or full README is needed.
Already have `terminal_connect`? Call it with the invitation now, then
`terminal_events({})`. Otherwise install/configure the MCP in your actual AI host.
Use that host's normal permissions. Stop if setup/startup is denied or fails;
do not switch to a standalone client or launch a nested AI session.

## Install once

Node.js22.4+ and npm on macOS/Linux. This is a fixed MIT public package; npm runs
no install scripts. Do not put an invitation or credential in MCP configuration.

```sh
npm install --prefix "$HOME/.local/share/vrch-mcp/0.1.3" --omit=dev --ignore-scripts https://github.com/VrchStudio/vrch-mcp/releases/download/v0.1.3/vrch-mcp-0.1.3.tgz
```

Tarball SHA-256: `3dc3e03a8362606229267179b2debf3b429cc8185ba065fde1c1a87142e18891`.
Release: https://github.com/VrchStudio/vrch-mcp/releases/tag/v0.1.3 .
Select only your host's normal registration below; keep existing MCP entries.
Already configured? Load that entry instead of reinstalling.

### Codex CLI

```sh
codex mcp add vrch -- "$(command -v node)" "$HOME/.local/share/vrch-mcp/0.1.3/node_modules/@vrchstudio/vrch-mcp/bin/vrch-mcp.mjs" --mcp
```

Keep this conversation. If your host offers MCP refresh, use it. Codex CLI0.162.1
`/mcp` lists tools; it is not a reload command. If the tools are not exposed after
registration, give the person one step: exit the CLI and run
`codex resume <this-session-id>` to load MCP while retaining this conversation,
installation progress and original invitation. Use the host's current session ID
(`CODEX_THREAD_ID` if exposed); never guess another session. Then continue here.
Do not open a new chat, repaste the invitation or run another AI from a shell tool.
For noninteractive host integrations the native equivalent is
`codex exec resume <this-session-id>` with a normal continuation turn.

### Claude Code / Gemini CLI

Use the matching command only:

```sh
claude mcp add --transport stdio --scope user vrch -- "$(command -v node)" "$HOME/.local/share/vrch-mcp/0.1.3/node_modules/@vrchstudio/vrch-mcp/bin/vrch-mcp.mjs" --mcp
```

```sh
gemini mcp add --scope user vrch "$(command -v node)" "$HOME/.local/share/vrch-mcp/0.1.3/node_modules/@vrchstudio/vrch-mcp/bin/vrch-mcp.mjs" --mcp
```

Use that client's supported refresh or resume the current conversation after its
required reload. If an operator action is required, state that exact action once.
Desktop/other hosts: use their supported local STDIO settings with absolute Node
and installed script paths, arguments `--mcp`; preserve other servers. Ordinary
browser chats without local MCP execution need a supported host for this release.

## Connect and report

Keep the original invitation through setup/loading; do not guess expiry.
Call `terminal_connect`, then `terminal_events({})` (default20seconds, range0..25,
returns early on events). Only real `ai_pending` means ask the person to Allow AI
in My Apps. Continue events until actual approval or a device error. Only an
actual invalid/expired response calls for a new invitation.
After approval read `ai_capabilities`, `apps_list`, `apps_state`; send a short
factual `ai_report`. Full App development guidance arrives as `apps_guide` after
approval. Do not modify Apps until asked. Report brief progress in the person's
language. Keep the invitation private; never browse/search its token URL.

For USB/private HTTP origins or advanced setup, see the full README only when
needed: https://github.com/VrchStudio/vrch-mcp . HTTPS needs no HTTP override.
