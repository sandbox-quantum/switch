# Risky Area: Updater And Packaging

## Main Files

- `src/main/core/updates/update-service.ts`
- `src/main/core/updates/controller.ts`
- `src/main/core/updates/github-token.ts` — the updater's `gh` CLI token
- `src/main/core/updates/dev-harness.ts` — `SWITCHDASH_FAKE_UPDATE` replay
- `build/`
- `package.json`
- `electron-builder.config.ts`
- `electron-builder.canary.config.ts`
- `.github/workflows/switch-console-release.yml` — the release pipeline (repo root, **not** under `console/`)

There is no `scripts/release/` directory. Releasing is done by the GitHub Actions
workflow above, which calls `electron-builder` directly; the packaging, notarization and
finalize steps are workflow jobs rather than TypeScript entry points.

## Rules

- avoid changing updater defaults casually
- treat signing, notarization, packaging targets, and native rebuild flow as release-critical
- keep build output directories and packaging config stable unless the task is explicitly about release behavior

## Update Feed / Publishing Strategy

The release pipeline publishes to **GitHub Releases** only. The Cloudflare R2 feed that
ran alongside it during the migration is gone: neither electron-builder config has a
`generic` publish block, and there is no R2 upload step.

### One feed

electron-builder emits channel manifests named by the publish provider's `channel`:

- Stable: `provider: github` (`releaseType: 'release'`) has no explicit channel → defaults to `latest` → emits `latest*.yml`.
- Canary: `provider: github` (`releaseType: 'draft'`) sets `channel: 'canary'` → emits `canary*.yml`.

The release repo is `sandbox-quantum/switch`, public, so the updater reads the feed
with electron-updater's GitHub provider and no credential.

### Draft until every platform has uploaded

The workflow does **not** let electron-builder publish (`--publish never`). Instead:

1. `create-release` opens the GitHub Release as a **draft**. A draft is invisible to
   electron-updater — `/releases/latest` skips drafts — so no client can see a
   half-uploaded release.
2. Each platform job builds, then `gh release upload`s its installers **and** its
   electron-updater channel manifest.
3. `publish-release` runs last. It **verifies every expected channel manifest is
   present** and refuses to publish if any is missing, leaving the release a draft with
   an error naming what's absent.

That last step is the guard worth knowing about: binaries published against a stale or
missing channel manifest produce sha512 checksum failures on client download, so the
pipeline would rather stay a draft than publish an inconsistent release.

### `UPDATE_CHANNEL` is a log label, not a feed selector

`UPDATE_CHANNEL` (`src/shared/app-identity.ts`) is `'v1-stable'` / `'v1-canary'` — naming
inherited from the retired R2 bucket. It is passed **only** to `log.info` calls in
`update-service.ts` for diagnostics. It is **not** passed to `autoUpdater.channel` and not
used to build a feed URL. Do not wire it into feed selection on the assumption that a
constant named "channel" must be one.

### Update channels on GitHub

The app does **not** override `autoUpdater.channel`; the GitHub provider resolves the channel naturally:

- **Stable** (`allowPrerelease=false`): resolves to `latest`, fetches `latest*.yml` from the newest non-prerelease GitHub release.
- **Canary** (`allowPrerelease=true`): resolves the target release tag from the Atom feed by matching the semver prerelease identifier of the installed version (`canary`) against each entry. Once a `-canary.N` tag is found it fetches `canary*.yml` from that release, as defined by `channel: 'canary'` in `electron-builder.canary.config.ts`.

- Canary publishes to GitHub as prereleases. `ALLOW_PRERELEASE` in `update-service.ts` is driven by `IS_CANARY` so canary clients accept prerelease versions automatically.
- The `publish-release` workflow job runs after all platform builds complete to flip the draft GitHub release to published. Until that job finishes the release remains a draft and is invisible to electron-updater clients.

## Authenticating the updater

Nothing to authenticate: the release repo is public, so the feed and the release-notes
API are both read anonymously.

If a credential is ever needed here again, hand it to `autoUpdater.setFeedURL(...)`
rather than exporting `GH_TOKEN`. Switch Console's environment is inherited by every
child process it spawns — including `gh` itself, which prefers `GH_TOKEN` over its
keyring — so a token parked there outlives the login it came from and shadows the next
one until the app restarts.

## Current Notes

- macOS and Linux release builds rebuild native modules for the target Electron version
- changelog and auto-update behavior are separate but related surfaces in the app
