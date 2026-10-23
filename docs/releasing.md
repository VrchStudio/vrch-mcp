# Releasing

1. Confirm CLI account `vrch-codex`. Update the independent version/changelog,
   regenerate bundles/tool schemas, and commit scoped reviewed source.
2. Run `npm ci --ignore-scripts`, `npm run check` and `npm run test:package`.
   CI covers Linux and macOS. Record actual host/device results separately.
3. From clean source run `npm run release:pack`. Ignored `release/` contains the
   versioned tarball, standalone/compatibility modules, source receipt and hashes.
4. Push the source and exact `v<version>` tag, then publish these GitHub Release
   assets. Candidates use the prerelease flag. Never replace bytes or move a tag;
   fix forward with another version.
5. Anonymously fetch/install the fixed release, check bytes/version/STDIO and the
   representative host/device path. Keep unsupported/untested boundaries explicit.
   npm registry publication is optional and needs its own publisher access;
   the scoped package name is not a claim of namespace ownership.

Keep the tarball checksum in the generated `SHA256SUMS` and `release.json` beside
the archive. Packaged documentation points to those files: embedding the archive's
own checksum inside it changes the archive bytes and invalidates that checksum.

For future VrchStudio repositories, grant `VrchDeveloper` and `vrch-codex` at least
Maintain at creation, preserving existing higher roles. Both stay organization
Members. The existing base Write covers future code/PR/release work, not automatic
Maintain. Do not promote either account to Owner in this workflow.
