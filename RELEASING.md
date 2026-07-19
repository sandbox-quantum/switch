# Releasing Switch

This describes how to cut a release of the **Switch core stack** — the
`switch-core`, `gateway`, and `setup` container images, the Helm chart, and the
standalone Docker Compose file. The switchdash desktop app releases separately
(see `.github/workflows/switchdash-release.yml` and `dash/docs/INSTALL.md`).

## Versioning

- Switch follows [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`.
- The canonical `switch-core` version is `version` in `core/pyproject.toml`.
- The Helm chart, the three images, and the standalone compose artifact are
  published under the **same** version as the git tag, so a single tag pins the
  whole stack.

## Cutting a release

1. **Bump the version** in `core/pyproject.toml` (`[project].version`).
2. **Update `CHANGELOG.md`**: under the `## switch-core` section, move the
   `### [Unreleased]` items under a new `### [X.Y.Z]` heading and note the date.
   (The desktop app has its own `## switchdash` section, versioned separately.)
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
consumers — chiefly switchdash's local-server mode — pin against. Treat changes
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
  `dash/packages/plugins/src/distribution.ts` (used by the Claude
  connector plugin descriptor).
- **switchdash auto-update target** — `RELEASE_REPO_OWNER` / `RELEASE_REPO_NAME`
  in `dash/apps/switchdash-desktop/src/shared/app-identity.ts` (mirrored
  in `app-identity.canary.ts`), consumed by both electron-builder configs.
