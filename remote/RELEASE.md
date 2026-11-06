# Hosted 0.1.0 release preparation

Status: candidate prepared for review; EA deployment is a separate authorized action.
The local npm/STDIO version and its immutable 0.1.7 assets do not change.
`remote/package.json` owns the Hosted version. MCP initialize reports that version
plus the image source commit; the image label records the same version.

## Frozen inputs

- MCP: the merged source of PR #1, version 0.1.0, with passing Linux/macOS CI.
- Client minimum for the accepted web Preview/device flow: Pages `c018f738`
  and Runtime `20261106-app-default-icon-298` (My Apps 1.3.1), verified on 110/130.
  The current Pages formal branch is older; its normal dev-to-main client release
  must carry that baseline before announcing availability to unupdated devices.
  Playground is separately owned and is not implied by this service release.
- Device Manager: the MCP pairing changes from MR !28, based on v0.12.3;
  no schema migration. Preserve the exact live Compose overlays and all existing
  environment values, secrets, database and signing identity.
- Gateway: only the signed `POST /api/vrch-device-management/v1/device/mcp-pairing/attest`
  location from the tested Pages template. Preserve other routes and configuration.

## Build and check, before any deployment

Use the pinned Node 22.23.4 runtime. From the committed, pushed MCP checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
npm ci --prefix remote --omit=dev --ignore-scripts
docker build -f remote/Dockerfile \
  --build-arg COMMIT="$(git rev-parse HEAD)" \
  --build-arg VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("remote/package.json")).version')" \
  -t vrch-mcp:hosted-0.1.0 .
```

Record the source SHA, image ID and version together. Do not rebuild a different
image on EA after SG validation. Device Manager uses its existing
`deploy/build_image.sh`, with a clean pushed source and explicit version/tag.
Run its app/config tests and the Gateway route regression before promoting it.

The edge installer supports a non-mutating plan:

```sh
python3 remote/install-edge.py --environment ea --host mcp.vrch.ai \
  --config <existing-EA-tunnel-config> --bindings <existing-EA-custom-bindings> \
  --origincert <existing-EA-origincert> --unit <existing-EA-tunnel-unit> --dry-run
```

The plan validates the candidate ingress using cloudflared and prints only the
added route/binding. It does not create DNS, write deployment config, reload nginx
or restart a service. Separately run `nginx -t` against an isolated rendered
configuration on the development host. Do not point the formal hostname at SG.

## EA deployment sequence (not executed by preparation)

1. Record current Device Manager image and exact Compose files, Gateway config,
   tunnel config and custom bindings. Check the MCP hostname's existing DNS state.
   Keep affected config backups private; keep neighboring container identities.
2. Use `ea.env.example` with the verified image. Create a fresh private EA state
   directory (owner UID 1000, mode 0700) and a new 32-byte base64 recovery key
   (UID 1000, mode 0600). Refuse to overwrite an existing environment/key/state.
   Export only the EA Device Manager signing key's public half as an Ed25519
   SubjectPublicKeyInfo PEM. Its issuer is `vrch-device-manager-ea`.
   Do not copy SG grants, connection records, device credentials or recovery keys.
3. Update only Device Manager's image and add the existing `compose.mcp.yaml`
   overlay with `VRCH_DEVICE_MANAGER_MCP_RESOURCE=https://mcp.vrch.ai/synth`.
   Recreate only device-manager with `--no-deps`; leave PostgreSQL and other
   services running. Validate health and the signed-attestation route.
4. Add the exact Gateway route and validate nginx before reload. Start the MCP
   Compose project `vrch-mcp-ea` with `/etc/vrch-mcp/ea.env`; only the mcp service
   uses loopback 18916, with its ingress on 18917. SDK validation stays disabled.
   Browser-target origins stay empty until the separate public Playground origin
   and its acceptance are explicitly included.
5. Re-run the reviewed edge plan, then run the same command without `--dry-run`
   only after EA deployment approval. It preserves neighboring ingress and has
   configuration rollback. TLS terminates at the existing managed edge.
6. Check public OAuth/resource discovery, unauthenticated `/synth` 401, old `/mcp`
   404, SDK-validation routes absent, and exact EA issuer/resource values.
   Complete one normal client OAuth/pairing/Invite/Allow flow and a representative
   read/write/observe workflow on an explicitly selected compatible device.
   SG connectors remain valid and separate; first use of EA requires EA authorization.

## Rollback and evidence

- For first enablement, disable the new MCP ingress and stop only `vrch-mcp-ea`;
  keep its private state for diagnosis. Restore the previous Gateway/tunnel files
  and the recorded Device Manager image/config using the same Compose overlays.
- The edge installer's automatic rollback restores changed files/services; an
  already-created DNS CNAME remains. With the restored ingress it has no MCP route.
  Remove only a DNS record newly created by this rollout if DNS cleanup is needed.
- For later MCP upgrades, keep issuer, state path, recovery key and identity binding
  unchanged. Compare grant/connection identity digests before/after, then resume
  original references; do not rotate authorization to refresh tools.
- Keep source/image identity, health, targeted acceptance and rollback references
  in the owning deployment record. Keep secrets, raw tool output and App content
  out of release notes.
