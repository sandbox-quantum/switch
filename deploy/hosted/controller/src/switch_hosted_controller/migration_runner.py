"""`switch-hosted-migration-runner copy`: runs one person's migration copy, from an operator's machine.

The v1 to v2 move's copy step (Core's `switch-hosted-migration`, step `held`): the person's v1 data disk has been
snapshotted, their row is a box, and the box is made and held at 0. This command, from Core's own `record` and
`manifest` output, restores the snapshot as a read-only volume in the box's namespace, runs the copy Job
(`switch-migration-copy`) into the box's `data-agents` claim, saves the Job's counts-only report for
`run --copy-report`, and removes everything it made, reading each removal back.

Nothing is taken from the operator but which cluster (`--context`) and which installation (`--installation-id`):
the machine, the namespace and the snapshot come from Core, and each is checked against the others and against
what the cluster and EC2 say before anything is made:

- Core's step is `held` or `copy_failed`, and the manifest names the record's machine, owner and snapshot;
- the namespace is the owner's box namespace, carrying the machine's `switch.dev/machine-id` annotation;
- the box's StatefulSet is at 0 with no box pod, and its `data-agents` claim is bound;
- the snapshot is this machine's migration copy of the record's v1 data disk, in this installation, complete,
  encrypted and shared with nobody.

While the Job runs the box's namespace differs from a box's in two ways, both undone and read back before this
command returns, whatever happened: the box's own egress rule (`agent-egress`) is set aside, so the namespace's
`default-deny` is all the Job has (no network), and the namespace's Pod Security level is `baseline`, so the
copier may run with the two capabilities reading another user's files needs. A run that stops between the two
leaves both said in its output, and the next run puts them back before anything else.

Kubernetes is reached through `kubectl proxy` on the named context only, over a private Unix socket, so the
operator's own cluster login is used and no credential passes through this program; the requests themselves are
`KubeHttp`'s, which the cluster contract records. EC2 is read only (`DescribeSnapshots`,
`DescribeSnapshotAttribute`). No token, file name or file content is ever printed.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import boto3

from .box_operator import MACHINE_ANNOTATION
from .node_gate_jobs import DIGEST_IMAGE_RE

NAMESPACE_PREFIX = "agents-user-"
KEYED_ID_RE = re.compile(r"k\d+-[0-9a-f]{16,64}")
MACHINE_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SNAPSHOT_ID_RE = re.compile(r"snap-[0-9a-f]{8,17}")
VOLUME_ID_RE = re.compile(r"vol-[0-9a-f]{8,17}")
AGENT_ID_RE = re.compile(r"[A-Za-z0-9-]{1,64}")
CONTEXT_RE = re.compile(r"[A-Za-z0-9._:@/-]{1,200}")
INSTALLATION_RE = re.compile(r"[A-Za-z0-9._-]{1,64}")

# Core's step names (`visibility/hosted_migration.py`) at which the copy may run.
COPY_STEPS = frozenset({"held", "copy_failed"})
RECORD_KEYS = frozenset(
    {
        "machine_id",
        "owner_keyed_id",
        "step",
        "v1_instance_id",
        "v1_data_volume_id",
        "snapshot_id",
        "done_at",
    }
)
# Exactly Core's `CopyReport`.
REPORT_KEYS = (
    "machine_id",
    "workspaces",
    "files",
    "bytes",
    "symlinks_skipped",
    "refused",
    "checksum_mismatches",
    "source_volume_id",
    "seconds",
)

# The snapshot's tags, as `switch-hosted-migration-cloud snapshot` writes them.
TAG_INSTALLATION = "switch:installation-id"
TAG_MACHINE = "switch:machine-id"
TAG_OWNER = "switch:owner-keyed-id"
TAG_SOURCE = "switch:source-volume-id"
TAG_PURPOSE = "switch:purpose"
PURPOSE = "migration-copy"

CSI_DRIVER = "ebs.csi.aws.com"
BOX_STATEFULSET = "box"
BOX_CLAIM = "data-agents"
BOX_EGRESS = "agent-egress"
DEFAULT_DENY = "default-deny"
PSS_ENFORCE = "pod-security.kubernetes.io/enforce"
PSS_RESTRICTED = "restricted"
PSS_DURING_COPY = "baseline"

# The names of everything this command makes: fixed, so a second run finds the first's, and the admission policy
# can allow exactly these.
JOB = "migration-copy"
SNAPSHOT = "migration-copy"
SOURCE_CLAIM = "migration-source"
MANIFEST_CONFIGMAP = "migration-manifest"
JOB_LABEL = {"app.kubernetes.io/name": "switch-migration-copy"}
# Where the copier finds things inside its pod.
SOURCE_MOUNT = "/source"
TARGET_MOUNT = "/target"
MANIFEST_MOUNT = "/etc/switch-migration"

JOB_DEADLINE_S = 4 * 3600  # the job's own limit; a 200 GB disk well inside it
WAIT_POLL_S = 5.0
SNAPSHOT_READY_S = 15 * 60
GONE_WAIT_S = 5 * 60


class Refused(Exception):
    """The copy can't run, or can't be trusted: `code` names why, for the operator and the runbook."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ── inputs ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Record:
    """Core's `switch-hosted-migration record` output: only what the copy needs of it."""

    machine_id: str
    owner_keyed_id: str
    step: str
    v1_data_volume_id: str
    snapshot_id: str


def load_record(text: str) -> Record:
    try:
        raw = json.loads(text)
    except ValueError:
        raise Refused("bad_record", "The record isn't JSON.") from None
    if not isinstance(raw, dict) or set(raw) != RECORD_KEYS:
        raise Refused("bad_record", "The record isn't Core's `record` output.")

    def need(key: str, pattern: re.Pattern[str]) -> str:
        value = raw.get(key)
        if not isinstance(value, str) or not pattern.fullmatch(value):
            raise Refused("bad_record", f"The record's {key} isn't valid.")
        return value

    step = raw.get("step")
    if step not in COPY_STEPS:
        raise Refused("not_held", "The move isn't at the copy step (held or copy_failed).")
    return Record(
        machine_id=need("machine_id", MACHINE_ID_RE),
        owner_keyed_id=need("owner_keyed_id", KEYED_ID_RE),
        step=step,
        v1_data_volume_id=need("v1_data_volume_id", VOLUME_ID_RE),
        snapshot_id=need("snapshot_id", SNAPSHOT_ID_RE),
    )


@dataclass(frozen=True)
class Manifest:
    """Core's `switch-hosted-migration manifest` output: what this command checks, and the text the Job is given
    exactly as Core wrote it."""

    machine_id: str
    person: str
    namespace: str
    snapshot_id: str
    workspaces: tuple[str, ...]
    text: str


def load_manifest(text: str) -> Manifest:
    try:
        raw = json.loads(text)
    except ValueError:
        raise Refused("bad_manifest", "The manifest isn't JSON.") from None
    if not isinstance(raw, dict):
        raise Refused("bad_manifest", "The manifest isn't an object.")
    machine_id, person, namespace, snapshot_id = (
        raw.get("machine_id"),
        raw.get("person"),
        raw.get("namespace"),
        raw.get("snapshot_id"),
    )
    if not (isinstance(machine_id, str) and MACHINE_ID_RE.fullmatch(machine_id)):
        raise Refused("bad_manifest", "The manifest's machine_id isn't valid.")
    if not (isinstance(person, str) and KEYED_ID_RE.fullmatch(person)):
        raise Refused("bad_manifest", "The manifest's person isn't a keyed id.")
    if namespace != f"{NAMESPACE_PREFIX}{person}":
        raise Refused("bad_manifest", "The manifest's namespace isn't its person's box namespace.")
    if not (isinstance(snapshot_id, str) and SNAPSHOT_ID_RE.fullmatch(snapshot_id)):
        raise Refused("bad_manifest", "The manifest names no valid snapshot.")
    workspaces = raw.get("workspaces")
    if not isinstance(workspaces, list) or not workspaces:
        raise Refused("bad_manifest", "The manifest names no workspace.")
    tenants: list[str] = []
    for entry in workspaces:
        tenant = entry.get("tenant_id") if isinstance(entry, dict) else None
        if not isinstance(tenant, str) or not tenant or tenant in tenants:
            raise Refused("bad_manifest", "The manifest's workspaces aren't valid.")
        tenants.append(tenant)
    return Manifest(
        machine_id=machine_id,
        person=person,
        namespace=namespace,
        snapshot_id=snapshot_id,
        workspaces=tuple(tenants),
        text=text,
    )


def check_inputs(record: Record, manifest: Manifest) -> None:
    """The record and the manifest describe the same move."""
    if manifest.machine_id != record.machine_id:
        raise Refused("target_mismatch", "The manifest is for another machine.")
    if manifest.person != record.owner_keyed_id:
        raise Refused("target_mismatch", "The manifest is for another person.")
    if manifest.snapshot_id != record.snapshot_id:
        raise Refused(
            "snapshot_mismatch", "The manifest names another snapshot than Core recorded."
        )


# ── EC2: the snapshot ────────────────────────────────────────────────────


class Ec2(Protocol):
    def describe_snapshots(self, **kwargs: Any) -> dict: ...
    def describe_snapshot_attribute(self, **kwargs: Any) -> dict: ...


def check_snapshot(ec2: Ec2, record: Record, installation_id: str) -> int:
    """The snapshot is this machine's migration copy of the record's v1 disk, in this installation: complete,
    encrypted, and shared with nobody. Every tag must be there, not merely not wrong. Returns its size in GiB."""
    found = ec2.describe_snapshots(SnapshotIds=[record.snapshot_id], OwnerIds=["self"]).get(
        "Snapshots"
    )
    if not isinstance(found, list) or len(found) != 1:
        raise Refused("snapshot_missing", "The recorded snapshot wasn't found in this account.")
    snap = found[0]
    if snap.get("SnapshotId") != record.snapshot_id:
        raise Refused("snapshot_missing", "EC2 answered for another snapshot.")
    if snap.get("State") != "completed":
        raise Refused("snapshot_not_ready", "The snapshot isn't complete yet.")
    if snap.get("Encrypted") is not True:
        raise Refused("snapshot_unencrypted", "The snapshot isn't encrypted.")
    if snap.get("VolumeId") != record.v1_data_volume_id:
        raise Refused("snapshot_mismatch", "The snapshot isn't of the recorded v1 data disk.")
    tags = {t.get("Key"): t.get("Value") for t in snap.get("Tags") or [] if isinstance(t, dict)}
    wanted = {
        TAG_INSTALLATION: installation_id,
        TAG_MACHINE: record.machine_id,
        TAG_OWNER: record.owner_keyed_id,
        TAG_SOURCE: record.v1_data_volume_id,
        TAG_PURPOSE: PURPOSE,
    }
    for key, value in wanted.items():
        if key not in tags:
            raise Refused("snapshot_untagged", f"The snapshot has no {key} tag.")
        if tags[key] != value:
            raise Refused("snapshot_mismatch", f"The snapshot's {key} tag doesn't match.")
    shared = ec2.describe_snapshot_attribute(
        SnapshotId=record.snapshot_id, Attribute="createVolumePermission"
    ).get("CreateVolumePermissions")
    if shared:
        raise Refused("snapshot_shared", "The snapshot is shared; it is never restored.")
    size = snap.get("VolumeSize")
    if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        raise Refused("snapshot_missing", "The snapshot's size isn't known.")
    return size


# ── Kubernetes ───────────────────────────────────────────────────────────


class Kube(Protocol):
    def get(self, kind: str, name: str, namespace: str | None) -> dict | None: ...
    def list(self, kind: str, namespace: str, selector: str) -> list[dict]: ...
    def create(self, obj: dict) -> None: ...
    def delete(self, kind: str, name: str, namespace: str | None) -> None: ...
    def label(self, kind: str, name: str, key: str, value: str) -> None: ...


# Where each kind the runner touches lives in the API: (group/version prefix, plural, namespaced).
_RESOURCES: dict[str, tuple[str, str, bool]] = {
    "namespace": ("/api/v1", "namespaces", False),
    "pod": ("/api/v1", "pods", True),
    "configmap": ("/api/v1", "configmaps", True),
    "persistentvolumeclaim": ("/api/v1", "persistentvolumeclaims", True),
    "persistentvolume": ("/api/v1", "persistentvolumes", False),
    "statefulset": ("/apis/apps/v1", "statefulsets", True),
    "job": ("/apis/batch/v1", "jobs", True),
    "networkpolicy": ("/apis/networking.k8s.io/v1", "networkpolicies", True),
    "storageclass": ("/apis/storage.k8s.io/v1", "storageclasses", False),
    "volumesnapshot": ("/apis/snapshot.storage.k8s.io/v1", "volumesnapshots", True),
    "volumesnapshotcontent": ("/apis/snapshot.storage.k8s.io/v1", "volumesnapshotcontents", False),
}
NAME_RE = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?")
# The runner's field manager, so the API server's records name it.
FIELD_MANAGER = "switch-migration-runner"
# No comma anywhere: kubectl splits the list on commas. Names are checked in full by `resource_path` anyway.
_SEG = r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?"
# What `kubectl proxy` will forward: exactly the paths `resource_path` builds from `_RESOURCES`, and nothing else
# (no secrets, no exec, attach or port-forward, no other group). kubectl's own default `--reject-paths` stays on.
PROXY_ACCEPT_PATHS = (
    ",".join(
        "^"
        + re.escape(prefix)
        + (f"/namespaces/{_SEG}" if namespaced else "")
        + f"/{plural}(/{_SEG})?$"
        for prefix, plural, namespaced in _RESOURCES.values()
        if plural != "namespaces"
    )
    + f",^/api/v1/namespaces/{_SEG}$"
)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def resource_path(kind: str, namespace: str | None, name: str | None = None) -> str:
    """The API path for a kind, built only from the fixed table and checked names."""
    prefix, plural, namespaced = _RESOURCES[kind]
    if namespaced != bool(namespace):
        raise ValueError(f"{kind} is {'namespaced' if namespaced else 'cluster-wide'}")
    for part in (namespace, name):
        if part is not None and not NAME_RE.fullmatch(part):
            raise Refused("bad_name", "A Kubernetes name isn't valid.")
    path = f"{prefix}/namespaces/{namespace}/{plural}" if namespace else f"{prefix}/{plural}"
    return f"{path}/{name}" if name else path


def _matches(labels: Mapping[str, str], selector: str) -> bool:
    for term in selector.split(","):
        key, _, value = term.partition("=")
        if labels.get(key) != value:
            return False
    return True


class KubeHttp:
    """`Kube` over the Kubernetes API, as every other client in this package speaks it: `_call` is the one way out,
    so the cluster contract records exactly what the runner sends.

    Each call is a plain request: create is a POST of the object, delete a DELETE (background propagation), the
    label a JSON merge patch of that one label. Nothing is ever replaced whole, and no object is updated except by
    that patch.
    """

    def __init__(self, call: Callable[..., Any]):
        self._send = call

    def _call(
        self, method: str, path: str, body: Any = None, content_type: str | None = None
    ) -> Any:
        try:
            return self._send(method, path, body, content_type)
        except ApiError as error:
            if error.status == 404:
                raise
            what = path.split("?")[0]
            raise Refused(
                "api_refused", f"{method} {what} was refused ({error.status}): {error}"
            ) from None

    def get(self, kind: str, name: str, namespace: str | None) -> dict | None:
        try:
            return self._call("GET", resource_path(kind, namespace, name))
        except ApiError as error:
            if error.status == 404:
                return None
            raise

    def list(self, kind: str, namespace: str, selector: str) -> list[dict]:
        found = self._call(
            "GET", f"{resource_path(kind, namespace)}?labelSelector={quote(selector)}"
        )
        items = (found or {}).get("items") or []
        # The server filters; so does this, so an answer it didn't filter can't name another pod.
        return [
            i for i in items if _matches((i.get("metadata") or {}).get("labels") or {}, selector)
        ]

    def create(self, obj: dict) -> None:
        kind = str(obj.get("kind", "")).lower()
        namespace = (obj.get("metadata") or {}).get("namespace")
        self._call("POST", f"{resource_path(kind, namespace)}?fieldManager={FIELD_MANAGER}", obj)

    def delete(self, kind: str, name: str, namespace: str | None) -> None:
        try:
            self._call(
                "DELETE",
                resource_path(kind, namespace, name),
                {"kind": "DeleteOptions", "apiVersion": "v1", "propagationPolicy": "Background"},
            )
        except ApiError as error:
            if error.status != 404:
                raise

    def label(self, kind: str, name: str, key: str, value: str) -> None:
        self._call(
            "PATCH",
            f"{resource_path(kind, None, name)}?fieldManager={FIELD_MANAGER}",
            {"metadata": {"labels": {key: value}}},
            "application/merge-patch+json",
        )


class KubectlProxy:
    """The operator's way in: `kubectl proxy` on the named context, on a private Unix socket in a fresh 0700
    folder, so the API is reached with the operator's own sign-in (kubectl's credential plugin) and no credential
    passes through this program. The proxy only forwards; the requests are `KubeHttp`'s."""

    def __init__(self, context: str):
        if not CONTEXT_RE.fullmatch(context):
            raise Refused("bad_context", "The cluster context isn't a plain name.")
        self._folder = Path(tempfile.mkdtemp(prefix="switch-migration-"))
        self._socket = self._folder / "kube.sock"
        self._process = subprocess.Popen(
            [
                "kubectl",
                "--context",
                context,
                "proxy",
                f"--unix-socket={self._socket}",
                f"--accept-paths={PROXY_ACCEPT_PATHS}",
                "--reject-methods=PUT",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 30
        while not self._socket.exists():
            if self._process.poll() is not None or time.monotonic() > deadline:
                self.close()
                raise Refused("kubectl_failed", "kubectl proxy didn't start for that context.")
            time.sleep(0.1)

    def call(
        self, method: str, path: str, body: Any = None, content_type: str | None = None
    ) -> Any:
        connection = _UnixConnection(str(self._socket))
        try:
            payload = json.dumps(body).encode() if body is not None else None
            headers = {"Accept": "application/json"}
            if payload is not None:
                headers["Content-Type"] = content_type or "application/json"
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        if response.status >= 400:
            # The API's own reason, cut short: it names objects and rules, never a credential.
            try:
                reason = str(json.loads(raw).get("message", ""))[:300]
            except ValueError:
                reason = ""
            raise ApiError(response.status, reason or f"HTTP {response.status}")
        return json.loads(raw) if raw else None

    def close(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
        shutil.rmtree(self._folder, ignore_errors=True)


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost", timeout=120)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(120)
        sock.connect(self._path)
        self.sock = sock


@dataclass(frozen=True)
class Box:
    """What the copy needs of the held box: the zone its disks are in, and its storage class."""

    zone: str
    storage_class: str


def check_box(kube: Kube, manifest: Manifest) -> Box:
    """The namespace is this machine's box, held at 0 with no box pod, and its `data-agents` claim is bound in a
    known zone."""
    ns = kube.get("namespace", manifest.namespace, None)
    if ns is None:
        raise Refused("box_missing", "The box namespace doesn't exist.")
    if (ns.get("metadata", {}).get("annotations") or {}).get(
        MACHINE_ANNOTATION
    ) != manifest.machine_id:
        raise Refused("target_mismatch", "The namespace belongs to another machine.")
    sts = kube.get("statefulset", BOX_STATEFULSET, manifest.namespace)
    if sts is None:
        raise Refused("box_missing", "The box has no StatefulSet.")
    if (
        sts.get("spec", {}).get("replicas") != 0
        or (sts.get("status") or {}).get("replicas", 0) != 0
    ):
        raise Refused("not_held", "The box isn't held at 0.")
    if kube.list("pod", manifest.namespace, "app=switch-box"):
        raise Refused("not_held", "A box pod still exists.")
    claim = kube.get("persistentvolumeclaim", BOX_CLAIM, manifest.namespace)
    if claim is None or (claim.get("status") or {}).get("phase") != "Bound":
        raise Refused("box_missing", "The box's data-agents claim isn't bound.")
    storage_class = claim.get("spec", {}).get("storageClassName")
    volume = claim.get("spec", {}).get("volumeName")
    pv = kube.get("persistentvolume", volume, None) if isinstance(volume, str) and volume else None
    zone = _zone_of(pv)
    if not isinstance(storage_class, str) or not storage_class or zone is None:
        raise Refused("box_missing", "The box disk's zone or storage class isn't known.")
    # The restored copy is made in the box disks' own class, so it's encrypted with the cluster's key like them,
    # never left on the key the v1 snapshot carries.
    params = (kube.get("storageclass", storage_class, None) or {}).get("parameters") or {}
    if params.get("encrypted") != "true" or not params.get("kmsKeyId"):
        raise Refused(
            "box_missing", "The box disks' storage class doesn't name its encryption key."
        )
    return Box(zone=zone, storage_class=storage_class)


def _zone_of(pv: dict | None) -> str | None:
    """The zone a PV is pinned to, from its node affinity (the EBS CSI driver writes it)."""
    if pv is None:
        return None
    terms = (
        pv.get("spec", {}).get("nodeAffinity", {}).get("required", {}).get("nodeSelectorTerms")
        or []
    )
    zones = {
        value
        for term in terms
        for expr in term.get("matchExpressions") or []
        if expr.get("key") in ("topology.kubernetes.io/zone", "topology.ebs.csi.aws.com/zone")
        and expr.get("operator") == "In"
        for value in expr.get("values") or []
    }
    return zones.pop() if len(zones) == 1 else None


# ── what the copy makes ──────────────────────────────────────────────────


def content_name(machine_id: str) -> str:
    """The cluster-wide name of the snapshot's import: one per machine."""
    return f"migration-copy-{machine_id}"


def snapshot_objects(manifest: Manifest, size_gib: int, storage_class: str) -> list[dict]:
    """The snapshot import, read-only claim and the manifest, in the order they must exist.

    `deletionPolicy: Retain`: deleting the import never deletes the snapshot, which stays until the rollback window
    is over (`switch-hosted-migration-cloud clean-up`). The claim waits for its first consumer, so its volume is made
    in the zone the Job lands in, which is the box disk's.
    """
    ns = manifest.namespace
    labels = {**JOB_LABEL, "switch.dev/machine-id": manifest.machine_id}
    return [
        {
            "apiVersion": "snapshot.storage.k8s.io/v1",
            "kind": "VolumeSnapshotContent",
            "metadata": {"name": content_name(manifest.machine_id), "labels": labels},
            "spec": {
                "deletionPolicy": "Retain",
                "driver": CSI_DRIVER,
                "source": {"snapshotHandle": manifest.snapshot_id},
                "volumeSnapshotRef": {"name": SNAPSHOT, "namespace": ns},
            },
        },
        {
            "apiVersion": "snapshot.storage.k8s.io/v1",
            "kind": "VolumeSnapshot",
            "metadata": {"name": SNAPSHOT, "namespace": ns, "labels": labels},
            "spec": {"source": {"volumeSnapshotContentName": content_name(manifest.machine_id)}},
        },
        {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": MANIFEST_CONFIGMAP, "namespace": ns, "labels": labels},
            "data": {"manifest.json": manifest.text},
        },
        {
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": {"name": SOURCE_CLAIM, "namespace": ns, "labels": labels},
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "storageClassName": storage_class,
                "resources": {"requests": {"storage": f"{size_gib}Gi"}},
                "dataSource": {
                    "apiGroup": "snapshot.storage.k8s.io",
                    "kind": "VolumeSnapshot",
                    "name": SNAPSHOT,
                },
            },
        },
    ]


STREAM_MOUNT = "/shared"
_HARDENED = {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True}
_COPIER_RESOURCES = {
    "requests": {"cpu": "250m", "memory": "256Mi", "ephemeral-storage": "64Mi"},
    "limits": {"cpu": "1", "memory": "512Mi", "ephemeral-storage": "64Mi"},
}


def copy_job(manifest: Manifest, box: Box, image: str, step: str) -> dict:
    """The copy Job: one pod of two containers joined by a pipe, no retry, gVisor, no service account token, no
    network (the namespace's `default-deny` only, while `agent-egress` is set aside), on the box nodes in the box
    disk's zone.

    - `read`: root, every capability dropped but `DAC_OVERRIDE`, which reading the v1 seats' other users' files
      needs. Its only mounts are the read-only source, the manifest and the pipe's memory-backed folder, so the
      write half of that capability has nothing writable to act on.
    - `write`: the box's agents user (2000), no capabilities, and the box's `data-agents` claim, the one thing
      written. It owns what it writes, and trusts nothing that comes down the pipe. Its termination message is
      the report; `read`'s is the operator's note (agents skipped), never a file name.

    Both: read-only root, no privilege escalation, seccomp `RuntimeDefault`, fixed limits. The admission policy
    allows exactly this shape in a box namespace while its box is held.
    """
    if not DIGEST_IMAGE_RE.fullmatch(image):
        raise Refused("bad_image", "The copier image must be pinned by sha256 digest.")
    manifest_file = f"{MANIFEST_MOUNT}/manifest.json"
    pipe = f"{STREAM_MOUNT}/stream"
    reader = {
        "name": "read",
        "image": image,
        "command": ["switch-migration-copy", "read"],
        "args": ["--manifest", manifest_file, "--source", SOURCE_MOUNT, "--stream", pipe],
        "securityContext": {
            **_HARDENED,
            "runAsUser": 0,
            "runAsGroup": 0,
            "runAsNonRoot": False,
            "capabilities": {"drop": ["ALL"], "add": ["DAC_OVERRIDE"]},
        },
        "resources": _COPIER_RESOURCES,
        "terminationMessagePolicy": "File",
        "volumeMounts": [
            {"name": "source", "mountPath": SOURCE_MOUNT, "readOnly": True},
            {"name": "manifest", "mountPath": MANIFEST_MOUNT, "readOnly": True},
            {"name": "stream", "mountPath": STREAM_MOUNT},
        ],
    }
    writer = {
        "name": "write",
        "image": image,
        "command": ["switch-migration-copy", "write"],
        "args": [
            "--manifest",
            manifest_file,
            "--target",
            TARGET_MOUNT,
            "--stream",
            pipe,
            "--step",
            step,
        ],
        "env": [
            {
                "name": "POD_NAMESPACE",
                "valueFrom": {"fieldRef": {"fieldPath": "metadata.namespace"}},
            }
        ],
        "securityContext": {
            **_HARDENED,
            "runAsUser": 2000,
            "runAsGroup": 2000,
            "runAsNonRoot": True,
            "capabilities": {"drop": ["ALL"]},
        },
        "resources": _COPIER_RESOURCES,
        "terminationMessagePolicy": "File",
        "volumeMounts": [
            {"name": "target", "mountPath": TARGET_MOUNT},
            {"name": "manifest", "mountPath": MANIFEST_MOUNT, "readOnly": True},
            {"name": "stream", "mountPath": STREAM_MOUNT},
        ],
    }
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": JOB,
            "namespace": manifest.namespace,
            "labels": {**JOB_LABEL, "switch.dev/machine-id": manifest.machine_id},
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": JOB_DEADLINE_S,
            "template": {
                "metadata": {"labels": dict(JOB_LABEL)},
                "spec": {
                    "restartPolicy": "Never",
                    "runtimeClassName": "gvisor",
                    "serviceAccountName": "box",
                    "automountServiceAccountToken": False,
                    "enableServiceLinks": False,
                    "nodeSelector": {
                        "switch.dev/pool": "agents",
                        "topology.kubernetes.io/zone": box.zone,
                    },
                    "securityContext": {"seccompProfile": {"type": "RuntimeDefault"}},
                    "containers": [reader, writer],
                    "volumes": [
                        {
                            "name": "source",
                            "persistentVolumeClaim": {"claimName": SOURCE_CLAIM, "readOnly": True},
                        },
                        {"name": "target", "persistentVolumeClaim": {"claimName": BOX_CLAIM}},
                        {"name": "manifest", "configMap": {"name": MANIFEST_CONFIGMAP}},
                        {"name": "stream", "emptyDir": {"medium": "Memory", "sizeLimit": "1Mi"}},
                    ],
                },
            },
        },
    }


# ── the run ──────────────────────────────────────────────────────────────


class Clock(Protocol):
    def now(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...


class RealClock:
    def now(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def _wait(clock: Clock, limit_s: float, what: str, ready: Callable[[], bool]) -> None:
    deadline = clock.now() + limit_s
    while not ready():
        if clock.now() >= deadline:
            raise Refused("timed_out", f"Gave up waiting for {what}.")
        clock.sleep(WAIT_POLL_S)


def _strip(obj: dict) -> dict:
    """An object as it can be created again: what the server added taken off."""
    kept = {k: v for k, v in obj.items() if k not in ("status",)}
    meta = dict(kept.get("metadata") or {})
    for key in ("uid", "resourceVersion", "creationTimestamp", "generation", "managedFields"):
        meta.pop(key, None)
    annotations = dict(meta.get("annotations") or {})
    annotations.pop("kubectl.kubernetes.io/last-applied-configuration", None)
    if annotations:
        meta["annotations"] = annotations
    else:
        meta.pop("annotations", None)
    kept["metadata"] = meta
    return kept


class CopyRunner:
    def __init__(self, kube: Kube, ec2: Ec2, clock: Clock, say: Callable[[str], None]):
        self.egress_sha256: str | None = None
        self._kube = kube
        self._ec2 = ec2
        self._clock = clock
        self._say = say

    def run(
        self,
        record: Record,
        manifest: Manifest,
        *,
        installation_id: str,
        image: str,
        saved_egress: Path,
    ) -> dict:
        """The whole copy step. Returns the report to save for `run --copy-report`; raises `Refused` with the
        namespace put back as a box's either way."""
        check_inputs(record, manifest)
        size = check_snapshot(self._ec2, record, installation_id)
        ns = manifest.namespace
        # A run that stopped part-way left the namespace changed: put it back before anything is checked.
        self.restore(manifest, saved_egress)
        box = check_box(self._kube, manifest)
        egress = self._kube.get("networkpolicy", BOX_EGRESS, ns)
        if egress is None:
            raise Refused("box_missing", "The box has no egress rule to set aside and put back.")
        if self._kube.get("networkpolicy", DEFAULT_DENY, ns) is None:
            raise Refused(
                "box_missing", "The box has no default-deny rule: the copy would have network."
            )
        self.egress_sha256 = egress_sha256(egress)
        self._clear_own(manifest)
        try:
            # The label first: `baseline` is what the cluster's admission policy reads as "a copy is on" (the
            # egress rule may be set aside, a copy pod may run, the box may not be scaled up). Undone the other way
            # round in `restore`.
            self._kube.label("namespace", ns, PSS_ENFORCE, PSS_DURING_COPY)
            saved_egress.write_text(json.dumps(_strip(egress)))
            self._kube.delete("networkpolicy", BOX_EGRESS, ns)
            self._gone("networkpolicy", BOX_EGRESS, ns)
            self._say(
                "The box's egress is set aside and its namespace is at baseline for the copy."
            )
            for obj in snapshot_objects(manifest, size, box.storage_class):
                self._kube.create(obj)
            _wait(self._clock, SNAPSHOT_READY_S, "the snapshot import", self._snapshot_ready(ns))
            self._kube.create(copy_job(manifest, box, image, record.step))
            self._say("The copy Job is running.")
            pod = self._finished_pod(ns)
            volume = self._source_volume(ns, record)
            return self._report(pod, manifest, volume)
        finally:
            try:
                self._clear_own(manifest)
            finally:
                self.restore(manifest, saved_egress)

    def restore(self, manifest: Manifest, saved_egress: Path) -> None:
        """Puts the namespace back as a box's: its egress rule exactly as it was, and `restricted`, each read back.
        Nothing to do when it already is."""
        ns = manifest.namespace
        if saved_egress.exists():
            wanted = json.loads(saved_egress.read_text())
            if wanted.get("metadata", {}).get("namespace") != ns:
                raise Refused("bad_saved_egress", "The saved egress rule is for another namespace.")
            existing = self._kube.get("networkpolicy", BOX_EGRESS, ns)
            if existing is None:
                self._kube.create(wanted)
                existing = self._kube.get("networkpolicy", BOX_EGRESS, ns)
            if existing is None or existing.get("spec") != wanted.get("spec"):
                raise Refused(
                    "restore_failed",
                    "The box's egress rule isn't back as it was; fix it before anything else.",
                )
            saved_egress.unlink()
            self._say("The box's egress rule is back as it was.")
        nsobj = self._kube.get("namespace", ns, None)
        if nsobj is None:
            return
        if (nsobj.get("metadata", {}).get("labels") or {}).get(PSS_ENFORCE) != PSS_RESTRICTED:
            self._kube.label("namespace", ns, PSS_ENFORCE, PSS_RESTRICTED)
            back = self._kube.get("namespace", ns, None) or {}
            if (back.get("metadata", {}).get("labels") or {}).get(PSS_ENFORCE) != PSS_RESTRICTED:
                raise Refused(
                    "restore_failed",
                    "The namespace isn't back at restricted; fix it before anything else.",
                )
            self._say("The namespace is back at restricted.")

    def _clear_own(self, manifest: Manifest) -> None:
        """Deletes everything this command makes, and reads each back as gone: the Job and its pod, the read-only
        claim (and so the restored volume), the snapshot import (the snapshot itself is kept) and the manifest."""
        ns = manifest.namespace
        own = [
            ("job", JOB, ns),
            ("pod", None, ns),
            ("persistentvolumeclaim", SOURCE_CLAIM, ns),
            ("volumesnapshot", SNAPSHOT, ns),
            ("volumesnapshotcontent", content_name(manifest.machine_id), None),
            ("configmap", MANIFEST_CONFIGMAP, ns),
        ]
        for kind, name, where in own:
            if name is None:
                for pod in self._kube.list("pod", ns, _selector(JOB_LABEL)):
                    self._kube.delete("pod", pod["metadata"]["name"], ns)
                continue
            self._kube.delete(kind, name, where)
        for kind, name, where in own:
            if name is None:
                _wait(
                    self._clock,
                    GONE_WAIT_S,
                    "the copy pod to go",
                    lambda: not self._kube.list("pod", ns, _selector(JOB_LABEL)),
                )
                continue
            self._gone(kind, name, where)

    def _gone(self, kind: str, name: str, namespace: str | None) -> None:
        _wait(
            self._clock,
            GONE_WAIT_S,
            f"{kind} {name} to go",
            lambda: self._kube.get(kind, name, namespace) is None,
        )

    def _snapshot_ready(self, ns: str) -> Callable[[], bool]:
        def ready() -> bool:
            snap = self._kube.get("volumesnapshot", SNAPSHOT, ns) or {}
            status = snap.get("status") or {}
            if status.get("error"):
                raise Refused("snapshot_import_failed", "The snapshot import failed.")
            return status.get("readyToUse") is True

        return ready

    def _finished_pod(self, ns: str) -> dict:
        """The Job's one pod, once it has ended, succeeded or not: its termination message is the report."""
        ended: list[dict] = []

        def done() -> bool:
            job = self._kube.get("job", JOB, ns) or {}
            status = job.get("status") or {}
            if not (status.get("succeeded") or status.get("failed")):
                return False
            pods = self._kube.list("pod", ns, _selector(JOB_LABEL))
            if len(pods) != 1:
                raise Refused("copy_failed", "The copy Job didn't leave exactly one pod.")
            ended.append(pods[0])
            return True

        _wait(self._clock, JOB_DEADLINE_S + 600, "the copy Job", done)
        return ended[0]

    def _source_volume(self, ns: str, record: Record) -> str:
        """The restored volume's id, from the bound PV, never from the Job: a `vol-…`, and never the v1 disk."""
        claim = self._kube.get("persistentvolumeclaim", SOURCE_CLAIM, ns) or {}
        volume = claim.get("spec", {}).get("volumeName")
        pv = (
            self._kube.get("persistentvolume", volume, None)
            if isinstance(volume, str) and volume
            else None
        )
        handle = ((pv or {}).get("spec", {}).get("csi") or {}).get("volumeHandle")
        if not isinstance(handle, str) or not VOLUME_ID_RE.fullmatch(handle):
            raise Refused("copy_failed", "The restored volume's id isn't known.")
        if handle == record.v1_data_volume_id:
            raise Refused("copy_failed", "The copy read the v1 disk itself, not a restored copy.")
        return handle

    def _report(self, pod: dict, manifest: Manifest, volume: str) -> dict:
        """The writer's report, checked, with the restored volume's id filled in from Kubernetes; the reader's note
        (the agents it skipped, by id) said to the operator. Either side failing fails the copy, by its code only."""
        ended: dict[str, dict] = {}
        for status in (pod.get("status") or {}).get("containerStatuses") or []:
            terminated = (status.get("state") or {}).get("terminated")
            if status.get("name") in ("read", "write") and isinstance(terminated, dict):
                ended[status["name"]] = terminated
        if set(ended) != {"read", "write"}:
            raise Refused("copy_failed", "The copy pod's two sides didn't both end.")
        read, write = (_message(ended[side]) for side in ("read", "write"))
        for side, raw in (("write", write), ("read", read)):
            if ended[side].get("exitCode") != 0:
                code = raw.get("refused") if isinstance(raw, dict) else None
                reason = (
                    code
                    if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code)
                    else "unknown"
                )
                raise Refused("copy_failed", f"The copy failed on its {side} side ({reason}).")
        skipped = read.get("skipped_agents") if isinstance(read, dict) else None
        total = read.get("skipped_total") if isinstance(read, dict) else None
        if (
            not isinstance(read, dict)
            or set(read) != {"read", "skipped_agents", "skipped_total"}
            or read["read"] != "done"
            or not isinstance(skipped, list)
            or not all(isinstance(a, str) and AGENT_ID_RE.fullmatch(a) for a in skipped)
            or isinstance(total, bool)
            or not isinstance(total, int)
            or total < len(skipped)
        ):
            raise Refused("bad_report", "The copy's reader note isn't the expected shape.")
        if not isinstance(write, dict) or set(write) != set(REPORT_KEYS):
            raise Refused("bad_report", "The copy's report isn't the expected shape.")
        if write["machine_id"] != manifest.machine_id:
            raise Refused("target_mismatch", "The copy reported for another machine.")
        if write["source_volume_id"] not in (None, volume):
            raise Refused("bad_report", "The copy reported another source volume.")
        if not isinstance(write["workspaces"], list) or sorted(write["workspaces"]) != sorted(
            manifest.workspaces
        ):
            raise Refused("target_mismatch", "The copy's workspaces aren't the manifest's.")
        if total:
            more = f" (and {total - len(skipped)} more)" if total > len(skipped) else ""
            self._say(
                f"{total} agent(s) had no slot on the v1 disk, so nothing was copied for them: "
                + ", ".join(skipped)
                + more
            )
        report = {key: write[key] for key in REPORT_KEYS}
        report["source_volume_id"] = volume
        return report


def _message(terminated: dict) -> Any:
    message = terminated.get("message")
    try:
        return json.loads(message) if isinstance(message, str) else None
    except ValueError:
        return None


def egress_sha256(policy: dict) -> str:
    """The box egress rule's fingerprint: its spec, canonically. The copy prints it; `verify` compares it."""
    canonical = json.dumps(policy.get("spec"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


# The Pod Security labels a box namespace carries (`box_operator.namespace_object`): both must be `restricted`.
# `audit` isn't set on a box; if anything sets it, it must be `restricted` too.
PSS_LABELS = (PSS_ENFORCE, "pod-security.kubernetes.io/warn")
PSS_AUDIT = "pod-security.kubernetes.io/audit"


def verify(kube: Kube, manifest: Manifest, egress_hash: str) -> None:
    """Before `run --copy-report`: the box's namespace is a box's again. All three Pod Security labels are
    `restricted`, `agent-egress` is back with the fingerprint the copy printed, nothing the copy made is left, and
    the box is still held."""
    ns = kube.get("namespace", manifest.namespace, None)
    if (
        ns is None
        or (ns.get("metadata", {}).get("annotations") or {}).get(MACHINE_ANNOTATION)
        != manifest.machine_id
    ):
        raise Refused("target_mismatch", "The namespace isn't this machine's box.")
    labels = ns.get("metadata", {}).get("labels") or {}
    for key in PSS_LABELS:
        if labels.get(key) != PSS_RESTRICTED:
            raise Refused("not_restored", f"The namespace's {key} label isn't restricted.")
    if labels.get(PSS_AUDIT, PSS_RESTRICTED) != PSS_RESTRICTED:
        raise Refused("not_restored", f"The namespace's {PSS_AUDIT} label isn't restricted.")
    egress = kube.get("networkpolicy", BOX_EGRESS, manifest.namespace)
    if egress is None or egress_sha256(egress) != egress_hash:
        raise Refused("not_restored", "The box's egress rule isn't back as it was.")
    left = [
        kind
        for kind, name, where in (
            ("job", JOB, manifest.namespace),
            ("persistentvolumeclaim", SOURCE_CLAIM, manifest.namespace),
            ("volumesnapshot", SNAPSHOT, manifest.namespace),
            ("volumesnapshotcontent", content_name(manifest.machine_id), None),
            ("configmap", MANIFEST_CONFIGMAP, manifest.namespace),
        )
        if kube.get(kind, name, where) is not None
    ]
    if left or kube.list("pod", manifest.namespace, _selector(JOB_LABEL)):
        raise Refused("not_restored", "Something the copy made is still there.")
    sts = kube.get("statefulset", BOX_STATEFULSET, manifest.namespace) or {}
    if sts.get("spec", {}).get("replicas") != 0:
        raise Refused("not_held", "The box isn't held at 0.")


def _selector(labels: Mapping[str, str]) -> str:
    return ",".join(f"{k}={v}" for k, v in labels.items())


# ── the command ──────────────────────────────────────────────────────────


def _read(path: str) -> str:
    return sys.stdin.read() if path == "-" else Path(path).read_text()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="switch-hosted-migration-runner")
    commands = parser.add_subparsers(dest="command", required=True)
    copy = commands.add_parser("copy", help="Run one person's migration copy.")
    copy.add_argument(
        "--record", required=True, help="Core's `record` output, or - for standard input."
    )
    copy.add_argument("--manifest", required=True, help="Core's `manifest` output.")
    copy.add_argument(
        "--report", required=True, help="Where to save the report for `run --copy-report`."
    )
    copy.add_argument("--context", required=True, help="The box cluster's kubectl context.")
    copy.add_argument("--installation-id", required=True)
    copy.add_argument("--image", required=True, help="The copier image, pinned by digest.")
    copy.add_argument("--region", required=True)
    copy.add_argument(
        "--saved-egress",
        default="migration-saved-egress.json",
        help="Where the box's egress rule is kept while it's set aside.",
    )
    check = commands.add_parser(
        "verify", help="Check the box is back as a box's, before `run --copy-report`."
    )
    check.add_argument("--manifest", required=True)
    check.add_argument("--context", required=True)
    check.add_argument("--egress-sha256", required=True, help="As the copy printed it.")
    args = parser.parse_args(argv)
    try:
        if args.command == "verify":
            if not re.fullmatch(r"[0-9a-f]{64}", args.egress_sha256):
                raise Refused("bad_input", "The egress fingerprint isn't a sha256.")
            proxy = KubectlProxy(args.context)
            try:
                verify(
                    KubeHttp(proxy.call), load_manifest(_read(args.manifest)), args.egress_sha256
                )
            finally:
                proxy.close()
            print(
                "The box's namespace is back as a box's: restricted, its egress rule as it was, nothing left."
            )
            return 0
        if not INSTALLATION_RE.fullmatch(args.installation_id):
            raise Refused("bad_installation", "The installation id isn't a plain name.")
        if args.record == "-" and args.manifest == "-":
            raise Refused(
                "bad_input", "Only one of the record and the manifest can come from standard input."
            )
        record = load_record(_read(args.record))
        manifest = load_manifest(_read(args.manifest))
        proxy = KubectlProxy(args.context)
        try:
            runner = CopyRunner(
                KubeHttp(proxy.call),
                boto3.client("ec2", region_name=args.region),
                RealClock(),
                lambda line: print(line, file=sys.stderr),
            )
            report = runner.run(
                record,
                manifest,
                installation_id=args.installation_id,
                image=args.image,
                saved_egress=Path(args.saved_egress),
            )
        finally:
            proxy.close()
    except Refused as refused:
        print(json.dumps({"refused": refused.code, "message": str(refused)}), file=sys.stderr)
        if refused.code in ("copy_failed", "bad_report", "target_mismatch", "timed_out"):
            print(
                "Record it in Core: `switch-hosted-migration run PERSON --operator OPERATOR --copy-failed "
                "--execute`, then run the copy again, or roll the move back.",
                file=sys.stderr,
            )
        return 2
    Path(args.report).write_text(json.dumps(report))
    print(
        f"Copied: {report['files']} files, {report['bytes']} bytes. Report saved for `run --copy-report`."
    )
    print(f"Before `run --copy-report`, run `verify --egress-sha256 {runner.egress_sha256}`.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
