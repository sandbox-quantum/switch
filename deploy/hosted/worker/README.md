# Hosted EC2 worker

This directory is the trusted launcher contract for the first hosted-agent EC2
backend. The AMI is built ahead of time and pins Node.js 24, the provider CLI,
the built `@switch-console/agent-providers` bootstrap artifacts and the
published Switch runtime. The instance profile can call only
`secretsmanager:GetSecretValue` for this assignment's one secret (and the KMS
decrypt operation constrained to that secret). The launcher makes no EC2,
IAM, KMS, S3 or secret-list calls.

Build the self-contained Node entrypoints first:

    node deploy/hosted/build-runtime.mjs /path/to/runtime-build

Then run the installer while baking the AMI:

    install.sh /path/to/runtime-build <node-sha256> <provider-sha256> \
      @sandboxaq/switch-agent-runtime@<exact-version>

The runtime manifest is verified before its bundles are installed. The Node and
provider executables must match image-pipeline SHA256 pins. The installer writes
those digests, both bundle digests and the exact MCP runtime version into the
root-only runtime configuration. The launcher rehashes every artifact at each
start and binds that configuration fingerprint into the retained-disk marker.

The installer creates the unprivileged
`switch-agent` account, installs the launcher and systemd unit, checks the
preinstalled artifacts and enables the unit. It does not install mutable
latest-version packages. The image pipeline must pin and verify every artifact before running it. The
checked-in `runtime.json` shows the generated schema; its zero digests are
examples and are never installed.

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
changes fail closed.

The systemd unit uses `Restart=always`, so an unexpected clean runtime exit is
repaired; explicit unit stops and instance shutdown do not restart it.

Automatic instance replacement and volume relocation are intentionally
unsupported in this slice. A future replacement path needs controller-issued
cloud fencing receipts before it can authorize a fresh root. The supported
lifecycle is stop/start or reboot of the same EC2 instance. The worker has no
inbound service; outbound Internet access is supplied by the isolated worker
VPC's NAT path, whose hourly and data-processing charges continue independently
of instance runtime.
