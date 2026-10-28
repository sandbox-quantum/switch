# Releasing Switch

This describes how to cut a release of the **Switch core stack** — the
`switch-core`, `gateway`, `setup` and `switch-hosted-controller` container
images, the Helm charts, and the standalone Docker Compose file. The Switch Console desktop app releases separately
(see `.github/workflows/switch-console-release.yml` and `console/docs/INSTALL.md`).

## Versioning

- Switch follows [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
  Every artifact carries three parts and a changelog, without exception.
- The canonical `switch-core` version is `version` in `core/pyproject.toml`.
- The Helm chart, the four images, and the standalone compose artifact are
  published under the **same** version as the git tag, so a single tag pins the
  whole stack.

**A version says where an artifact is, not what it can talk to.** Compatibility
is carried separately, by the contract revisions in
[`artifacts.yaml`](artifacts.yaml). The two move independently: a release that
changes nothing on the wire bumps its version and leaves its contracts alone.
Never derive one from the other.

### What is, and is not, separately versioned

The **operator dashboard** (`gateway/`), the **setup image**, the
**switch-hosted-controller image**, the **Helm charts**, and the **standalone
compose artifact** have no version of their own. They ship
inside the switch-core release and are stamped with its version at package time,
which is what lets a single tag pin the whole stack. They appear in
`artifacts.yaml` with `version_from: switch-core` — listed, because a registry
claiming to be the single source of truth cannot be silent about things we
publish, and `version_from` states "no version of its own" as data rather than
leaving it to be inferred from an absence.

Do not give any of them a version of their own without also giving it a release
of its own — a version nobody publishes independently is a number that drifts
from reality, which is exactly what `Chart.yaml` did while it claimed `0.2.1`.

The separately-versioned artifacts are switch-core, switch-console, the
agent-runtime package, and the sidecar.

### A known gap: the Helm chart has no contract

`values.yaml` is a real consumer-facing interface — operators write a values
file against its keys and pin the chart version — so a breaking change there is
as disruptive as renaming a compose service. It carries no contract anyway,
because a contract needs two sides that declare and nothing first-party consumes
the chart; the other side is a human-maintained values file.

A one-sided contract is a revision nobody compares, so this is left as a
documented gap rather than covered by a number that would only look like
coverage. Until it is closed, **treat a values-schema change as a breaking
change and say so in the changelog** — nothing will catch it for you.

### Bumping a contract

When you change an interface named in `artifacts.yaml`, raise that artifact's
`speaks` for the contract and run `just artifacts`. Raise `accepts` only when
dropping support for an older revision — that is a breaking change for every
peer still on it, and it can never be raised past what is running in the field.

## Cutting a release

1. **Bump the version** in `core/pyproject.toml` (`[project].version`).
   With it, **record the official templates' revisions**: `just
   record-template-revisions` adds one for each template that comes with
   Switch (switch-buddy, the Switch expert) whose files changed since the last
   release. Agents those templates created are brought up to the new revision
   when the released server starts; see "Installs and updates" in
   `docs/TEMPLATES.md`. The workflow refuses the tag while a change is
   unrecorded.
2. **Update `CHANGELOG.md`**: under the `## switch-core` section, move the
   `### [Unreleased]` items under a new `### [X.Y.Z]` heading and note the date.
   (The desktop app has its own `## switch-console` section, versioned separately.)
3. **Commit** the bump, the revisions and the changelog on a release branch and
   merge to `main`.
4. **Tag and push**: the tag MUST be `switch-v<version>` and match
   `core/pyproject.toml` (the workflow verifies this and fails on mismatch):
   ```bash
   git tag switch-v0.2.0
   git push origin switch-v0.2.0
   ```
5. The **`switch-release`** workflow (`.github/workflows/switch-release.yml`)
   then, on that tag:
   - builds multi-arch (`linux/amd64`, `linux/arm64`) images for `switch-core`,
     `gateway`, and `setup` and pushes them to the container registry tagged
     `<version>` and `latest`;
   - builds, tests and packs the agent controller at the same version and
     publishes it as the `switch-agent-controller-v<version>` GitHub release
     (see "The controller a Switch release names" below);
   - once the images are pushed, writes each image's digest into the chart's
     `values.yaml` and that controller package's version, URL and SHA-256 into
     `switchCore.controllerRelease`, packages the chart at the same version,
     checks the packaged chart renders every first-party image by digest, and
     pushes it as an OCI artifact to the same registry (see
     [Pinned by digest](#pinned-by-digest)).
   `workflow_dispatch` runs the build without pushing, for verification. It
   pins placeholder digests, so the pin and the check run too.

You can also trigger `workflow_dispatch` manually from the Actions tab to test a
build without creating a release.

### Release candidates

To publish a pre-release of the stack for staging, pilot or a canary Console,
tag a release candidate. Don't bump `core/pyproject.toml` first:

```bash
git tag switch-v0.30.0-rc.1 <commit on main>   # or on release/0.30
git push origin switch-v0.30.0-rc.1
```

- **Only from `main` or `release/*`.** The workflow refuses a tag whose commit is on
  neither.
- **The version previews the next release.** The base (`0.30.0`) must be at or above
  `core/pyproject.toml` and not already released as `switch-v0.30.0`.
- **Never `latest`.** Images, chart and compose are pushed under `0.30.0-rc.1` only.
  `helm install` skips the chart unless given `--devel` or that exact `--version`.
- **Its own controller, as a prerelease.** An RC publishes the controller as
  `switch-agent-controller-v0.30.0-rc.1`, a GitHub prerelease that `install.sh` and
  `switch-agent-controller update` leave out, and its chart names it in
  `switchCore.controllerRelease`: controllers talking to an RC update to it once
  idle, as they would for a release. `0.30.0-rc.1` sorts before `0.30.0`, so the
  release that follows moves them on. The dev cleanup never prunes it.
- **The server reports the RC.** The workflow stamps `0.30.0rc1` (the PEP 440 form)
  into `core/pyproject.toml` on the runner, so the running server's version says
  which candidate it is. Nothing is committed.

### Dev builds

Every push to `main` publishes the images and chart as a dev build, so the dev
environment runs main from published, digest-pinned artifacts instead of
building from source at deploy time.

- **Separate packages.** Dev builds go to `ghcr.io/<owner>/dev/` (`dev/switch-core`,
  `dev/gateway`, `dev/setup`, `dev/switch-hosted-controller`, `dev/charts/switch`,
  `dev/charts/switch-hosted-controller`), so the release packages' tag lists
  hold releases and RCs only. Nothing is ever tagged `latest`.
- **The dev charts carry a moving `main` tag.** Once both charts are pushed,
  the run moves their `main` tag to its build, but only while the commit it
  built is still the tip of main, so a slower run cannot move it backwards. An
  environment that follows main can track that tag, or take the highest
  version of the dev chart (`>=0.0.0-0` in Helm or ArgoCD), which comes to the
  same build because dev versions sort in build order; every other environment
  pins a version. The cleanup never deletes the build `main` points at.
- **Version** `<next patch>-dev.<run number>.g<short sha>`, e.g.
  `0.29.1-dev.512.g7f0c803` after `switch-v0.29.0`: one patch above the newest
  release tag on main, so a dev build sorts after the release it contains and
  before the next release or RC. The server reports `0.29.1.dev512` (PEP 440),
  stamped on the runner like an RC. A semver pre-release, so `helm install`
  skips it unless given that exact `--version`. No compose artifact.
- **A dev controller too.** The run publishes the agent controller at the dev
  version as a GitHub *prerelease*, `switch-agent-controller-v<dev version>`
  (package only, no `install.sh`), and pins it into the dev switch chart's
  `switchCore.controllerRelease`, so the dev environment's controllers follow
  main the way a release's follow that release. `install.sh` and
  `switch-agent-controller update` leave prereleases out.
- **The newest push wins.** Pushes to main share a concurrency group, so a dev
  build still running when the next merge lands is cancelled.
- **Pruned.** `switch-dev-cleanup.yml` runs daily and deletes dev builds older
  than 30 days that are not among the 20 newest, the dev controller
  prereleases and their tags included (`scripts/prune_dev_packages.py`;
  dispatch it with `dry_run` to see what it would delete).
- **Not gated on PR CI.** It builds whatever reached main; what an environment
  runs is decided by its pin, not by the build existing.

### Pinned by digest

The chart and the images are built together and published as one unit. The
release writes each image's registry digest into the chart before packaging:

```yaml
global:
  imageRegistry: "ghcr.io/<owner>"
switchCore:
  image: switch-core:<version>@sha256:…
  imagePullPolicy: IfNotPresent
```

and the same for `gateway` and `setup`. The hosted controller chart
(`charts/switch-hosted-controller`) is pinned through `image.repository` and
`image.digest` instead, so its image renders as
`ghcr.io/<owner>/switch-hosted-controller@sha256:…`, by digest with no tag.
So pinning a chart pins the exact
images: a deployment sets no image values, and what runs is reproducible from
the chart pin alone. The tag in front of the digest is for people; the runtime
pulls by digest, and the chart pulls a digest-pinned image `IfNotPresent` (any
other reference `Always`). Setting an image value on install opts out of the
pin. A mirror set with `global.imageRegistry` keeps the pin as long as it copies
images byte for byte, which registry-to-registry copies do.

**A version is published once.** Before building, the release asks the registry
whether any chart already has the version and fails if one does. Builds are not
bit-for-bit reproducible, so a re-run of the whole release would point the same
version at different digests. Cut a new version instead. If only a chart push
failed, re-run just the failed chart job: it reuses the run's image digests,
checks every chart before pushing any, keeps a chart already pushed with those
same images, and pushes the rest. A chart already published with any other
images fails it. `scripts/release_charts.sh` does the packaging, checks and
push, and PR CI runs its build step with placeholder digests.

Every publishing run lists every digest (the charts' own included) in its
run summary, and uploads them as a `release-pins` artifact (`release-pins.json`)
for whatever promotes the build next. `scripts/pin_chart_images.py` holds the one
list of charts and first-party images (the build matrix comes from it), does
the pinning, and checks each rendered chart: every image of that chart,
recognised by repository name whatever registry it names, must render from the
pinning registry and by digest, and no first-party image of another chart may
appear. PR CI runs the pin with placeholder digests and the check on each
chart's renders (for the switch chart, defaults and the optional workloads
on), so an image the pinner does not know about fails a pull request rather
than shipping by tag. To add an image, add it to `IMAGES` there; to add a
chart, to `CHARTS`.

## Switch Console desktop app release (separate)

The desktop app (`console/`) releases on its own tag, `switch-console-v<version>`, via
`.github/workflows/switch-console-release.yml`. The tag MUST match
`console/apps/switch-console-desktop/package.json` `version` (the workflow verifies
this and fails on mismatch). Procedure: bump `package.json`, cut the
`## switch-console` `CHANGELOG.md` section, merge to `main`, tag, push. The workflow
publishes a **GitHub Release** (macOS arm64 and x64, signed + notarized; Linux
x64 and arm64 AppImage/deb/rpm, unsigned — one job per arch, each on a runner of
that arch; Windows x64 nsis and msi, Authenticode signed via Azure Trusted
Signing).

macOS also gets a `merge-mac-manifest` job. electron-updater reads one channel
file for macOS, `latest-mac.yml`, so the two mac jobs upload installers only and
that job publishes a single manifest listing both architectures. `publish-release`
refuses to publish if the manifest names only one of them: the missing
architecture would go on checking for updates and silently never install another.

**Approval gate (required).** Both `build-macos` matrix jobs run in the GitHub
`release` environment (required reviewers), which holds the Apple signing /
notarization secrets. On tag push the (assetless) GitHub Release is created and
the Linux build runs immediately, but the **signed + notarized macOS
`.dmg`/`.zip` only build and upload after a required reviewer approves the
run**. The release is therefore **incomplete until approved**.

**Mandatory step — ping the approver on tag push.** The moment a
`switch-console-v*` tag is pushed, the releaser MUST send `louis.amaudruz` a
targeted message with the Actions run URL, stating the run is paused awaiting
his approval in the `release` environment, and asking him to approve. Do not
wait silently — the macOS build cannot proceed until he approves. Only after
the run goes green are the notes finalised and the 🚀 banner posted.
switch-core releases are **not** gated and need no such ping.

### Canary builds

Canary is a separate install (`Switch Console Canary`) that updates itself to newer
canaries and is never offered to stable installs. The same workflow builds it,
triggered by a bare-semver tag:

```bash
git tag v0.38.0-canary.1 <commit on main>      # or v0.38.0-canary.rc.1 from release/0.38
git push origin v0.38.0-canary.1
```

- **No `switch-console-` prefix.** electron-updater's canary lookup skips any tag
  that is not a valid semver, so a prefixed canary tag would be invisible to it.
- **The version previews the next release.** The base (`0.38.0`) must be at or above
  `package.json`'s version and not already released as `switch-console-v0.38.0`,
  so every canary ranks above the current stable. `package.json` is not bumped:
  the workflow stamps the tag's version into it on the runner.
- **Only from `main` or `release/*`.** The workflow refuses a tag whose commit is on
  neither.
- **Published as a prerelease, never Latest.** Stable installs read only the Latest
  release. The workflow checks that against GitHub after publishing, and reverts a
  canary that fails it to a draft.
- **Only the newest 5 canaries are kept.** Older canary prereleases and their tags
  are deleted; nothing else is ever selected.
- **Same approval gate as stable.** The macOS jobs wait for approval in the
  `release` environment, whose deployment rules must allow `v*-canary.*` tags.
- **A failed run leaves a draft**, which no updater can see. Re-run the failed
  job; the tag stays.

The canary app only reads GitHub's 10 most recent releases, and core and stable
releases count toward them. If 10 of those are published after the newest canary,
canary installs find no update until the next canary is tagged.

## switch-agent-controller release (separate)

The headless agent controller (`console/packages/agent-controller`), which runs
managed agents on a customer's own Linux or macOS machine, releases on its own tag,
`switch-agent-controller-v<version>`, via
`.github/workflows/agent-controller-release.yml`:

```bash
git tag switch-agent-controller-v0.2.0 <commit on main>
git push origin switch-agent-controller-v0.2.0
```

- **The tag sets the version.** It must be `x.y.z`; the workflow stamps it into the
  package on the runner, so `package.json` is not bumped. The controller reports it
  to Switch and compares it with newer releases.
- **What it publishes:** a GitHub Release holding
  `switch-agent-controller-<version>.tgz` (one npm package with the CLI and the
  shared-host bundle, no dependencies), its signature
  `switch-agent-controller-<version>.tgz.sig` (see [Release signing](#release-signing))
  and `install.sh`. It is never marked Latest,
  so Switch Console's stable updater never sees it.
- **How installs find it:** `install.sh` and `switch-agent-controller update` list the
  repository's releases and take the highest non-draft, non-prerelease controller tag
  that carries its package. No npm registry or token is involved.
- **Canary visibility:** each controller release counts toward the 10 most recent
  releases the Console canary updater reads (see Canary builds above).
- **Not gated:** the workflow needs no approval. It tests the controller, packs it,
  installs the package and runs it once before releasing.

`workflow_dispatch` runs everything except signing and the release, for
verification, and needs no secret.

### Release signing

Controllers install only a release signed with a key built into them, so neither
a compromised Switch server nor its chart values can make them run a package the
release workflows did not publish. Both `agent-controller-release.yml` and the
`controller` job of `switch-release.yml` sign each package they publish (stable,
RC and dev builds alike) with `scripts/sign-release.mjs`, which writes
`<package>.tgz.sig`: the Ed25519 signature, base64, of
`switch-agent-controller-release-v1\n<version>\n<sha256>\n`. The private key is
the `CONTROLLER_RELEASE_SIGNING_KEY` GitHub Actions secret (PKCS#8 PEM). A
publishing run without it fails, and so does one whose key's public half is not in
`console/packages/agent-controller/src/release-keys.ts`. A re-run of a release
that is already published with the same package uploads the signature if the
release lacks it.

The controller (`run`, `update`) and `install.sh` check the signature against the
trusted keys in `src/release-keys.ts` (`install.sh` carries a copy between its
`TRUSTED RELEASE KEYS` markers; `release-keys.test.ts` fails when they differ).
With no trusted key, they install nothing.

**Generating the first key.** On a machine you trust:

```bash
cd console/packages/agent-controller
node scripts/generate-release-signing-key.mjs release-<yyyy>-<mm>
```

It prints three things: the entry for `TRUSTED_RELEASE_KEYS` in
`src/release-keys.ts`, the same key as a line for `install.sh`, and the private
key. Paste the first two and merge them; store the private key as the repository
secret `CONTROLLER_RELEASE_SIGNING_KEY` (Settings → Secrets and variables →
Actions, or `gh secret set CONTROLLER_RELEASE_SIGNING_KEY < key.pem` from a file
you then delete), and keep no other copy outside a password manager or vault.
No release can be published while the list is empty: `sign-release.mjs` refuses
a key that is not in it. Controllers from before release signing check only the
SHA-256 Switch names, so they update to the first signed release as before and
verify signatures from then on.

**Rotating.** Generate a new key with a new id, add it to both lists beside the
old one, and release: controllers on that release trust both. Once they have
moved to it (the owner's controller list shows `release.current`), replace the
secret with the new private key, and in a later release remove the old public
key. A controller that skipped the release trusting both cannot verify releases
signed only with the new key; reinstall it by hand.

**If the private key leaks.** Remove its public key from both lists, add a new
one, replace the secret, and release. Controllers still on releases that trust
the leaked key keep trusting it until they update, so treat them as exposed until
they run the new release.

### The controller a Switch release names

A Switch release (`switch-v<version>`) also publishes the controller
(an RC and a dev build of main do too, as a prerelease: see
[Release candidates](#release-candidates) and [Dev builds](#dev-builds)),
built from the same commit, as `switch-agent-controller-v<version>`: the same
GitHub release this workflow makes (package and `install.sh`, never Latest), so
`install.sh` and `switch-agent-controller update` find it as they find any other.
Its tag is created by the release with the workflow token, which starts no
workflow, so this workflow does not publish it again. If that release already
exists (a re-run), the switch-release workflow checks that its package is the
one it just built and fails otherwise.

The chart from that release names the package in `switchCore.controllerRelease`
(`version`, `url`, `sha256`), which switch-core gets as
`CONTROLLER_RELEASE_VERSION`, `_URL` and `_SHA256` and hands every controller in
its status answer (except Switch Console's own, which updates with Console). A
controller running another version downloads the package,
refuses it unless its SHA-256 matches and its signature (`<url>.sig`) verifies
against a key built into the controller, and installs it and restarts once none
of its agents has a session running. The owner's controller list
(`GET /gateway/management/controllers`, `release.current`) shows which are not yet
on it.

- **Rollback:** point the three values at the previous release's package (its
  version, its `.../switch-agent-controller-v<old>/switch-agent-controller-<old>.tgz`
  URL, and the SHA-256 in its release notes) and upgrade the chart. Setting none of
  them stops telling controllers anything; they keep the version they have.
  The previous release must carry a signature a controller trusts: one published
  before release signing, or signed only with a key since removed, is refused.
- **Versions now follow Switch.** Controllers released this way carry the Switch
  version, which is well above the controller's own earlier `0.1.x` line. A
  controller release tagged by hand still works, but take its version from the
  Switch version it ships beside, or it is either overtaken by the next Switch
  release or ahead of the one Core names.

## Where artifacts are published

The images, the chart, and the standalone compose artifact all go to **GitHub
Container Registry (GHCR)** by default, and are public alongside the repository
— pulling them needs no credential. The registry and namespace are workflow env
vars (`REGISTRY`, `IMAGE_NAMESPACE`) so retargeting to another registry (e.g.
ECR) is a one-line change, not a rewrite.

Consuming the published artifacts:

```bash
# images
docker pull ghcr.io/<owner>/switch-core:<version>

# chart (its images are pinned inside it by digest); the hosted controller's
# chart is charts/switch-hosted-controller
helm install switch oci://ghcr.io/<owner>/charts/switch --version <version> \
  -f my-values.yaml

# or pin the chart itself by digest, from the run summary
helm install switch oci://ghcr.io/<owner>/charts/switch@sha256:<chart digest> \
  -f my-values.yaml

# standalone compose (OCI artifact) — pull the file, then run it
oras pull ghcr.io/<owner>/standalone-compose:<version>
SWITCH_VERSION=<version> docker compose -f standalone-docker-compose.yml up -d
```

## The standalone compose as a versioned contract

`deploy/local/standalone-docker-compose.yml` is published to GHCR as an OCI
artifact (`standalone-compose:<version>`, plus `latest`) on every release,
stamped with the same version as the images. It is a **versioned contract**:
its service names, compose profiles, and env vars are an interface that
consumers — chiefly Switch Console's local-server mode — pin against. Treat changes
to that interface as you would any public API change.

- **Images, not builds.** Services reference published GHCR images via
  `SWITCH_REGISTRY` / `SWITCH_IMAGE_NAMESPACE` / `SWITCH_VERSION` (see
  `.env.example`). Repo users who want the build-from-source flow layer
  `standalone-docker-compose.build.yml` on top — that is what `just
  standalone-up` runs.
- **Profiles.** Core services (`postgres`, `switch`) always start.
  Optional services are opt-in behind profiles: `collab` (`init-db`,
  `mattermost`, `setup`) and `gateway` (`gateway`). Enable with
  `--profile collab --profile gateway` or `COMPOSE_PROFILES`.

## PyPI

`switch-core` is **not** published to PyPI. It is consumed as a container image
or run from source, not imported as a library, so there is no `pip install
switch-core`. The `core/pyproject.toml` metadata is kept complete and valid so it is
PyPI-ready if that decision is ever reversed.

## Repo-coordinate config points

Everything that hardcodes the repo coordinates (`sandbox-quantum/switch`) is
centralized, so retargeting the repo is a configuration flip, not a code
change. The full list:

- **Image + chart + compose registry** — `REGISTRY` / `IMAGE_NAMESPACE` env
  vars in `.github/workflows/switch-release.yml`.
- **Standalone compose image defaults** — `SWITCH_REGISTRY` /
  `SWITCH_IMAGE_NAMESPACE` in `.env.example` (and the inline `${…:-default}`
  fallbacks in `deploy/local/standalone-docker-compose.yml`).
- **Python package URLs** — `[project.urls]` in `core/pyproject.toml`.
- **Switch Console auto-update target** — `RELEASE_REPO_OWNER` / `RELEASE_REPO_NAME`
  in `console/apps/switch-console-desktop/src/shared/app-identity.ts` (mirrored
  in `app-identity.canary.ts`), consumed by both electron-builder configs.
