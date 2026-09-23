# Hosted EC2 worker

This directory is the trusted launcher contract for the first hosted-agent EC2
backend. The AMI is built ahead of time and pins Node.js 24, the provider CLI,
the built `@switch-console/agent-providers` bootstrap artifacts and the
built Switch MCP runtime. The instance profile can call only
`secretsmanager:GetSecretValue` for this assignment's one secret (and the KMS
decrypt operation constrained to that secret). The launcher makes no EC2,
IAM, KMS, S3 or secret-list calls.

Build the self-contained Node entrypoints first:

    node deploy/hosted/build-runtime.mjs /path/to/runtime-build

Then run the installer while baking the AMI:

    install.sh /path/to/runtime-build <node-sha256> <provider-sha256> \
      @sandboxaq/switch-agent-runtime@<exact-version>

The runtime manifest is verified before its three bundles are installed. The Node and
provider executables must match image-pipeline SHA256 pins. The installer writes
those digests, all bundle digests and the exact MCP runtime package identity into the
root-only runtime configuration. The launcher rehashes every artifact at each
start and binds that configuration fingerprint into the retained-disk marker.
The baked MCP entrypoint is fixed at
`/opt/switch/agent-providers/switch-agent-runtime.mjs`; neither assignment metadata
nor the secret deployment document can select a command or path. The package identity
remains in the deployment contract so an older runtime configuration without the
optional baked path continues to launch the exact version through `npx`.

The installer creates the unprivileged
`switch-agent` account, installs the launcher and systemd unit, checks the
preinstalled artifacts and enables the unit. On AppArmor hosts, a Codex installation
also installs a profile for its bundled `bwrap` executable so it can create user
namespaces. The worker allows `AF_NETLINK` for sandbox network setup; the agent
still runs without host capabilities. It does not install mutable
latest-version packages. The image pipeline must pin and verify every artifact before running it. The
checked-in `runtime.json` shows the generated schema; its zero digests are
examples and are never installed.

For additional providers, preinstall their pinned runtimes and place a
`providers.json` beside the three bundles. It maps `codex`, `cursor`, `opencode`,
and `antigravity` to `{ "path": "/opt/switch/providers/<provider>", "sha256": "<digest>" }`.
Antigravity uses `/opt/switch/providers/antigravity-acp`.
Each entry must be a root-owned executable, with no symlink or group/world write
access. Include all supporting files in the immutable image and verify their
upstream checksums during the image build. The installer checks the entrypoint
hashes and includes them in the retained-disk runtime fingerprint.

## Non-secret assignment metadata

The controller writes root-owned mode 0600
`/etc/switch-hosted/assignment.json`. This is the complete version 1 shape:

```json
{
  "version": 1,
  "installationId": "hosted-installation-id",
  "agentId": "server-agent-id",
  "generation": 1,
  "assignmentSecretId": "arn:aws:secretsmanager:eu-west-1:000000000000:secret:example",
  "dataVolumeId": "vol-0123456789abcdef0",
  "dataDevice": "/dev/sdf",
  "mountPath": "/data"
}
```

`assignmentSecretId` must be the full Secrets Manager ARN; the launcher derives and validates its region and passes that region explicitly to boto3.

No credential is allowed in user-data, this file, an environment variable or a
command argument. The controller does not supply runtime paths. Those are baked
into root-owned `/etc/switch-hosted/runtime.json`; the checked-in file records
the AMI contract. The assignment's `mountPath` must be exactly `/data`.

## Assignment secret

Secrets Manager returns one JSON string with this strict top-level version 1
shape:

```json
{
  "version": 1,
  "assignment": {
    "installationId": "hosted-installation-id",
    "agentId": "server-agent-id",
    "generation": 1,
    "dataVolumeId": "vol-0123456789abcdef0"
  },
  "deployment": {
    "version": 1,
    "session": {
      "sessionId": "server-session-id",
      "agentId": "server-agent-id"
    },
    "provider": {
      "kind": "claude",
      "credential": {
        "kind": "api-key",
        "path": "/run/switch-hosted/secrets/provider"
      },
      "binaryPath": "/opt/switch/claude/bin/claude",
      "context": "Non-secret session instructions"
    },
    "workspacePath": "/data/workspace",
    "room": {
      "roomId": "server-room-id",
      "startCursor": 0
    },
    "runtimeMode": "approval-required",
    "switchCredentialsPath": "/run/switch-hosted/secrets/switch.json",
    "mcpRuntime": "@sandboxaq/switch-agent-runtime@<pinned-version>"
  },
  "providerCredential": "raw-provider-credential",
  "switchCredentials": {
    "env": {
      "SWITCH_API_ENDPOINT": "https://switch.example.invalid/api/agent",
      "SWITCH_API_TOKEN": "switch-agent-token",
      "SWITCH_AGENT_ID": "server-agent-id"
    }
  }
}
```

`session.nativeSessionId`, `provider.model` and
`room.startCursor` are the only optional deployment fields, matching the
hosted bootstrap. A provider credential is a nonempty single-line string of at
most 16 KiB. The Switch endpoint must be HTTPS without URL credentials, query
or fragment. IDs, generation, volume, executable and all fixed paths are
cross-checked before any secret is handed to the unprivileged process.

The root launcher writes only the deployment document, raw provider credential
and Switch credential JSON into the systemd runtime directory under
`/run`, verifies that it is tmpfs, atomically installs a root-owned, `switch-agent`-group-readable directory with
mode 0750 and files with mode 0440. It removes validated crash orphans before
launch and removes the active files when the child exits. Secret values are never arguments
or root-launcher environment variables. The Node bootstrap applies its
existing exact-value log redaction before worker output reaches the journal.
Repository code running as the agent can still read credentials assigned to
that agent; the boundary is the per-assignment IAM role and VM.

## GitHub repository credentials

An optional `github` deployment object contains `credentialPath`, fixed to
`/run/switch-hosted/secrets/github`, and may contain `repository` in
`owner/repository` form. Supply its token as `githubCredential` in the assignment
secret. With a repository selected, bootstrap checks access to that repository;
this supports GitHub App installation tokens, which cannot authenticate through
the personal-user endpoint. Existing deployments without a repository retain the
personal-user check.

Managed assignments also set `github.refresh` to `true`. Bootstrap clones the
selected repository into an empty workspace, or verifies the existing remote.
It obtains a fresh repository-scoped installation token from the authenticated
Switch endpoint at startup and before each Git or GitHub CLI command. The CLI
wrapper passes the token only to its child process. The agent environment does
not carry a static installation token. Failed renewal stops the operation with
a visible error. The image must provide GitHub CLI at `/usr/local/bin/gh`.

A managed deployment sets `watch: true` instead of `room`. The shared watcher
starts and reuses the normal per-room sessions. `provider.definition` contains
the same rendered Claude agent definition used by local agents; bootstrap writes
it beneath the selected workspace and refuses a conflicting existing definition.
Single-room operator deployments remain supported. A deployment must specify
exactly one of `room` and `watch`.

## Disk and boot ownership

The launcher resolves the instance ID only through an IMDSv2 token request and
reads the kernel boot ID from `/proc/sys/kernel/random/boot_id`. It treats `dataDevice` as the controller attachment hint, enumerates block
devices, and resolves the actual Nitro device by matching its EBS serial to
`dataVolumeId`. A blank disk is formatted
as ext4 only when the baked policy allows it and inspection finds no filesystem,
UUID, children, partition or other signature. Any unexpected nonblank disk fails
without a formatting command.

Persistent paths are `/data/state` and `/data/workspace`. A private
root-owned marker under `/data/.switch-hosted` binds the filesystem UUID, installation, agent ID, assignment generation,
runtime fingerprint, EC2 instance ID and kernel boot ID.
A root-owned nonblocking flock under `/run/lock` serializes the trusted
launcher for the whole worker lifetime.

A repeated launch in the same kernel leaves ownership records untouched. A new
boot is accepted only when the retained marker proves the same EC2 instance,
installation, generation and filesystem. Before runtime starts, the launcher
requires each known stale supervisor/worker/bakery record to carry the previous
instance/boot/generation identity, then moves only those records into the
root-only quarantine. Journals, provider home, deployment plan, workspace and
session identity are preserved. Missing markers on nonempty disks, legacy
ownership records, unknown identity, generation changes and EC2 instance
changes fail closed unless the controller supplies the exact terminated
`previousInstanceId`. The controller must first observe termination and a detached
data disk. Replacement has a limit of three automatic attempts.

An operator can upgrade an image after stopping the assignment, terminating its
old VM, and confirming the retained disk is detached. Set the configured image,
then run `switch-hosted-controller --config <config> upgrade <agent-id>
--confirm-instance-id <old-instance-id> --previous-runtime-fingerprint <sha256>`.
Read the SHA256 from the trusted root-owned disk marker. This command preserves
the stopped state; start the worker through Console after it succeeds. The
launcher accepts a runtime change only when both the predecessor instance and
its previous runtime fingerprint match. It preserves the existing session
journals and never retries uncertain commands.

The systemd unit uses `Restart=always`, so an unexpected clean runtime exit is
repaired; explicit unit stops and instance shutdown do not restart it.

Automatic instance replacement and volume relocation are intentionally
unsupported in this slice. A future replacement path needs controller-issued
cloud fencing receipts before it can authorize a fresh root. The supported
lifecycle is stop/start or reboot of the same EC2 instance. The worker has no
inbound service; outbound Internet access is supplied by the isolated worker
VPC's NAT path, whose hourly and data-processing charges continue independently
of instance runtime.

## Legacy personal-token delivery

For GitHub.com HTTPS operations, add both fields to the assignment secret:

- Top-level `githubCredential`: the raw personal access token, delivered through
  the secret-store workflow, never a room message or repository file.
- `deployment.github`: `{ "credentialPath": "/run/switch-hosted/secrets/github" }`.

Both fields must be present together or absent together. Existing assignments
without GitHub remain supported. The token must be nonempty printable ASCII
without whitespace, at most 16 KiB. The worker writes it into the same private
0440 tmpfs secret directory and removes it with the rest of the active bundle.
No GitHub token enters the root launcher's environment or arguments.

The bootstrap validates the personal token against GitHub's authenticated-user
endpoint before starting the provider. Redirects are refused and errors exclude
response bodies and credential values. This checks token identity only: repository
permissions, organization approval/SSO, branch rules and model readiness require
separate checks. Managed installation tokens use the renewal flow above. GitHub Enterprise is not supported.

The agent receives `GH_TOKEN` for GitHub CLI and a Git credential helper through
non-secret environment configuration. The helper answers only HTTPS requests to
exactly `github.com`, clears ordinary inherited credential helpers, and never
stores credentials. Git terminal prompts and gh interactive prompts are disabled.
Git and GitHub CLI must be pinned and installed in the worker image; this change
supplies authentication, not a repository checkout or automatic PR-creation step.
Commands such as `git clone https://github.com/OWNER/REPO.git`, `git push`, and
`gh pr create` use their normal permission checks and error behavior.

Use a personal token restricted to the selected disposable repository, with
permissions to read/write repository contents and create pull requests. Extra
operations, such as changing workflow files, may require additional permissions;
do not grant them implicitly. A rejected startup check prevents the provider
from launching. Revocation during work is enforced by GitHub on subsequent
requests, not a continuous platform revocation watcher. Replace a token through
the same secret reference and perform an explicit stop/start to pick it up;
rotation does not interrupt/restart a running turn automatically. Adding or removing GitHub
on an existing saved deployment changes its specification and requires explicit
reprovisioning; the bootstrap will not silently rewrite persisted configuration.

GitHub tokens are kept out of saved launch plans/configuration. Supervisor output
redacts the raw token, URL-encoded form and the helper's Basic-auth encoding.
This is defense against accidental exposure, not a boundary against code running
as that agent: it can read its own credentials and deliberately transform them.
Do not run `gh auth login`, configure a persistent credential store, or embed a
token in a remote URL as part of onboarding.

References: [Git credential helpers](https://git-scm.com/docs/gitcredentials),
[GitHub CLI environment](https://cli.github.com/manual/gh_help_environment), and
[authenticated-user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).

## Managed session control and credentials

Managed workers poll owner-authorized operations for manual session start and
restart. Operations have durable IDs and are claimed once. An unconfirmed result
becomes `unknown`; the worker does not execute it again. Chat messages, approvals,
interrupt, stop, and transcript recovery use the same session protocol as local
agents. `autoSession: false` disables automatic room starts while keeping manual
session control available.

Provider credentials are fetched over authenticated HTTPS before startup and
resume. A credential saved for Codex, Cursor, OpenCode, or Antigravity remains
unverified until the native runtime authenticates on the worker. Claude uses an
API key or setup token; Codex accepts an API key or its native authentication JSON;
Cursor uses an API key; OpenCode and Antigravity use their native authentication
JSON. Authentication files are mode 0600 in the session's provider directory.
Native OAuth refreshes are preserved until the owner replaces the source
credential. Rotated credentials apply when an idle session restarts. Disconnecting
a provider stops running sessions. GitHub renewal is also denied when a worker
is stopped or removed.

The backend enforces agent limits per owner and session limits per worker.
Session creation and recovery share the same database lock, so concurrent room
starts and manual resumes cannot bypass the limit. Scale the installation by
increasing its configured capacity and adding distinct reserved worker identities,
secrets, and instance profiles. Existing assignments keep their identity and disk.
