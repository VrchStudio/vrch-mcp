# Vrch Synth Hosted 0.1.0 release

Status (2026-11-06): the production service is deployed after user-authorized EA
promotion of the SG-tested image. Claude OAuth/pairing and the full App editing/observation flow passed on110/130
using one connector identity and independent device approvals.
The public product name is **Vrch Synth**, without an EA/Production suffix.
The local npm/STDIO version and its immutable 0.1.7 assets do not change.
Tag the hosted service as `hosted-v0.1.0`. Its GitHub release must use
`make_latest: false`, preserving local STDIO downloads through the latest-release URL.
`remote/package.json` owns the Hosted version. MCP initialize reports that version
plus the image source commit; the image label records the same version.

## Frozen inputs

- MCP: PR#1 merged as main006e4a44; its runtime code matches image source
  bdb697a82712eb1018258bc3b26ede6631bacde4. Linux/macOS CI passes on Node22.4/22/24.
  The deployed image is vrch-mcp:hosted-0.1.0-bdb697a,
  SHA-256 e17c2e12aaf358b0eaaaafe981ae08269ea0eb2c071b58cfacc5a74da01b823d.
- Client: Pages v1.9.1 / main1711579e, My Apps1.3.2, and Runtime
  20261106-mcp-environment-address-301 are installed normally on110/130.
  The same open authorization dialog follows SG -> EA without re-pairing.
  Playground remains separately owned; this release does not enable its EA bridge.
- Device Manager: MR!28 merged as main dc4b1e49, protected tag v0.12.4;
  image vrch-device-manager:mcp-0.12.4-9649d3c,
  SHA-256 b6b5a80e231423e22aeeb915796ea87dc8ff723c005b946865064e06594a538f.
  No schema migration. Existing Compose overlays, signing identity and database
  are preserved. The rollback image is v0.12.3-20261030-release1.
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

## First deployment procedure

1. Record current Device Manager image and exact Compose files, Gateway config,
   tunnel config and custom bindings. Check the MCP hostname's existing DNS state.
   Keep affected config backups private; keep neighboring container identities.
2. Use `ea.env.example` with the verified image. Create a fresh private EA state
   directory (owner UID 1000, mode 0700) and a new 32-byte base64 recovery key
   (UID 1000, mode 0600). Refuse to overwrite an existing environment/key/state.
   Export only the EA Device Manager signing key's public half as an Ed25519
   SubjectPublicKeyInfo PEM. Its issuer is `vrch-device-manager-ea`.
   Do not copy SG grants, connection records, device credentials or recovery keys.
3. Render the effective Compose configuration and check its image first; repeated
   keys in an environment file use the final value. Update only Device Manager's image and add the existing `compose.mcp.yaml`
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

## Verified deployment state

The production public OAuth/resource documents return 200 with the correct issuer
and resource. Unauthenticated /synth returns 401; retired /mcp and SDK-only test
routes return 404. SDK validation stays disabled. The Device Manager pairing
attestation route requires its signed device proof. Existing SG OAuth is separate
and retained; no SG state or credential was copied to production.

Both devices completed normal production registration and owner activation.
Normal Components/Runtime installed the published client; environment switches
preserve each realm's credentials. The user verified both already-open setup
dialogs change to the production URL without a reload or new pairing. Saved
packages, pre-existing drafts and App data matched their per-file baselines after
installation;130's baseline follows the user's deletion of two test Apps.

On both production connections, a new unsaved counter changed from3/red to4/blue;
a failing startup candidate retained the old instance and pixels; the repaired
candidate restored count4 from its own data. Existing14 saved packages per device
and device running revisions were unchanged. The first Guide correctly blocked
an input on130;110 handled Guide Start before its single encoder input. Both
devices were then returned to their prior Development environment through normal
controls. The production connector grant and per-device connection records remain.

Production MCP and Device Manager remain healthy with zero startup restarts.
ChatGPT CIMD returns 403 from this host; Claude CIMD loads successfully. Keep the
failed client unavailable rather than substituting unverified metadata.

The hosted release includes a small release.json receipt and SHA256SUMS for its
source, image and client identities. It does not replace the local STDIO package.

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
