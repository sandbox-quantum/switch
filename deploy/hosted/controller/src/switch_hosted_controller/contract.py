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
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlsplit

from . import box_operator, box_scaler, reaper, remover
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
SERVER_IP = "192.0.2.10"
API_SERVER_IPS = ("192.0.2.11", "192.0.2.12")
AGENTS_SUBNET = "198.51.100.0/24"
CLUSTER_VPC_CIDR = "198.51.100.0/22"
CLUSTER_SERVICE_CIDR = "203.0.113.0/24"
KUBERNETES_SERVICE_IP = "203.0.113.1"
ZONE = "xx-example-1a"
DAILY_CALLS = 500
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
            "server_ip": SERVER_IP,
            "server_url": "https://" + SERVER_IP,
            "image": IMAGE["box"],
            "storage_class": STORAGE_CLASS,
            "proxy_host": PROXY_HOST,
            "proxy_port": PROXY_PORT,
            "zones": [ZONE],
            "sizes": TIERS,
            "ceiling": 20,
            "daily_calls": DAILY_CALLS,
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
        "__DAILY_CALLS__": DAILY_CALLS,
        "__EGRESS_LISTS_IMAGE__": IMAGE["egress_lists"],
        "__PAUSE_IMAGE__": IMAGE["pause"],
        "__PREVIOUS_BOX_IMAGE_1__": IMAGE["box_previous_1"],
        "__PREVIOUS_BOX_IMAGE_2__": IMAGE["box_previous_2"],
        "__PREVIOUS_BOX_IMAGE_3__": IMAGE["box_previous_3"],
        "__SERVER_IP__": SERVER_IP,
        "__ZONE__": ZONE,
        "kubernetes_service_ip": KUBERNETES_SERVICE_IP,
    }


# ---------------------------------------------------------------- the in-memory API server


ACCOUNT = {
    "provisioner": f"system:serviceaccount:{HOME}:switch-hosted-provisioner",
    "reaper": f"system:serviceaccount:{HOME}:switch-hosted-reaper",
    "remover": f"system:serviceaccount:{HOME}:switch-hosted-remover",
    "controller": f"system:serviceaccount:{HOME}:switch-hosted-controller",
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
    "events": ("", "v1", "Event"),
    "networkpolicies": ("networking.k8s.io", "v1", "NetworkPolicy"),
    "statefulsets": ("apps", "v1", "StatefulSet"),
    "rolebindings": ("rbac.authorization.k8s.io", "v1", "RoleBinding"),
}


@dataclass(frozen=True)
class Target:
    group: str
    resource: str
    subresource: str
    namespace: str
    name: str

    @property
    def item(self) -> str:
        """The object's own path (a subresource's object is its parent)."""
        prefix = "/api/v1" if self.group == "" else f"/apis/{self.group}/v1"
        if self.resource == "namespaces":
            return f"{prefix}/namespaces/{self.name}"
        ns = f"/namespaces/{self.namespace}" if self.namespace else ""
        return f"{prefix}{ns}/{self.resource}/{self.name}"


def parse_path(path: str) -> Target:
    parts = urlsplit(path).path.strip("/").split("/")
    if parts[0] == "api":
        group, rest = "", parts[2:]
    elif parts[0] == "apis":
        group, rest = parts[1], parts[3:]
    else:
        raise ValueError(f"not an API path: {path}")
    namespace = ""
    if rest[:1] == ["namespaces"] and len(rest) >= 3:
        namespace, rest = rest[1], rest[2:]
    elif rest[:1] == ["namespaces"]:
        return Target(group, "namespaces", "", "", rest[1] if len(rest) > 1 else "")
    resource = rest[0]
    name = rest[1] if len(rest) > 1 else ""
    subresource = rest[2] if len(rest) > 2 else ""
    return Target(group, resource, subresource, namespace, name)


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
            if in_home or in_target or own_ns:
                wanted.append({"path": path, "object": _strip(obj)})
        # Namespaces first, so each object's namespace exists before it.
        wanted.sort(key=lambda s: 0 if parse_path(s["path"]).resource == "namespaces" else 1)
        return wanted

    def call(self, method: str, path: str, body: Any = None) -> Any:
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
        if method == "POST":
            name = (body or {}).get("metadata", {}).get("name", "")
            if target.resource == "namespaces":
                item = f"/api/v1/namespaces/{name}"
            elif target.resource == "events" and not name:
                name = body["metadata"]["generateName"] + "contract"
                item = Target(target.group, target.resource, "", target.namespace, name).item
            else:
                item = Target(target.group, target.resource, "", target.namespace, name).item
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
            self._record(method, path, body, target)
            self.put(item, new)
            return copy.deepcopy(new)
        if method == "DELETE":
            if item not in self.objects:
                raise HTTPError(path, 404, "not found", {}, None)  # type: ignore[arg-type]
            self._record(method, path, None, target)
            del self.objects[item]
            if target.resource == "namespaces":
                for p in [p for p in self.objects if parse_path(p).namespace == target.name]:
                    del self.objects[p]
            return {}
        raise ValueError(method)

    def _record(self, method: str, path: str, body: Any, target: Target) -> None:
        request: dict[str, Any] = {"method": method, "path": path}
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
    client._call = lambda method, path, body=None, **_: cluster.call(method, path, body)
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
    return cluster


# ---------------------------------------------------------------- the alert lines monitors page on


# The paging lines: the fixed words a monitor matches. `log_lines_problems` checks each is still logged.
# `service` is the Datadog service tag the service's pod carries (`tags.datadoghq.com/service`), which its monitor
# filters on.
LOG_LINES: list[dict[str, str]] = [
    {"service": "switch-hosted-remover", "words": "Remover ALERT", "source": "remover.py"},
    {
        "service": "switch-hosted-provisioner",
        "words": "Box operator ALERT",
        "source": "box_operator.py",
    },
    {"service": "switch-egress-lists", "words": "egress-held ALERT", "source": "egress_lists.py"},
]


def log_lines_problems(src: Path) -> list[str]:
    problems = []
    for line in LOG_LINES:
        if line["words"] not in (src / line["source"]).read_text():
            problems.append(
                f"{line['service']}: {line['words']!r} isn't logged in {line['source']} any more"
            )
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
        group, version, _ = _RESOURCE_KIND[target.resource]
        body = sample.request.get("body")
        out[name] = {
            "what": sample.note,
            "as": sample.service,
            "setup": sample.setup,
            "request": sample.request,
            # The same request, as admission sees it.
            "operation": _OPERATION[sample.request["method"]],
            "group": group,
            "version": version,
            "resource": target.resource,
            "subresource": target.subresource,
            "namespace": target.namespace,
            "name": target.name or (body or {}).get("metadata", {}).get("name", ""),
            "object": body if sample.request["method"] in ("POST", "PUT") else None,
            "expect": "allow",
        }
    out["rbac.json"] = {
        "box_namespace": BOX_NAMESPACE_PATTERN,
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


def _general(call: tuple[str, str, str, str, str, str]) -> tuple[str, str, str, str, str, str]:
    verb, group, resource, subresource, namespace, name = call
    if re.fullmatch(BOX_NAMESPACE_PATTERN, namespace):
        namespace = BOX
    if resource == "namespaces" and re.fullmatch(BOX_NAMESPACE_PATTERN, name):
        name = BOX
    return verb, group, resource, subresource, namespace, name


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
_ALLOWED_HOSTS = {"registry.example", "kubernetes.example", PROXY_HOST}
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
