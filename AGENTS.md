# VRCH MCP

Keep this project independently buildable from its public source. Production has
no third-party runtime dependencies. Never add device credentials, real invites,
private repository dependencies, test logs or local machine configuration.

`src/` owns the client, MCP adapter and shared File V2 module. `dist/` is generated
by `scripts/build.mjs` and is deliberately tracked: the public package and Viewer
Pages consume these fixed-version bundles. Do not edit generated files directly.
Viewer Pages must consume a pinned public release with checksums, preserving its
normal Components / Runtime delivery and existing authorization boundaries.

Run `npm ci`, `npm run build`, `npm test` and the package installation check before
release. Test real WebSocket and STDIO boundaries; report simulated device or
untested AI-host boundaries explicitly. Real invitations and Allow AI remain
human actions. Do not replace an existing device session to run tests.

Use scoped commits, update CHANGELOG.md, and publish immutable versioned Release
assets and SHA-256 checksums. Confirm the GitHub CLI account is `vrch-codex` before
external writes. Use this repository's local Git author configuration; preserve
other workspaces and global Git identity.
