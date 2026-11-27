"""The cluster contract: what this package's services really send to the Kubernetes API, written out as files that a
deployment repository checks against its own admission policies and RBAC, for the switch commit it pins.

    python -m switch_hosted_controller.contract --out <dir>       write the files (replacing the folder's contents)
    python -m switch_hosted_controller.contract --check <dir>     exit 1 if the folder differs from a fresh run

Nothing here is hand-written: each request is made by the services' own Kubernetes clients (`OperatorKubeApi`,
`ReaperKubeApi`, `RemoverKubeApi`, the scaler's `KubeApi`), driven by their own code (`BoxOperator`, `reap_once`,
`remove_once`), with only the HTTP transport replaced by an in-memory API server that records every call. So a
change to what a service sends changes the files, and the drift check in this package's tests fails until they are
written again.

Every value is a placeholder (`fills.json`): example registry, digests of one repeated hex digit, documentation
addresses (RFC 5737), a made-up zone and made-up keyed ids. No real zone, subnet, registry, digest, CA, account id,
hostname, keyed id, egress list or namespace is ever written; `placeholder_problems` refuses the files if one slips
in. The files are public.

What the files hold (`index.json` lists them all, each with its sha256):
- `admission/good/*.json`: one request a service makes, which the deployed policies must admit, replayed exactly as a
  server-side dry run: `as` (the service account to impersonate), `setup` (the objects that exist first, to be made
  as an administrator in order, without `resourceVersion`), `request` (`method`, `path`, `body`) and `expect`.
- `rbac.json`: per service account, every API call its code made (verb, group, resource, subresource, namespace,
  name). The deployed RBAC must grant these.
- `log-lines.json`: the alert lines monitors page on, by service, with the fixed words each monitor keys on.
- `tiers.json`: the box sizes the operator's configuration must offer, as `OperatorConfig.sizes` takes them.
- `fills.json`: one placeholder value for each `__TOKEN__` the deployed manifests use, matching the samples.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import ipaddress
import json
import re
import shutil
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit

from . import (
    box_operator,
    box_scaler,
    cluster_watch,
    drain_actions,
    egress_lists,
    reaper,
    remover,
    restart_actions,
)
from .box_names import REMOVALS_SECRET, box_namespace, user_namespace
from .box_operator_main import OperatorKubeApi
from .reaper import BOX_MAP_SECRET, BOX_OWNERS_SECRET, POOL_MAP_SECRET
from .reaper_main import ReaperKubeApi
from .remover_main import RemoverKubeApi
from .workers_main import InClusterKubeApi

FORMAT = 1
HOME = "switch-hosted"

# ---------------------------------------------------------------- placeholders (public: made up, every one)


def _digest(digit: str) -> str:
    return "sha256:" + digit * 64


IMAGE = {
    "box": "registry.example/hosted-agents-box@" + _digest("a"),
    "box_previous_1": "registry.example/hosted-agents-box@" + _digest("b"),
    "box_previous_2": "registry.example/hosted-agents-box@" + _digest("c"),
    "box_previous_3": "registry.example/hosted-agents-box@" + _digest("d"),
    "controller": "registry.example/switch-hosted-controller@" + _digest("e"),
    "egress_lists": "registry.example/switch-hosted-controller@" + _digest("e"),
    "pause": "registry.example/pause@" + _digest("f"),
}
#: Core's host name and the range its private endpoint's addresses sit in: a documentation name and range.
SERVER_HOST = "switch-core.example.net"
SERVER_CIDRS = ("192.0.2.0/28",)
API_SERVER_IPS = ("192.0.2.11", "192.0.2.12")
AGENTS_SUBNET = "198.51.100.0/24"
CLUSTER_VPC_CIDR = "198.51.100.0/22"
CLUSTER_SERVICE_CIDR = "203.0.113.0/24"
KUBERNETES_SERVICE_IP = "203.0.113.1"
ZONE = "xx-example-1a"
PROXY_HOST = "squid.egress-proxy.svc"
PROXY_PORT = 3128
STORAGE_CLASS = "gp3"
MANAGED_SETTINGS = '{"permissions": {}}'


# Made-up keyed ids and machine ids, one per box: hex digits counting up, never derived from anyone.
def _keyed(n: int) -> str:
    return "k1-" + f"{n:x}" * 16 if n < 16 else "k1-" + f"{n:016x}"


def _machine(n: int) -> str:
    return f"0000000{n:x}-0000-4000-8000-0000000000{n:02x}"


# The box sizes the operator offers new boxes (`switch-v0-p4-box-pod` admits exactly these), and the earlier size an
# existing box may still be held at. A deployment's operator configuration must offer the first three as written.
TIERS: dict[str, dict[str, str]] = {
    "base": {
        "disk": "40Gi",
        "cpu_request": "400m",
        "cpu_limit": "4",
        "memory_request": "11008Mi",
        "memory_limit": "11008Mi",
    },
    "plus": {
        "disk": "80Gi",
        "cpu_request": "900m",
        "cpu_limit": "8",
        "memory_request": "23808Mi",
        "memory_limit": "23808Mi",
    },
    "max": {
        "disk": "160Gi",
        "cpu_request": "1900m",
        "cpu_limit": "16",
        "memory_request": "48384Mi",
        "memory_limit": "48384Mi",
    },
}


def operator_config() -> box_operator.OperatorConfig:
    return box_operator.config_from(
        {
            "server_host": SERVER_HOST,
            "server_cidrs": list(SERVER_CIDRS),
            "server_url": "https://" + SERVER_HOST,
            "image": IMAGE["box"],
            "storage_class": STORAGE_CLASS,
            "proxy_host": PROXY_HOST,
            "proxy_port": PROXY_PORT,
            "zones": [ZONE],
            "sizes": TIERS,
            "ceiling": 20,
            "default_size": "base",
            "split": True,
            "allowed_images": [IMAGE["box_previous_1"], IMAGE["box_previous_2"]],
        },
        _ca_pem(),
        MANAGED_SETTINGS,
    )


def _ca_pem() -> str:
    return (Path(__file__).parent / "contract_ca.pem").read_text()


def fills() -> dict[str, Any]:
    """A placeholder value for each `__TOKEN__` in the deployed manifests, matching the samples."""
    return {
        "__AGENTS_SUBNET__": AGENTS_SUBNET,
        "__API_SERVER_IP_1__": API_SERVER_IPS[0],
        "__API_SERVER_IP_2__": API_SERVER_IPS[1],
        "__BOX_CA_CERT__": _ca_pem(),
        "__BOX_IMAGE__": IMAGE["box"],
        "__CLUSTER_SERVICE_CIDR__": CLUSTER_SERVICE_CIDR,
        "__CLUSTER_VPC_CIDR__": CLUSTER_VPC_CIDR,
        "__CONTROLLER_IMAGE__": IMAGE["controller"],
        "__EGRESS_LISTS_IMAGE__": IMAGE["egress_lists"],
        "__PAUSE_IMAGE__": IMAGE["pause"],
        "__PREVIOUS_BOX_IMAGE_1__": IMAGE["box_previous_1"],
        "__PREVIOUS_BOX_IMAGE_2__": IMAGE["box_previous_2"],
        "__PREVIOUS_BOX_IMAGE_3__": IMAGE["box_previous_3"],
        "__SERVER_HOST__": SERVER_HOST,
        "__SERVER_CIDR__": SERVER_CIDRS[0],
        "__ZONE__": ZONE,
        "kubernetes_service_ip": KUBERNETES_SERVICE_IP,
    }


# ---------------------------------------------------------------- the in-memory API server


ACCOUNT = {
    "provisioner": f"system:serviceaccount:{HOME}:switch-hosted-provisioner",
    "reaper": f"system:serviceaccount:{HOME}:switch-hosted-reaper",
    "remover": f"system:serviceaccount:{HOME}:switch-hosted-remover",
    "controller": f"system:serviceaccount:{HOME}:switch-hosted-controller",
    "drain": f"system:serviceaccount:{HOME}:switch-drain",
    "egress_lists": "system:serviceaccount:egress-lists:egress-lists",
}

_VERB = {"POST": "create", "PUT": "update", "PATCH": "patch", "DELETE": "delete"}
_OPERATION = {"POST": "CREATE", "PUT": "UPDATE", "PATCH": "UPDATE", "DELETE": "DELETE"}
_RESOURCE_KIND = {
    "namespaces": ("", "v1", "Namespace"),
    "secrets": ("", "v1", "Secret"),
    "configmaps": ("", "v1", "ConfigMap"),
    "serviceaccounts": ("", "v1", "ServiceAccount"),
    "resourcequotas": ("", "v1", "ResourceQuota"),
    "persistentvolumeclaims": ("", "v1", "PersistentVolumeClaim"),
    "persistentvolumes": ("", "v1", "PersistentVolume"),
    "pods": ("", "v1", "Pod"),
    "nodes": ("", "v1", "Node"),
    "events": ("", "v1", "Event"),
    "networkpolicies": ("networking.k8s.io", "v1", "NetworkPolicy"),
    "statefulsets": ("apps", "v1", "StatefulSet"),
    "rolebindings": ("rbac.authorization.k8s.io", "v1", "RoleBinding"),
    "deployments": ("apps", "v1", "Deployment"),
}


@dataclass(frozen=True)
class Target:
    group: str
    resource: str
    subresource: str
    namespace: str
    name: str
    version: str = "v1"

    @property
    def item(self) -> str:
        """The object's own path (a subresource's object is its parent)."""
        prefix = "/api/v1" if self.group == "" else f"/apis/{self.group}/{self.version}"
        if self.resource == "namespaces":
            return f"{prefix}/namespaces/{self.name}"
        ns = f"/namespaces/{self.namespace}" if self.namespace else ""
        return f"{prefix}{ns}/{self.resource}/{self.name}"


def parse_path(path: str) -> Target:
    parts = urlsplit(path).path.strip("/").split("/")
    if parts[0] == "api":
        group, version, rest = "", parts[1], parts[2:]
    elif parts[0] == "apis":
        group, version, rest = parts[1], parts[2], parts[3:]
    else:
        raise ValueError(f"not an API path: {path}")
    namespace = ""
    if rest[:1] == ["namespaces"] and len(rest) >= 3:
        namespace, rest = rest[1], rest[2:]
    elif rest[:1] == ["namespaces"]:
        return Target(group, "namespaces", "", "", rest[1] if len(rest) > 1 else "", version)
    resource = rest[0]
    name = rest[1] if len(rest) > 1 else ""
    subresource = rest[2] if len(rest) > 2 else ""
    return Target(group, resource, subresource, namespace, name, version)


def _merge(base: Any, patch: Any) -> Any:
    if not isinstance(patch, dict) or not isinstance(base, dict):
        return copy.deepcopy(patch)
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = _merge(out.get(key), value)
    return out


def _strip(obj: dict) -> dict:
    """An object as a sample states it: no server-set fields."""
    out = copy.deepcopy(obj)
    meta = out.get("metadata", {})
    for key in ("resourceVersion", "uid", "creationTimestamp", "generation"):
        meta.pop(key, None)
    out.pop("status", None)
    return out


@dataclass
class Sample:
    service: str
    request: dict
    setup: list[dict]
    note: str


@dataclass
class Cluster:
    """Objects by path, a resource version counter, and what each account asked for."""

    objects: dict[str, dict] = field(default_factory=dict)
    version: int = 0
    calls: dict[str, set[tuple[str, str, str, str, str, str]]] = field(default_factory=dict)
    samples: list[Sample] = field(default_factory=list)
    account: str = ""
    note: str = ""

    def put(self, path: str, obj: dict) -> None:
        """Made by an administrator, before the services run."""
        self.version += 1
        stored = copy.deepcopy(obj)
        stored.setdefault("metadata", {})["resourceVersion"] = str(self.version)
        self.objects[path] = stored

    def _setup_for(self, target: Target) -> list[dict]:
        """The objects a dry run of this request needs to exist first: the home namespace and its lists (the
        policies' parameters), the target namespace, and everything in it."""
        wanted = []
        for path, obj in self.objects.items():
            t = parse_path(path)
            in_home = t.namespace == HOME or (t.resource == "namespaces" and t.name == HOME)
            in_target = target.namespace and (
                t.namespace == target.namespace
                or (t.resource == "namespaces" and t.name == target.namespace)
            )
            own_ns = (
                target.resource == "namespaces"
                and t.resource == "namespaces"
                and t.name == target.name
            )
            itself = bool(target.name) and path == target.item  # a cluster-scoped object: a node
            if in_home or in_target or own_ns or itself:
                wanted.append({"path": path, "object": _strip(obj)})
        # Namespaces first, so each object's namespace exists before it.
        wanted.sort(key=lambda s: 0 if parse_path(s["path"]).resource == "namespaces" else 1)
        return wanted

    def call(
        self, method: str, path: str, body: Any = None, content_type: str | None = None
    ) -> Any:
        if not self.account:
            # Every call is some service's: one made outside `acting` would be granted to nobody.
            raise RuntimeError(f"a call outside any service's account: {method} {path}")
        target = parse_path(path)
        dry = "dryRun=All" in path
        verb = _VERB.get(method) or ("get" if target.name else "list")
        self.calls.setdefault(self.account, set()).add(
            (verb, target.group, target.resource, target.subresource, target.namespace, target.name)
        )
        item = target.item if target.name else ""
        if method == "GET":
            if target.name:
                found = self.objects.get(item)
                if found is None:
                    raise HTTPError(path, 404, "not found", {}, None)  # type: ignore[arg-type]
                if target.subresource == "scale":
                    replicas = found.get("spec", {}).get("replicas", 0)
                    return {"spec": {"replicas": replicas}, "status": {"replicas": replicas}}
                return copy.deepcopy(found)
            prefix = urlsplit(path).path.rstrip("/") + "/"
            return {
                "items": [copy.deepcopy(o) for p, o in self.objects.items() if p.startswith(prefix)]
            }
        if method == "POST" and target.subresource:
            self._record(method, path, body, target)  # an eviction: acted on, never stored
            return {}
        if method == "POST":
            name = (body or {}).get("metadata", {}).get("name", "")
            if target.resource == "namespaces":
                item = f"/api/v1/namespaces/{name}"
            elif target.resource == "events" and not name:
                name = body["metadata"]["generateName"] + "contract"
                item = Target(
                    target.group, target.resource, "", target.namespace, name, target.version
                ).item
            else:
                item = Target(
                    target.group, target.resource, "", target.namespace, name, target.version
                ).item
            if item in self.objects and not dry:
                raise HTTPError(path, 409, "exists", {}, None)  # type: ignore[arg-type]
            self._record(method, path, body, target)
            if not dry:
                self.put(item, body)
            return copy.deepcopy(body)
        if method in ("PUT", "PATCH"):
            current = self.objects.get(item)
            if current is None:
                raise HTTPError(path, 404, "not found", {}, None)  # type: ignore[arg-type]
            if method == "PUT":
                want = (body or {}).get("metadata", {}).get("resourceVersion")
                if want is not None and want != current["metadata"]["resourceVersion"]:
                    raise HTTPError(path, 409, "conflict", {}, None)  # type: ignore[arg-type]
                new = copy.deepcopy(body)
            elif target.subresource == "scale":
                new = _merge(current, {"spec": {"replicas": body["spec"]["replicas"]}})
            else:
                new = _merge(current, body)
            self._record(method, path, body, target, content_type)
            self.put(item, new)
            return copy.deepcopy(new)
        if method == "DELETE":
            if item not in self.objects:
                raise HTTPError(path, 404, "not found", {}, None)  # type: ignore[arg-type]
            self._record(method, path, body, target)
            del self.objects[item]
            if target.resource == "namespaces":
                for p in [p for p in self.objects if parse_path(p).namespace == target.name]:
                    del self.objects[p]
            return {}
        raise ValueError(method)

    def _record(
        self, method: str, path: str, body: Any, target: Target, content_type: str | None = None
    ) -> None:
        request: dict[str, Any] = {"method": method, "path": path}
        if method == "PATCH":
            # Every client here sends a JSON merge patch (the scaler's `KubeApi`, which the egress lists generator
            # and the cluster report share, and the drain worker's cordon): never a strategic merge.
            request["content_type"] = content_type or "application/merge-patch+json"
        if body is not None:
            request["body"] = _strip(body) if method != "PATCH" else copy.deepcopy(body)
        self.samples.append(Sample(self.account, request, self._setup_for(target), self.note))

    @contextmanager
    def acting(self, account: str, note: str) -> Iterator[None]:
        before = self.account, self.note
        self.account, self.note = account, note
        try:
            yield
        finally:
            self.account, self.note = before


@contextmanager
def _fixed_clock() -> Iterator[None]:
    """One fixed time for what a service stamps, so the files are the same on every run."""
    real = box_scaler.time.gmtime
    box_scaler.time.gmtime = lambda *_a: real(1_798_761_600)  # type: ignore[assignment]
    try:
        yield
    finally:
        box_scaler.time.gmtime = real  # type: ignore[assignment]


def _client(cls: type, cluster: Cluster, *args: Any) -> Any:
    """A service's real Kubernetes client, its transport replaced by the in-memory server."""
    client = cls.__new__(cls)
    client._server = "https://kubernetes.example"
    client._call = lambda method, path, body=None, content_type=None, **_: cluster.call(
        method, path, body, content_type
    )
    for name, value in args:
        setattr(client, name, value)
    return client


# ---------------------------------------------------------------- what each service does


def _list_secret(name: str, entries: dict[str, str]) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": name,
            "namespace": HOME,
            "labels": {"app.kubernetes.io/managed-by": "switch-hosted"},
        },
        "type": "Opaque",
        "data": {k: base64.b64encode(v.encode()).decode() for k, v in entries.items()},
    }


def _home(cluster: Cluster) -> None:
    """The home namespace and its four add-only lists, each with one earlier entry, as a running cluster has."""
    cluster.put(
        f"/api/v1/namespaces/{HOME}",
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": HOME}},
    )
    earlier_box, earlier_machine = box_namespace(_keyed(15)), _machine(15)
    for name, entries in (
        (BOX_MAP_SECRET, {earlier_machine: earlier_box}),
        (POOL_MAP_SECRET, {_machine(14): box_namespace(_keyed(14))}),
        (BOX_OWNERS_SECRET, {earlier_box: _keyed(13)}),
        (REMOVALS_SECRET, {box_namespace(_keyed(12)): _machine(12)}),
    ):
        cluster.put(f"/api/v1/namespaces/{HOME}/secrets/{name}", _list_secret(name, entries))


class _Core:
    """Core's side of the operator: the actions queued, every answer yes."""

    def __init__(self) -> None:
        self.actions: list[dict] = []
        self.removals: list[dict] = []

    def claim(self, report: dict | None = None) -> dict | None:
        return self.actions.pop(0) if self.actions else None

    def is_open(self, action_id: str, claim_token: str) -> bool:
        return True

    def step(self, action_id: str, claim_token: str, step: str) -> bool:
        return True

    def result(
        self,
        action_id: str,
        claim_token: str,
        result: str,
        namespace: str | None,
        failed_at: str | None,
    ) -> None:
        if result != "done":
            raise RuntimeError(f"the contract's {action_id} failed at {failed_at}")

    def removal_claim(self) -> dict | None:
        return self.removals.pop(0) if self.removals else None

    def removal_gone(self, machine_id: str, claim_token: str) -> bool:
        return True


TOKEN = "contract-claim-token-0123456789abcdef"


def _provision(
    cluster: Cluster, core: _Core, op: box_operator.BoxOperator, n: int, tier: str, box_keyed: bool
) -> str:
    user = _keyed(n)
    raw: dict[str, Any] = {
        "action_id": f"contract-{n}",
        "machine_id": _machine(n),
        "user_keyed_id": user,
        "size": tier,
        "claim_token": TOKEN,
    }
    if box_keyed:
        raw["box_keyed_id"] = _keyed(n + 32)
        raw["namespace"] = box_namespace(_keyed(n + 32))
    namespace = raw.get("namespace") or user_namespace(user)
    shape = "box-keyed" if box_keyed else "person-keyed"
    with cluster.acting(ACCOUNT["provisioner"], f"provisioner: a {tier} box, {shape}"):
        op.provision(box_operator.ProvisionAction.parse(raw))
    return namespace


def run_services() -> Cluster:
    """Every service's requests, through its own client and its own code, against one in-memory cluster."""
    cluster = Cluster()
    _home(cluster)
    core = _Core()
    kube = _client(OperatorKubeApi, cluster)
    op = box_operator.BoxOperator(core, kube, operator_config(), sleep=lambda _s: None)

    # The provisioner's probe, then one box per tier (box-keyed, as new boxes are), and a person-keyed one.
    with cluster.acting(ACCOUNT["provisioner"], "provisioner: the box-keyed names check"):
        op._check_names()
    boxes = {tier: _provision(cluster, core, op, i + 1, tier, True) for i, tier in enumerate(TIERS)}
    _provision(cluster, core, op, 4, "base", False)
    # The same box asked for again (Core's retry): each object exists, so the operator reads it back and checks it.
    _provision(cluster, core, op, 1, "base", True)

    # A warm pool box made, then bound to its person.
    pool_ns = box_namespace(_keyed(5 + 32))
    pool = {
        "action_id": "contract-pool",
        "machine_id": _machine(5),
        "user_keyed_id": None,
        "kind": "pool",
        "box_keyed_id": _keyed(5 + 32),
        "namespace": pool_ns,
        "size": "base",
        "claim_token": TOKEN,
    }
    with cluster.acting(ACCOUNT["provisioner"], "provisioner: a warm pool box"):
        op.pool(box_operator.ProvisionAction.parse(pool))
    bind = {**pool, "action_id": "contract-bind", "kind": "bind", "user_keyed_id": _keyed(5)}
    with cluster.acting(ACCOUNT["provisioner"], "provisioner: the pool box bound to its person"):
        op.bind(box_operator.ProvisionAction.parse(bind))

    # A box named for removal: the provisioner lists it, the remover deletes it.
    retired_ns = boxes["plus"]
    core.removals.append(
        {
            "machine_id": _machine(2),
            "namespace": retired_ns,
            "claim_token": TOKEN,
            "lease_seconds": 900,
        }
    )
    with cluster.acting(ACCOUNT["provisioner"], "provisioner: a box named for removal, listed"):
        op.removal_once()

    class RemoverCore:
        def removable(self, machine_id: str, namespace: str) -> bool:
            return True

        def listed(self, entries: list[dict[str, str]]) -> None:
            return None

    with cluster.acting(ACCOUNT["remover"], "remover: a listed box's namespace deleted"):
        remover.remove_once(RemoverCore(), _client(RemoverKubeApi, cluster))
    with cluster.acting(ACCOUNT["provisioner"], "provisioner: a removed box confirmed gone"):
        op.removal_once()

    # A pool box nobody claimed, retired: the reaper deletes it.
    spare = {**pool, "action_id": "contract-spare", "machine_id": _machine(6), "box_keyed_id": _keyed(6 + 32),
             "namespace": box_namespace(_keyed(6 + 32))}  # fmt: skip
    with cluster.acting(
        ACCOUNT["provisioner"], "provisioner: a second warm pool box, never claimed"
    ):
        op.pool(box_operator.ProvisionAction.parse(spare))

    class ReaperCore:
        def retiring(self) -> list[dict[str, Any]]:
            return [{"pool_box_id": _machine(6), "namespace": spare["namespace"]}]

        def gone(self, pool_box_id: str) -> bool:
            return True

    with cluster.acting(ACCOUNT["reaper"], "reaper: an unclaimed pool box's namespace deleted"):
        reaper.reap_once(ReaperCore(), _client(ReaperKubeApi, cluster))
    with cluster.acting(ACCOUNT["reaper"], "reaper: a deleted pool box confirmed gone"):
        reaper.reap_once(ReaperCore(), _client(ReaperKubeApi, cluster))

    # The scaler (and the eviction watch, on the same account): a box started and stopped, its enrolment code set,
    # a Warning event on it, and the lists it reads and the one it writes.
    cluster.put(
        f"/api/v1/namespaces/{HOME}/configmaps/{box_scaler.EGRESS_HELD_CONFIGMAP}",
        {"apiVersion": "v1", "kind": "ConfigMap",
         "metadata": {"name": box_scaler.EGRESS_HELD_CONFIGMAP, "namespace": HOME}, "data": {}},
    )  # fmt: skip
    scaler = _client(InClusterKubeApi, cluster, ("_token", ""), ("_token_file", None))
    base = boxes["base"]
    with cluster.acting(ACCOUNT["controller"], "scaler: the lists read"):
        scaler.box_map()
        scaler.box_removals()
    with cluster.acting(ACCOUNT["controller"], "scaler: a box looked at"):
        scaler.scale(base)
        scaler.box_pods(base)
        scaler.events(base)
    with cluster.acting(ACCOUNT["controller"], "scaler: a box held without its proxy login"):
        scaler.write_egress_held({base})
    with (
        cluster.acting(ACCOUNT["controller"], "eviction watch: a Warning event on a box"),
        _fixed_clock(),
    ):
        scaler.warn_box(base, "BoxPushedOff", "The box was pushed off its node.")
    with cluster.acting(ACCOUNT["controller"], "scaler: a box started"):
        scaler.set_replicas(base, 1)
    with cluster.acting(ACCOUNT["controller"], "scaler: a box stopped"):
        scaler.set_replicas(base, 0)
    with cluster.acting(ACCOUNT["controller"], "scaler: a box's enrolment code set"):
        scaler.set_enrol_code(base, "contract-enrolment-code")

    # The egress lists generator: the box's proxy login written into its login Secret.
    egress = egress_lists.EgressKubeApi(
        lambda method, path, body=None, **_: cluster.call(method, path, body)
    )
    box = egress_lists.BoxEgress(namespace=base, parts=(), split=True)
    # The read of the box's current login is the generator's own call too, so it's on its account.
    with cluster.acting(ACCOUNT["egress_lists"], "egress lists: a box's proxy login written"):
        ensured = egress_lists._ensure_login(
            egress,
            box,
            f"{PROXY_HOST}:{PROXY_PORT}",
            {},
            lambda: "contract-password",
            lambda: "contractsalt",
        )
        assert ensured is not None
        egress.set_login(base, ensured[0])
    # Its reads, and its two writes in egress-proxy (with placeholder content: the real allow lists stay out).
    for path, obj in (
        ("/api/v1/namespaces/egress-proxy", _ns_obj("egress-proxy")),
        ("/api/v1/namespaces/egress-lists", _ns_obj("egress-lists")),
        (f"/api/v1/namespaces/egress-proxy/configmaps/{egress_lists.BOXES_CONFIGMAP}",
         {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": egress_lists.BOXES_CONFIGMAP,
                                                               "namespace": "egress-proxy"}, "data": {}}),
        (f"/api/v1/namespaces/egress-proxy/secrets/{egress_lists.PASSWD_SECRET}",
         {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
          "metadata": {"name": egress_lists.PASSWD_SECRET, "namespace": "egress-proxy"}, "data": {}}),
        (f"/api/v1/namespaces/egress-lists/secrets/{egress_lists.SETTINGS_SECRET}",
         {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
          "metadata": {"name": egress_lists.SETTINGS_SECRET, "namespace": "egress-lists"},
          "data": {egress_lists.SETTINGS_KEY: base64.b64encode(b"{}").decode()}}),
    ):  # fmt: skip
        cluster.put(path, obj)
    with cluster.acting(ACCOUNT["egress_lists"], "egress lists: what it reads"):
        egress.box_map()
        egress.box_owners()
        egress.box_removals()
        egress.egress_held()
        egress.settings()
        egress.boxes_files()
        egress.passwd()
    with cluster.acting(ACCOUNT["egress_lists"], "egress lists: squid's box files written"):
        egress.patch_boxes_files({"contract.conf": "# placeholder\n"})
    with cluster.acting(ACCOUNT["egress_lists"], "egress lists: squid's logins written"):
        egress.set_passwd(
            "x\n"
        )  # a placeholder, short: a real-looking hash would read as a credential

    # The drain worker: an agents node cordoned, a box evicted, a placeholder made and taken away.
    node = "contract-agents-node-1"
    cluster.put(
        f"/api/v1/nodes/{node}",
        {"apiVersion": "v1", "kind": "Node",
         "metadata": {"name": node, "uid": "00000000-0000-4000-8000-00000000000a",
                      "labels": {drain_actions.POOL_LABEL: drain_actions.AGENTS_POOL,
                                 drain_actions.ZONE_KEY: ZONE}},
         "spec": {}},
    )  # fmt: skip
    cluster.put(
        f"/api/v1/namespaces/{drain_actions.ROOM_NAMESPACE}",
        {
            "apiVersion": "v1",
            "kind": "Namespace",
            "metadata": {"name": drain_actions.ROOM_NAMESPACE},
        },
    )
    pod = f"/api/v1/namespaces/{base}/pods/{drain_actions.POD}"
    cluster.put(pod, _box_pod(base))
    drain = _client(drain_actions.DrainKubeApi, cluster, ("_pool", drain_actions.AGENTS_POOL))
    with cluster.acting(ACCOUNT["drain"], "drain worker: what it reads"):
        drain.nodes()
        drain.node(node)
        drain.box_pod(base)
        drain.placeholder("drain-room-contract1")
    with cluster.acting(ACCOUNT["drain"], "drain worker: an agents node cordoned"):
        drain.cordon(node, "00000000-0000-4000-8000-00000000000a")
    with cluster.acting(ACCOUNT["drain"], "drain worker: a box evicted"):
        drain.evict(base, "00000000-0000-4000-8000-00000000000b")
    room = "drain-room-contract1"
    with cluster.acting(ACCOUNT["drain"], "drain worker: a placeholder made"):
        drain.create_placeholder(
            drain_actions.placeholder_body(room, IMAGE["pause"], drain_actions.AGENTS_POOL, ZONE)
        )
    with cluster.acting(ACCOUNT["drain"], "drain worker: a placeholder taken away"):
        drain.delete_placeholder(room)

    # The cluster report (the scaler's account): agents nodes, their memory, and the services' Deployments.
    cluster.put(f"/apis/metrics.k8s.io/v1beta1/nodes/{node}", {"usage": {"memory": "1Gi"}})
    for ns, name in ((HOME, "switch-hosted-controller"), ("egress-proxy", "squid")):
        cluster.put(
            f"/apis/apps/v1/namespaces/{ns}/deployments/{name}",
            {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name, "namespace": ns},
             "spec": {"replicas": 1}, "status": {"readyReplicas": 1}},
        )  # fmt: skip
    report = cluster_watch.ClusterKubeApi(
        lambda method, path, body=None, **_: cluster.call(method, path, body)
    )
    with cluster.acting(ACCOUNT["controller"], "cluster report: what it reads"):
        report.nodes()
        report.node_memory_used(node)
        report.deployment(HOME, "switch-hosted-controller")
        report.deployment("egress-proxy", "squid")

    # The restart worker: a box's pod deleted, so its StatefulSet makes it again.
    restart = _client(restart_actions.RestartKubeApi, cluster, ("_token", ""))
    with cluster.acting(ACCOUNT["controller"], "restart worker: a box's pod restarted"):
        restart.delete_box_pod(base, "00000000-0000-4000-8000-00000000000b")
    return cluster


def _box_pod(namespace: str) -> dict:
    """The box's pod as its StatefulSet makes it, for the drain and restart workers to act on."""
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": "box-0", "namespace": namespace, "uid": "00000000-0000-4000-8000-00000000000b",
                     "labels": {"app": "switch-box"}},
        "spec": {"runtimeClassName": "gvisor", "containers": [{"name": "agents", "image": IMAGE["box"]}]},
    }  # fmt: skip


# ---------------------------------------------------------------- bad samples: one per policy rule

# An administrator, for the rules every account meets (the namespace identity rule, the gVisor class scope), which
# no service account here may otherwise reach past its RBAC.
ADMIN = {"as": "contract-admin", "groups": ["system:masters"]}


@dataclass(frozen=True)
class Bad:
    """A good sample, changed so that one policy rule refuses it. `policies` are every policy that refuses it
    (usually one: where two policies guard the same thing, both are named). `message` is the refusing rule's
    message, as the policy states it. `rbac` marks a change RBAC refuses before admission is reached."""

    slug: str
    base: str
    change: Callable[[dict], None]
    policies: tuple[str, ...] = ()
    message: str = ""
    rbac: bool = False


def _body(s: dict) -> dict:
    return s["request"]["body"]


def _tmpl(s: dict) -> dict:
    return _body(s)["spec"]["template"]["spec"]


def _container(s: dict, name: str) -> dict:
    return next(c for c in _tmpl(s)["containers"] if c["name"] == name)


def _setup(s: dict, suffix: str) -> dict:
    return next(o["object"] for o in s["setup"] if o["path"].endswith(suffix))


def _add_setup(s: dict, path: str, obj: dict) -> None:
    s["setup"].insert(
        0 if "/namespaces/" not in path.split("/api/v1")[-1][11:] else len(s["setup"]),
        {"path": path, "object": obj},
    )


def _ns_obj(name: str, labels: dict | None = None) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {"name": name, "labels": labels or {}},
    }


def _unlabel_namespace(s: dict) -> None:
    ns = parse_path(s["request"]["path"]).namespace
    _setup(s, f"/namespaces/{ns}")["metadata"]["labels"] = {}


def _secret_data(s: dict, key: str, value: str | None) -> None:
    data = _body(s).setdefault("data", {})
    if value is None:
        data.pop(key)
    else:
        data[key] = base64.b64encode(value.encode()).decode()


def _change_old_entry(value: str) -> Callable[[dict], None]:
    """The list written back with one of the entries it already held pointing somewhere else (still a value of the
    right shape, so only the add-only rule can refuse it)."""

    def apply(s: dict) -> None:
        path = urlsplit(s["request"]["path"]).path
        (old,) = [o["object"] for o in s["setup"] if o["path"] == path]
        key = sorted(old["data"])[0]
        _body(s)["data"][key] = base64.b64encode(value.encode()).decode()

    return apply


def _drop_old_entry(s: dict) -> None:
    """The list written back without one of the entries it already held (one in the setup's copy of it, the state
    the write replaces), not merely without the entry this write adds."""
    path = urlsplit(s["request"]["path"]).path
    (old,) = [o["object"] for o in s["setup"] if o["path"] == path]
    data = _body(s)["data"]
    data.pop(sorted(old["data"])[0])


def _to(s: dict, method: str, path: str, body: dict | None = None) -> None:
    s["request"] = {"method": method, "path": path, **({"body": body} if body is not None else {})}


def _as_admin(s: dict) -> None:
    s["as"] = ADMIN["as"]
    s["groups"] = ADMIN["groups"]


def _ns_update(change: Callable[[dict], None], admin: bool = True) -> Callable[[dict], None]:
    """The namespace sample turned into an update of that namespace: by an administrator, or (`admin=False`) by the
    provisioner itself."""

    def apply(s: dict) -> None:
        obj = copy.deepcopy(_body(s))
        s["setup"].append(
            {"path": f"/api/v1/namespaces/{obj['metadata']['name']}", "object": copy.deepcopy(obj)}
        )
        change(obj)
        _to(s, "PUT", f"/api/v1/namespaces/{obj['metadata']['name']}", obj)
        if admin:
            _as_admin(s)

    return apply


def _admin_pod(spec: dict, namespace: str = "contract-plain") -> Callable[[dict], None]:
    def apply(s: dict) -> None:
        pod = {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": "contract-pod", "namespace": namespace},
            "spec": spec,
        }
        s["setup"] = [{"path": f"/api/v1/namespaces/{namespace}", "object": _ns_obj(namespace)}]
        _to(s, "POST", f"/api/v1/namespaces/{namespace}/pods", pod)
        _as_admin(s)

    return apply


G = "admission/good/"
NS = G + "provisioner-a-base-box-box-keyed-post-namespace-box-namespace.json"
STS = G + "provisioner-a-base-box-box-keyed-post-statefulset-box.json"
CA = G + "provisioner-a-base-box-box-keyed-post-configmap-switch-ca.json"
DENY = G + "provisioner-a-base-box-box-keyed-post-networkpolicy-default-deny.json"
EGRESS = G + "provisioner-a-base-box-box-keyed-post-networkpolicy-agent-egress.json"
QUOTA = G + "provisioner-a-base-box-box-keyed-post-resourcequota-no-shared-services-priority.json"
PVC = G + "provisioner-a-base-box-box-keyed-post-persistentvolumeclaim-data-agents.json"
SA = G + "provisioner-a-base-box-box-keyed-post-serviceaccount-box.json"
ENROL = G + "provisioner-a-base-box-box-keyed-post-secret-switch-enrol.json"
WATCH = G + "provisioner-a-base-box-box-keyed-post-rolebinding-switch-box-watch.json"
BOX_MAP = G + "provisioner-a-base-box-box-keyed-put-secret-box-map.json"
OWNERS = G + "provisioner-a-base-box-box-keyed-put-secret-box-owners.json"
POOL_MAP = G + "provisioner-a-warm-pool-box-put-secret-pool-map.json"
REMOVALS = G + "provisioner-a-box-named-for-removal-listed-put-secret-box-removals.json"
REAP = G + "reaper-an-unclaimed-pool-box-s-namespace-deleted-delete-namespace-box-namespace.json"
REMOVE = G + "remover-a-listed-box-s-namespace-deleted-delete-namespace-box-namespace.json"
ENROL_CODE = G + "scaler-a-box-s-enrolment-code-set-patch-secret-switch-enrol.json"
SCALE = G + "scaler-a-box-started-patch-statefulset-scale-box.json"
RESTART = G + "restart-worker-a-box-s-pod-restarted-delete-pod-box-0.json"
LOGIN = G + "egress-lists-a-box-s-proxy-login-written-patch-secret-switch-proxy-login.json"
CORDON = G + "drain-worker-an-agents-node-cordoned-patch-node-contract-agents-node-1.json"
EVICT = G + "drain-worker-a-box-evicted-post-pod-eviction-box-0.json"
ROOM = G + "drain-worker-a-placeholder-made-post-pod-drain-room-contract1.json"

P1, P2, P3C, P3N = (
    "switch-v0-p1-namespaces",
    "switch-v0-p2-box-objects",
    "switch-v0-p3-configmaps",
    "switch-v0-p3-networkpolicies",
)
P3Q, P3S, P4 = "switch-v0-p3-quota-disks-account", "switch-v0-p3-secrets", "switch-v0-p4-box-pod"
P5, P5P, P5O = "switch-v0-p5-box-map", "switch-v0-p5-pool-map", "switch-v0-p5-box-owners"
ADD_ONLY, REAPER, REMOVER = (
    "switch-pool-lists-add-only",
    "switch-reaper-deletes-unclaimed-pool-boxes",
    "switch-remover-deletes-listed-boxes",
)
IDENTITY, P6, P7, P8 = (
    "switch-box-namespace-identity",
    "switch-v0-p6-provisioner-catch-all",
    "switch-v0-p7-box-writes",
    "switch-v0-p8-box-watch-binding",
)
GVISOR, CORDON_ONLY = "switch-gvisor-class-scope", "switch-operator-cordon-only"
EVICT_ONLY, PLACEHOLDER = "switch-operator-evict-boxes-only", "switch-operator-placeholder-shape"


def _set(path: tuple[str, ...], value: Any) -> Callable[[dict], None]:
    def apply(s: dict) -> None:
        node = _body(s)
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value

    return apply


def _pod_set(key: str, value: Any) -> Callable[[dict], None]:
    return lambda s: _tmpl(s).__setitem__(key, value)


def _room_set(key: str, value: Any) -> Callable[[dict], None]:
    return lambda s: _body(s)["spec"].__setitem__(key, value)


def _room_container(key: str, value: Any) -> Callable[[dict], None]:
    return lambda s: _body(s)["spec"]["containers"][0].__setitem__(key, value)


def _name_out_of_form(s: dict) -> None:
    """A valid Kubernetes name, so only the policy can refuse it: a box namespace's shape with a "g" for its last
    hex digit."""
    name = "agents-box-k1-0123456789abcdeg"
    meta = _body(s)["metadata"]
    meta["name"] = name
    meta["labels"]["switch.dev/box"] = name.removeprefix("agents-")


def _label(key: str, value: str | None) -> Callable[[dict], None]:
    def apply(s: dict) -> None:
        labels = _body(s)["metadata"].setdefault("labels", {})
        if value is None:
            labels.pop(key)
        else:
            labels[key] = value

    return apply


def _starter_command(s: dict) -> None:
    _tmpl(s)["initContainers"][0]["command"][-1] += "; true"


def _agents_memory(s: dict) -> None:
    res = _container(s, "agents")["resources"]
    res["requests"]["memory"] = res["limits"]["memory"] = "12000Mi"


def _controller_mounts_agents_disk(s: dict) -> None:
    _container(s, "controller")["volumeMounts"].append(
        {"name": "data-agents", "mountPath": "/data/agents-too"}
    )


def _egress_port(s: dict) -> None:
    _body(s)["spec"]["egress"][2]["ports"][0]["port"] = 3129


def _core_range(cidr: str) -> Callable[[dict], None]:
    """The box's direct route to Core (egress rule 1) to `cidr` in place of the configured range."""

    def apply(s: dict) -> None:
        _body(s)["spec"]["egress"][1]["to"] = [{"ipBlock": {"cidr": cidr}}]

    return apply


def _reap(name: str, in_owners: bool) -> Callable[[dict], None]:
    def apply(s: dict) -> None:
        s["setup"].append({"path": f"/api/v1/namespaces/{name}", "object": _ns_obj(name)})
        if in_owners:
            owners = _setup(s, "/secrets/box-owners")
            owners["data"][name] = base64.b64encode(_keyed(9).encode()).decode()
        _to(s, "DELETE", f"/api/v1/namespaces/{name}")

    return apply


def _remove(name: str, listed: bool) -> Callable[[dict], None]:
    def apply(s: dict) -> None:
        s["setup"].append({"path": f"/api/v1/namespaces/{name}", "object": _ns_obj(name)})
        if listed:
            removals = _setup(s, "/secrets/box-removals")
            removals["data"][name] = base64.b64encode(_machine(9).encode()).decode()
        _to(s, "DELETE", f"/api/v1/namespaces/{name}")

    return apply


def _node(change: Callable[[dict], None]) -> Callable[[dict], None]:
    return lambda s: change(_setup(s, "/nodes/contract-agents-node-1"))


def _evict_other_pod(s: dict) -> None:
    ns = parse_path(s["request"]["path"]).namespace
    pod = copy.deepcopy(_setup(s, f"/namespaces/{ns}/pods/box-0"))
    pod["metadata"]["name"] = "box-1"
    s["setup"].append({"path": f"/api/v1/namespaces/{ns}/pods/box-1", "object": pod})
    body = copy.deepcopy(_body(s))
    body["metadata"]["name"] = "box-1"
    _to(s, "POST", f"/api/v1/namespaces/{ns}/pods/box-1/eviction", body)


def _evict_outside_a_box_namespace(s: dict) -> None:
    """The drain worker's eviction, aimed at a pod named box-0 in a namespace that isn't a box's. RBAC lets it
    through (the eviction grant is by pod name, in any namespace), so only the policy can refuse it. The pod is a
    plain one: a box pod's gVisor class is refused outside the box namespaces."""
    pod = {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": "box-0", "namespace": "contract-plain"},
        "spec": {"containers": [{"name": "c", "image": IMAGE["pause"]}]},
    }
    s["setup"] = [
        {"path": "/api/v1/namespaces/contract-plain", "object": _ns_obj("contract-plain")},
        {"path": "/api/v1/namespaces/contract-plain/pods/box-0", "object": pod},
    ]
    body = copy.deepcopy(_body(s))
    body["metadata"]["namespace"] = "contract-plain"
    _to(s, "POST", "/api/v1/namespaces/contract-plain/pods/box-0/eviction", body)


def _scale_elsewhere(s: dict) -> None:
    """The scaler's start, aimed at a StatefulSet named box in a namespace that isn't a box's."""
    ns = parse_path(s["request"]["path"]).namespace
    sts = copy.deepcopy(_setup(s, f"/namespaces/{ns}/statefulsets/box"))
    sts["metadata"]["namespace"] = "contract-plain"
    s["setup"] = [
        {"path": "/api/v1/namespaces/contract-plain", "object": _ns_obj("contract-plain")},
        {"path": "/apis/apps/v1/namespaces/contract-plain/statefulsets/box", "object": sts},
    ]
    s["request"]["path"] = s["request"]["path"].replace(
        f"/namespaces/{ns}/", "/namespaces/contract-plain/"
    )


def _configmap_elsewhere(s: dict) -> None:
    body = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "contract-extra", "namespace": HOME},
            "data": {"managed-settings.json": "{}"}}  # fmt: skip
    _to(s, "POST", f"/api/v1/namespaces/{HOME}/configmaps", body)


def _template_configmap(s: dict) -> None:
    body = _body(s)
    body["metadata"]["name"] = "contract-extra"
    body["data"] = {"managed-settings.json": "{}"}


def _bind_role(name: str) -> Callable[[dict], None]:
    return _set(("roleRef", "name"), name)


BAD: list[Bad] = [
    # P1: the namespaces the provisioner makes.
    Bad("p1-an-update", NS, _ns_update(lambda o: o["metadata"]["labels"].__setitem__("x", "y"), admin=False), rbac=True),
    Bad("p1-a-name-out-of-form", NS, _name_out_of_form, (P1,), "a box namespace is agents-user-k1-<16 hex> or agents-box-k1-<16 hex>"),
    Bad("p1-a-template-label-missing", NS, _label("app.kubernetes.io/part-of", None), (P1,), "the five template labels"),
    Bad("p1-an-extra-label", NS, _label("example.com/extra", "x"), (P1,), "no labels beyond the template's"),
    Bad("p1-a-machine-id-out-of-form", NS, _set(("metadata", "annotations", "switch.dev/machine-id"), "not-a-uuid"), (P1,), "exactly one annotation, switch.dev/machine-id, a UUID"),
    Bad("p1-a-finalizer", NS, _set(("metadata", "finalizers"), ["example.com/hold"]), (P1,), "no owners or finalizers"),
    # P2: the objects in a box namespace.
    Bad("p2-a-delete", CA, lambda s: _to(s, "DELETE", s["request"]["path"] + "/switch-ca"), rbac=True),
    Bad("p2-an-unlabelled-namespace", CA, _unlabel_namespace, (P2,), "only in a labelled box namespace"),
    Bad("p2-an-object-not-in-the-template", CA, _template_configmap, (P2,), "only the template's objects, by kind and name"),
    Bad("p2-a-finalizer", CA, _set(("metadata", "finalizers"), ["example.com/hold"]), (P2,), "no owners, and no finalizers except"),
    # P3: each object's content.
    Bad("p3-configmap-an-extra-key", CA, _set(("data", "extra"), "x"), (P3C,), "switch-ca holds ca.crt only"),
    Bad("p3-configmap-binary-data", CA, _set(("binaryData",), {"x": "eA=="}), (P3C,), "no binary data"),
    Bad("p3-networkpolicy-ingress-allowed", DENY, _set(("spec", "ingress"), [{}]), (P3N,), "both policies select every pod and allow nothing in"),
    Bad("p3-networkpolicy-deny-lets-egress-out", DENY, _set(("spec", "policyTypes"), ["Ingress"]), (P3N,), "default-deny must deny everything, in and out"),
    Bad("p3-networkpolicy-egress-to-another-port", EGRESS, _egress_port, (P3N,), "agent-egress must be exactly the template's"),
    Bad("p3-networkpolicy-core-another-range", EGRESS, _core_range("198.51.100.0/28"), (P3N,), "agent-egress must be exactly the template's"),
    Bad("p3-networkpolicy-core-a-wider-range", EGRESS, _core_range("192.0.2.0/24"), (P3N,), "agent-egress must be exactly the template's"),
    Bad("p3-quota-pods-allowed", QUOTA, _set(("spec", "hard"), {"pods": "1"}), (P3Q,), "the quota is the template's"),
    Bad("p3-disk-another-class", PVC, _set(("spec", "storageClassName"), "gp2"), (P3Q,), "a disk is gp3, ReadWriteOnce"),
    Bad("p3-account-mounts-its-token", SA, _set(("automountServiceAccountToken",), True), (P3Q,), "the box's account mounts no token"),
    Bad("p3-secret-not-opaque", ENROL, _set(("type",), "example.com/custom"), (P3S,), "Opaque Secrets only"),
    Bad("p3-secret-made-with-data", ENROL, lambda s: _secret_data(s, "code", "contract-code"), (P3S,), "switch-enrol and switch-proxy-login are made empty"),
    # P4: the box's StatefulSet.
    Bad("p4-made-running", STS, _set(("spec", "replicas"), 1), (P4,), "the box is made stopped (replicas 0)"),
    Bad("p4-another-service-name", STS, _set(("spec", "serviceName"), "other"), (P4,), "the template's selector and labels"),
    Bad("p4-not-gvisor", STS, _pod_set("runtimeClassName", "runc"), (P4,), "gVisor, the box account"),
    Bad("p4-host-network", STS, _pod_set("hostNetwork", True), (P4,), "no host access"),
    Bad("p4-starter-another-command", STS, _starter_command, (P4,), "at most one init container, the starter"),
    Bad("p4-another-zone", STS, lambda s: _tmpl(s)["nodeSelector"].__setitem__("topology.kubernetes.io/zone", "xx-example-9z"), (P4,), "agents machines in an allowed zone only"),
    Bad("p4-root-allowed", STS, lambda s: _tmpl(s)["securityContext"].__setitem__("runAsNonRoot", False), (P4,), "non-root, the default seccomp profile"),
    Bad("p4-a-container-renamed", STS, lambda s: _container(s, "agents").__setitem__("name", "agents2"), (P4,), "exactly two containers, controller and agents"),
    Bad("p4-not-a-tier", STS, _agents_memory, (P4,), "a new box is exactly one tier"),
    Bad("p4-an-image-not-allowed", STS, lambda s: _container(s, "controller").__setitem__("image", IMAGE["box_previous_3"]), (P4,), "allowed images only, pinned by digest"),
    Bad("p4-a-writable-root", STS, lambda s: _container(s, "agents")["securityContext"].__setitem__("readOnlyRootFilesystem", False), (P4,), "fixed users"),
    Bad("p4-privilege-escalation", STS, lambda s: _container(s, "agents")["securityContext"].__setitem__("allowPrivilegeEscalation", True), (P4,), "fixed users"),
    Bad("p4-a-capability-added", STS, lambda s: _container(s, "agents")["securityContext"]["capabilities"].__setitem__("add", ["NET_ADMIN"]), (P4,), "fixed users"),
    Bad("p4-privileged", STS, lambda s: _container(s, "agents")["securityContext"].update({"privileged": True, "allowPrivilegeEscalation": True}), (P4,), "fixed users"),
    Bad("p4-another-controller-command", STS, lambda s: _container(s, "controller")["args"].append("--extra"), (P4,), "the template's commands only"),
    Bad("p4-env-from-a-configmap", STS, lambda s: _container(s, "agents").__setitem__("envFrom", [{"configMapRef": {"name": "switch-ca"}}]), (P4,), "Secrets reach the containers only as the box's proxy login"),
    Bad("p4-the-agents-disk-in-the-controller", STS, _controller_mounts_agents_disk, (P4,), "the controller's disk only in controller"),
    Bad("p4-an-extra-volume", STS, lambda s: _tmpl(s)["volumes"].append({"name": "extra", "emptyDir": {}}), (P4,), "only the template's seven volumes"),
    # P5: the add-only lists.
    Bad("p5-box-map-deleted", BOX_MAP, lambda s: _to(s, "DELETE", s["request"]["path"]), rbac=True),
    Bad("p5-box-map-entry-removed", BOX_MAP, _drop_old_entry, (P5,), "an existing box map entry may never change or go"),
    Bad("p5-box-map-entry-out-of-form", BOX_MAP, lambda s: _secret_data(s, "not-a-uuid", box_namespace(_keyed(8))), (P5,), "a new entry is a machine id (UUID) to a box namespace"),
    Bad("p5-box-map-label-changed", BOX_MAP, _label("example.com/extra", "x"), (P5,), "the box map's labels, annotations and mutability"),
    Bad("p5-pool-map-deleted", POOL_MAP, lambda s: _to(s, "DELETE", s["request"]["path"]), rbac=True),
    Bad("p5-pool-map-entry-removed", POOL_MAP, _drop_old_entry, (P5P, ADD_ONLY), "an existing pool-map entry may never change or go"),
    Bad("p5-pool-map-entry-out-of-form", POOL_MAP, lambda s: _secret_data(s, _machine(8), user_namespace(_keyed(8))), (P5P,), "a new entry is a pool box id (UUID) to its box-keyed namespace"),
    Bad("p5-pool-map-label-changed", POOL_MAP, _label("example.com/extra", "x"), (P5P,), "the pool-map's labels, annotations and mutability"),
    Bad("p5-box-owners-deleted", OWNERS, lambda s: _to(s, "DELETE", s["request"]["path"]), rbac=True),
    Bad("p5-box-owners-entry-removed", OWNERS, _drop_old_entry, (P5O, ADD_ONLY), "an existing box-owners entry may never change or go"),
    Bad("p5-box-owners-entry-out-of-form", OWNERS, lambda s: _secret_data(s, box_namespace(_keyed(8)), "not-a-keyed-id"), (P5O,), "a new entry is a box-keyed namespace to its owner's keyed id"),
    Bad("p5-box-owners-label-changed", OWNERS, _label("example.com/extra", "x"), (P5O,), "the box-owners's labels, annotations and mutability"),
    Bad("p5-box-map-entry-value-changed", BOX_MAP, _change_old_entry(box_namespace(_keyed(10))), (P5,), "an existing box map entry may never change or go"),
    Bad("p5-pool-map-entry-value-changed", POOL_MAP, _change_old_entry(box_namespace(_keyed(10))), (P5P, ADD_ONLY), "an existing pool-map entry may never change or go"),
    Bad("p5-box-owners-entry-value-changed", OWNERS, _change_old_entry(_keyed(10)), (P5O, ADD_ONLY), "an existing box-owners entry may never change or go"),
    Bad("add-only-a-removal-entry-value-changed", REMOVALS, _change_old_entry(_machine(10)), (ADD_ONLY,), "an entry in pool-map, box-owners or box-removals never changes or goes"),
    Bad("add-only-a-removal-entry-removed", REMOVALS, _drop_old_entry, (ADD_ONLY,), "an entry in pool-map, box-owners or box-removals never changes or goes"),
    # The reaper and the remover: one namespace delete each.
    Bad("reaper-deletes-a-secret", REAP, lambda s: _to(s, "DELETE", f"/api/v1/namespaces/{HOME}/secrets/box-map"), rbac=True),
    Bad("remover-deletes-a-secret", REMOVE, lambda s: _to(s, "DELETE", f"/api/v1/namespaces/{HOME}/secrets/box-removals"), rbac=True),
    Bad("reaper-a-person-keyed-namespace", REAP, _reap(user_namespace(_keyed(9)), False), (REAPER,), "only a box-keyed namespace"),
    Bad("reaper-an-owned-box", REAP, _reap(box_namespace(_keyed(9)), True), (REAPER,), "never a box that has an owner"),
    Bad("remover-not-a-box-namespace", REMOVE, _remove("contract-example", True), (REMOVER,), "only a box namespace"),
    Bad("remover-a-box-not-listed", REMOVE, _remove(box_namespace(_keyed(9)), False), (REMOVER,), "only a namespace listed in box-removals"),
    # Anyone: a box namespace's identity.
    Bad("identity-machine-id-changed", NS, _ns_update(lambda o: o["metadata"]["annotations"].__setitem__("switch.dev/machine-id", _machine(9))), (IDENTITY,), "a box namespace's switch.dev/machine-id never changes"),
    Bad("identity-name-label-changed", NS, _ns_update(lambda o: o["metadata"]["labels"].__setitem__("switch.dev/box", "box-k1-" + "9" * 16)), (IDENTITY,), "a box namespace's name label never changes"),
    # P6: the provisioner's catch-all.
    Bad("p6-a-configmap-outside-a-box", CA, _configmap_elsewhere, (P6,), "the provisioner may only create a box's objects"),
    # P7: the controller's and the generator's writes.
    Bad("p7-a-write-in-an-unlabelled-namespace", RESTART, _unlabel_namespace, (P7,), "writes only to the box's fixed objects"),
    Bad("p7-generator-in-an-unlabelled-namespace", LOGIN, _unlabel_namespace, (P7,), "writes only to the box's fixed objects"),
    Bad("p7-scale-outside-a-box-namespace", SCALE, _scale_elsewhere, (P7,), "writes only to the box's fixed objects"),
    Bad("p7-enrolment-secret-another-key", ENROL_CODE, lambda s: _body(s)["data"].__setitem__("other", "eA=="), (P7,), "switch-enrol holds only code and registered"),
    # P8: the box's RoleBindings.
    Bad("p8-an-update", WATCH, lambda s: _to(s, "PUT", s["request"]["path"] + "/switch-box-watch", _body(s)), rbac=True),
    Bad("p8-an-unlabelled-namespace", WATCH, _unlabel_namespace, (P8, P2), "only in a labelled box namespace"),
    Bad("p8-another-name", WATCH, _set(("metadata", "name"), "switch-extra"), (P8, P2), "the RoleBinding is named switch-box-watch or switch-operator-restart"),
    Bad("p8-binds-another-role", WATCH, _bind_role("switch-operator-restart"), (P8,), "each binds only the ClusterRole of its own name"),
    Bad("p8-another-subject", WATCH, lambda s: _body(s)["subjects"][0].__setitem__("name", "default"), (P8,), "its one subject is the hosted controller's account"),
    Bad("p8-a-finalizer", WATCH, _set(("metadata", "finalizers"), ["example.com/hold"]), (P8, P2), "no owners or finalizers"),
    # Anyone: the gVisor classes.
    Bad("gvisor-a-class-outside-the-box-namespaces", ROOM, _admin_pod({"runtimeClassName": "gvisor", "containers": [{"name": "c", "image": IMAGE["pause"]}]}), (GVISOR,), "the gvisor classes carry the agent pool's toleration"),
    Bad("gvisor-agent-toleration-without-gvisor", ROOM, _admin_pod({"tolerations": [{"key": "switch.dev/pool", "operator": "Equal", "value": "agents", "effect": "NoSchedule"}], "containers": [{"name": "c", "image": IMAGE["pause"]}]}), (GVISOR,), "a pod that tolerates the agent pool's taint must run under a gVisor class"),
    # The drain worker: cordon, evict, placeholder.
    Bad("cordon-a-status-change", CORDON, lambda s: _to(s, "PATCH", s["request"]["path"] + "/status", _body(s)), rbac=True),
    Bad("cordon-not-an-agents-node", CORDON, _node(lambda n: n["metadata"]["labels"].__setitem__("switch.dev/pool", "system")), (CORDON_ONLY,), "the operator may only cordon agents machines"),
    Bad("cordon-already-cordoned", CORDON, _node(lambda n: n["spec"].__setitem__("unschedulable", True)), (CORDON_ONLY,), "the operator may only cordon (unschedulable false to true)"),
    Bad("cordon-and-taint", CORDON, _set(("spec", "taints"), [{"key": "example.com/x", "effect": "NoSchedule"}]), (CORDON_ONLY,), "the operator may not change a node's spec beyond cordoning it"),
    Bad("cordon-and-label", CORDON, _set(("metadata", "labels"), {"example.com/x": "y"}), (CORDON_ONLY,), "the operator may not change a node's labels"),
    Bad("evict-another-pod", EVICT, _evict_other_pod, rbac=True),  # the eviction grant names box-0 only
    Bad("evict-outside-a-box-namespace", EVICT, _evict_outside_a_box_namespace, (EVICT_ONLY,), "the operator may only evict box-0 in a box namespace"),
    Bad("placeholder-elsewhere", ROOM, lambda s: _to(s, "POST", f"/api/v1/namespaces/{HOME}/pods", _body(s)), rbac=True),
    Bad("placeholder-a-long-name", ROOM, _set(("metadata", "name"), "drain-room-" + "a" * 21), (PLACEHOLDER,), "a placeholder is named drain-room-<id>"),
    Bad("placeholder-with-env", ROOM, _room_container("env", [{"name": "X", "value": "y"}]), (PLACEHOLDER,), "a placeholder is one pause container"),
    Bad("placeholder-bigger-than-a-box", ROOM, _room_container("resources", {"requests": {"cpu": "600m", "memory": "11776Mi"}, "limits": {"cpu": "600m", "memory": "11776Mi"}}), (PLACEHOLDER,), "a placeholder is exactly one Base box in size"),
    Bad("placeholder-an-unlisted-spec-key", ROOM, _room_set("hostname", "contract"), (PLACEHOLDER,), "a placeholder's spec may only carry the listed keys"),
    Bad("placeholder-not-plain-gvisor", ROOM, _room_set("runtimeClassName", "gvisor-tuned"), (PLACEHOLDER,), "a placeholder runs under gVisor"),
    Bad("placeholder-a-port", ROOM, _room_container("ports", [{"containerPort": 8080}]), (PLACEHOLDER,), "a placeholder's container may only carry the listed keys"),
    Bad("placeholder-an-unlisted-security-key", ROOM, _room_set("securityContext", {"fsGroup": 1}), (PLACEHOLDER,), "a placeholder's security settings may only carry the listed keys"),
    Bad("placeholder-a-higher-priority", ROOM, _room_set("priorityClassName", "switch-box"), (PLACEHOLDER,), "a placeholder has priority 0 or below"),
    Bad("placeholder-another-scheduler", ROOM, _room_set("schedulerName", "contract-scheduler"), (PLACEHOLDER,), "a placeholder uses the default scheduler"),
    Bad("placeholder-another-toleration", ROOM, _room_set("tolerations", [{"key": "example.com/x", "operator": "Exists"}]), (PLACEHOLDER,), "a placeholder tolerates only"),
    Bad("placeholder-with-a-token", ROOM, _room_set("automountServiceAccountToken", True), (PLACEHOLDER,), "a placeholder has no token, no volumes and no host access"),
    Bad("placeholder-another-zone", ROOM, lambda s: _body(s)["spec"]["nodeSelector"].__setitem__("topology.kubernetes.io/zone", "xx-example-9z"), (PLACEHOLDER,), "a placeholder asks only for an agents machine in one zone"),
]  # fmt: skip


def bad_samples(good: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for bad in BAD:
        sample = copy.deepcopy(good[bad.base])
        bad.change(sample)
        groups = sample.pop("groups", None)
        doc = _sample_doc(
            f"refused: {bad.slug.replace('-', ' ')}",
            sample["as"],
            sample["setup"],
            sample["request"],
            "refuse",
            from_good=bad.base.removeprefix("admission/"),
            refused_by="rbac" if bad.rbac else "admission",
            policies=list(bad.policies),
            message=bad.message,
            **({"groups": groups} if groups else {}),
        )
        out[f"admission/bad/{bad.slug}.json"] = doc
    return out


# ---------------------------------------------------------------- the alert lines monitors page on


# The paging lines: the fixed words a monitor matches. `log_lines_problems` checks each is still logged.
# `service` is the Datadog service tag the service's pod carries (`tags.datadoghq.com/service`), which its monitor
# filters on. Every alert line pages: each has its monitor.
LOG_LINES: list[dict[str, Any]] = [
    {"service": "switch-hosted-remover", "words": "Remover ALERT", "source": "remover.py", "pages": True},
    {"service": "switch-hosted-provisioner", "words": "Box operator ALERT", "source": "box_operator.py",
     "pages": True, "only_with_any_of": ["removal", "retired"]},
    {"service": "switch-egress-lists", "words": "egress-held ALERT", "source": "egress_lists.py", "pages": True},
    {"service": "switch-hosted-provisioner", "words": "Box operator ALERT: a pool box being bound already has another owner",
     "source": "box_operator.py", "pages": True},
    {"service": "switch-hosted-provisioner", "words": "Box operator ALERT: an existing box runs an image that isn't pinned or allowed",
     "source": "box_operator.py", "pages": True},
    {"service": "switch-egress-lists", "words": "box-owners ALERT", "source": "egress_lists.py", "pages": True},
    {"service": "switch-hosted-reaper", "words": "Reaper ALERT", "source": "reaper.py", "pages": True},
    {"service": "switch-node-gate", "words": "Node gate ALERT", "source": "node_gate_main.py", "pages": True},
]  # fmt: skip


def log_lines_problems(src: Path) -> list[str]:
    problems = []
    for line in LOG_LINES:
        if line["words"] not in (src / line["source"]).read_text():
            problems.append(
                f"{line['service']}: {line['words']!r} isn't logged in {line['source']} any more"
            )
    # Every alert line the code logs is listed, by its fixed words up to the first placeholder.
    for path in sorted(src.glob("*.py")):
        if path.name == "contract.py":
            continue
        for found in re.findall(r'"((?:[A-Za-z-]+ ){0,2}[A-Za-z-]+ ALERT[^"%]*)', path.read_text()):
            if not any(
                found.startswith(line["words"]) or line["words"].startswith(found.rstrip(": "))
                for line in LOG_LINES
            ):
                problems.append(f"{path.name}: alert line {found!r} isn't in LOG_LINES")
    return problems


# ---------------------------------------------------------------- writing and checking


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def documents() -> dict[str, Any]:
    """Every file, by its path inside the contract folder."""
    cluster = run_services()
    out: dict[str, Any] = {}
    seen: dict[str, int] = {}
    for sample in cluster.samples:
        target = parse_path(sample.request["path"])
        kind = _RESOURCE_KIND[target.resource][2]
        label = target.name or (sample.request.get("body") or {}).get("metadata", {}).get(
            "name", ""
        )
        if re.fullmatch(BOX_NAMESPACE_PATTERN, label):
            label = "box-namespace"
        base = _slug(
            f"{sample.note} {sample.request['method']} {kind} {target.subresource} {label}"
        )
        seen[base] = seen.get(base, 0) + 1
        name = (
            f"admission/good/{base}-{seen[base]}.json"
            if seen[base] > 1
            else f"admission/good/{base}.json"
        )
        out[name] = _sample_doc(sample.note, sample.service, sample.setup, sample.request, "allow")
    out.update(bad_samples(out))
    out["rbac.json"] = {
        # Services whose calls aren't recorded here yet: their grants are unchecked, not wrong.
        "unrecorded": UNRECORDED,
        "box_namespace": BOX_NAMESPACE_PATTERN,
        "names": {placeholder: pattern for placeholder, (_, pattern) in VARYING_NAMES.items()},
        "calls": {
            account: [
                dict(
                    zip(
                        ("verb", "group", "resource", "subresource", "namespace", "name"),
                        call,
                        strict=True,
                    )
                )
                for call in sorted({_general(c) for c in calls})
            ]
            for account, calls in sorted(cluster.calls.items())
        },
    }
    out["log-lines.json"] = LOG_LINES
    out["tiers.json"] = TIERS
    out["fills.json"] = fills()
    return out


# Box namespaces differ per box, so a call in one is stated for every box namespace: `(box)` in `namespace`, or in
# `name` for the namespace itself. Any other namespace or name is exact.
BOX_NAMESPACE_PATTERN = "^agents-(user|box)-k1-[0-9a-f]{16}$"
BOX = "(box)"
UNRECORDED = [
    "system:serviceaccount:__PLACER_NS__:switch-placer",
    "system:serviceaccount:switch-node-gate:switch-node-gate",
]
# Other names a service chooses at run time, each stated for every name of its shape.
VARYING_NAMES = {
    "(node)": ("nodes", r"[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*"),
    "(drain-room)": ("pods", r"drain-room-[a-z0-9]{1,20}"),
}


def _general(call: tuple[str, str, str, str, str, str]) -> tuple[str, str, str, str, str, str]:
    verb, group, resource, subresource, namespace, name = call
    if re.fullmatch(BOX_NAMESPACE_PATTERN, namespace):
        namespace = BOX
    if resource == "namespaces" and re.fullmatch(BOX_NAMESPACE_PATTERN, name):
        name = BOX
    for placeholder, (where, pattern) in VARYING_NAMES.items():
        if resource == where and name and re.fullmatch(pattern, name):
            name = placeholder
    return verb, group, resource, subresource, namespace, name


def _sample_doc(
    what: str, account: str, setup: list[dict], request: dict, expect: str, **extra: Any
) -> dict:
    """One admission sample: the request to replay, and the same request as admission sees it."""
    target = parse_path(request["path"])
    group, version, _ = _RESOURCE_KIND[target.resource]
    body = request.get("body")
    return {
        "what": what,
        "as": account,
        "setup": setup,
        "request": request,
        "operation": _OPERATION[request["method"]],
        "group": group,
        "version": version,
        "resource": target.resource,
        "subresource": target.subresource,
        "namespace": target.namespace,
        "name": target.name or (body or {}).get("metadata", {}).get("name", ""),
        "object": body if request["method"] in ("POST", "PUT") else None,
        "expect": expect,
        **extra,
    }


def _render(doc: Any) -> bytes:
    return (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode()


def rendered() -> dict[str, bytes]:
    files = {name: _render(doc) for name, doc in documents().items()}
    index = {
        "format": FORMAT,
        "template_revision": box_operator.template_revision(operator_config()),
        "tiers": list(TIERS),
        # A list, path and hash apart: a file name like `...-secret-...` beside a hash would read as a credential.
        "files": [
            {"path": name, "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(files.items())
        ],
    }
    files["index.json"] = _render(index)
    return files


# ---------------------------------------------------------------- the placeholders-only check

_DOC_NETWORKS = [
    ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/22", "203.0.113.0/24")
]
_ALLOWED_HOSTS = {"registry.example", "kubernetes.example", PROXY_HOST, SERVER_HOST}
_IP = re.compile(r"(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?:/\d{1,2})?(?![\d.])")
_KEYED = re.compile(r"k1-[0-9a-f]{16}")


def _made_up_keyed(value: str) -> bool:
    """One of ours: a single repeated hex digit, or a plain count."""
    tail = value[3:]
    return len(set(tail)) == 1 or tail.lstrip("0") in {f"{n:x}" for n in range(64)}


def placeholder_problems(files: dict[str, bytes]) -> list[str]:
    """What in the files isn't an obvious placeholder: a 12-digit run (an account id), an internal or tailnet
    host name, an address outside the documentation ranges, a keyed id not made up, a private key."""
    problems = []
    for name, data in files.items():
        text = data.decode()
        for bad, why in (
            (r"(?<![-0-9A-Za-z])\d{12}(?![0-9A-Za-z])", "a 12-digit run, like an account id"),
            (r"\.internal\b", "an internal host name"),
            (r"ts\.net\b", "a tailnet host name"),
            (r"amazonaws\.com", "a cloud endpoint"),
            (r"PRIVATE KEY", "a private key"),
        ):
            if re.search(bad, text):
                problems.append(f"{name}: {why}")
        for match in _IP.finditer(text):
            try:
                address = ipaddress.ip_address(match.group(1))
            except ValueError:
                continue
            if not (
                address.is_loopback or address.is_unspecified or address.is_link_local
            ) and not any(address in network for network in _DOC_NETWORKS):
                problems.append(
                    f"{name}: address {match.group(1)} outside the documentation ranges"
                )
        for match in _KEYED.finditer(text):
            if not _made_up_keyed(match.group(0)):
                problems.append(f"{name}: keyed id {match.group(0)} isn't an obviously made-up one")
        # Host names where they reach a network: in a URL, and an image's registry. (Label keys and API groups
        # look like host names too, and are fixed words of the code.)
        hosts = re.findall(r"://([a-z0-9.-]+)", text) + re.findall(
            r'"image": "([a-z0-9.-]+)/', text
        )
        for host in hosts:
            if host not in _ALLOWED_HOSTS and not _IP.fullmatch(host):
                problems.append(f"{name}: host name {host}")
    return problems


def write(out: Path) -> None:
    files = rendered()
    problems = placeholder_problems(files)
    if problems:
        raise SystemExit("refusing to write the contract:\n  " + "\n  ".join(problems))
    if out.exists():
        for child in out.iterdir():
            if child.name == "README.md":
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    for name, data in files.items():
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def differences(folder: Path) -> list[str]:
    """How the folder differs from a fresh run: each file missing, changed or extra."""
    files = rendered()
    found = {
        str(p.relative_to(folder)): p.read_bytes()
        for p in folder.rglob("*")
        if p.is_file() and p.name != "README.md"
    }
    problems = [f"missing: {n}" for n in sorted(set(files) - set(found))]
    problems += [f"changed: {n}" for n in sorted(set(files) & set(found)) if files[n] != found[n]]
    problems += [f"extra: {n}" for n in sorted(set(found) - set(files))]
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m switch_hosted_controller.contract")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--out", type=Path)
    group.add_argument("--check", type=Path)
    args = parser.parse_args(argv)
    if args.out:
        write(args.out)
        return 0
    problems = differences(args.check)
    for line in problems:
        print(line, file=sys.stderr)
    if problems:
        print("The contract is out of date: write it again with --out.", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
