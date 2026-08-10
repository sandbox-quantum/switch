# Releasing Switch

This describes how to cut a release of the **Switch core stack** — the
`switch-core`, `gateway`, and `setup` container images, the Helm chart, and the
standalone Docker Compose file. The Switch Console desktop app releases separately
(see `.github/workflows/switch-console-release.yml` and `console/docs/INSTALL.md`).

## Versioning

- Switch follows [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
  Every artifact carries three parts and a changelog, without exception.
- The canonical `switch-core` version is `version` in `core/pyproject.toml`.
- The Helm chart, the three images, and the standalone compose artifact are
  published under the **same** version as the git tag, so a single tag pins the
  whole stack.

**A version says where an artifact is, not what it can talk to.** Compatibility
is carried separately, by the contract revisions in
[`artifacts.yaml`](artifacts.yaml). The two move independently: a release that
changes nothing on the wire bumps its version and leaves its contracts alone.
Never derive one from the other.

### What is, and is not, separately versioned

The **operator dashboard** (`gateway/`), the **setup image**, the **Helm chart**,
and the **standalone compose artifact** have no version of their own. They ship
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
agent-runtime package, the sidecar, and the two connector plugins.

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
2. **Update `CHANGELOG.md`**: under the `## switch-core` section, move the
   `### [Unreleased]` items under a new `### [X.Y.Z]` heading and note the date.
   (The desktop app has its own `## switch-console` section, versioned separately.)
3. **Commit** the bump + changelog on a release branch and merge to `main`.
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
   - packages the Helm chart at the same version and pushes it as an OCI
     artifact to the same registry.
   `workflow_dispatch` runs the build without pushing, for verification.

You can also trigger `workflow_dispatch` manually from the Actions tab to test a
build without creating a release.

## Switch Console desktop app release (separate)

The desktop app (`console/`) releases on its own tag, `switch-console-v<version>`, via
`.github/workflows/switch-console-release.yml`. The tag MUST match
`console/apps/switch-console-desktop/package.json` `version` (the workflow verifies
this and fails on mismatch). Procedure: bump `package.json`, cut the
`## switch-console` `CHANGELOG.md` section, merge to `main`, tag, push. The workflow
publishes a **GitHub Release** (macOS arm64 signed + notarized; Linux x64
AppImage/deb/rpm, unsigned).

**Approval gate (required).** The `build-macos` job runs in the GitHub
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

## Where artifacts are published

The images, the chart, and the standalone compose artifact all go to **GitHub
Container Registry (GHCR)** by default. While the repository is private the
packages are private too; they become public automatically when the
repository/packages are made public at the public-repo move (CHOO-1260). The
registry and namespace are workflow env vars (`REGISTRY`, `IMAGE_NAMESPACE`) so
retargeting to another registry (e.g. ECR) is a one-line change, not a rewrite.

Consuming the published artifacts:

```bash
# images
docker pull ghcr.io/<owner>/switch-core:<version>

# chart
helm install switch oci://ghcr.io/<owner>/charts/switch --version <version> \
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
- **Profiles.** Core services (`postgres`, `tuwunel`, `switch`) always start.
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
- **Plugin marketplace source** — `SWITCH_MARKETPLACE_SOURCE` in
  `console/packages/plugins/src/distribution.ts` (used by the Claude
  connector plugin descriptor).
- **Switch Console auto-update target** — `RELEASE_REPO_OWNER` / `RELEASE_REPO_NAME`
  in `console/apps/switch-console-desktop/src/shared/app-identity.ts` (mirrored
  in `app-identity.canary.ts`), consumed by both electron-builder configs.
