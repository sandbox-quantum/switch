"""A user's box, made on Core's request (`switch-box-operator`).

Core writes a run-once "provision" action when an allowed user with no box adds their first cloud agent. This
claims it, makes the box's objects from one fixed template (this module, never anything from Core), adds the box map
entry and reports the result. The existing parts then do what they do today: allow-lists fills the box's proxy login,
and the scaler asks Core for the enrolment code and starts the box. So this never sees a code or a login.

- From Core it takes only the machine id, the user's keyed id and a size name, each checked against a fixed form.
- The namespace is `agents-user-<keyed id>`, matched to the admission policy's exact pattern before any call.
- Create-only. Every name is fixed, and an object that already exists must match what this would make, or the action
  fails at that step and nothing is changed. A retry, or a restart partway through, carries on where it stopped.
  On a box made earlier, only the image (pinned and on `allowed_images`) and the size (one configured size, the
  same for the agents container, its memory setting and the agents disk) may differ.
- The box map only ever gains entries, and never past the ceiling.
- Log lines carry action ids, machine ids, namespaces, step codes and HTTP statuses only.
"""

from __future__ import annotations

import copy
import hashlib
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from .egress_lists import LOGIN_SECRET, check_box_pod_spec

logger = logging.getLogger(__name__)

USER_RE = re.compile(r"k1-[0-9a-f]{16}")
NAMESPACE_RE = re.compile(r"agents-user-k1-[0-9a-f]{16}")  # the admission policy's pattern
MACHINE_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
ACTION_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")
CLAIM_TOKEN_RE = re.compile(
    r"[A-Za-z0-9_-]{16,64}"
)  # Core: token_urlsafe(24), 32 chars; at most 64
SIZE_RE = re.compile(r"[a-z0-9][a-z0-9.-]{0,31}")  # as Core checks it
ZONE_RE = re.compile(r"[a-z]{2}-[a-z]+-[0-9][a-z]")
DIGEST_IMAGE_RE = re.compile(r"[a-z0-9][a-z0-9./-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}")
MAX_ALLOWED_IMAGES = 20

MANAGED_BY = "switch-hosted"
ENROL_SECRET = "switch-enrol"
CA_CONFIGMAP = "switch-ca"
SETTINGS_CONFIGMAP = "claude-managed-settings"
BOX_WATCH = (
    "switch-box-watch"  # the one RoleBinding, to the admin-made ClusterRole of the same name (P8)
)
# Restart: one RoleBinding to the admin-made ClusterRole of the same name (get and delete on `box-0` only), made
# with every box from template v2.3. No Role is ever made here.
BOX_RESTART = "switch-operator-restart"
CONTROLLER_ACCOUNT = "switch-hosted-controller"
CONTROLLER_HOME = "switch-hosted"
MACHINE_NAME = "Switch cloud"  # what the user sees on their Machines page

# The failure codes Core accepts in a result. Core records the claim itself; every step
# here is safe to repeat, so a retried action needs no record of how far the last try got.
FAILURES = ("name_refused", "policy_refused", "object_refused", "box_map_failed", "ceiling_reached")


class ConfigError(ValueError):
    pass


class ActionError(ValueError):
    """Core handed something that isn't a provision action this operator can act on."""


class Mismatch(Exception):
    """An object already exists under a fixed name, and isn't the one this would make."""


class BoxMapConflict(Exception):
    """The box map changed between reading and writing it."""


class ProvisionFailed(Exception):
    def __init__(self, code: str):
        if code not in FAILURES:
            raise ValueError(f"not a failure code Core accepts: {code!r}")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class BoxSize:
    disk: str
    cpu_request: str
    cpu_limit: str
    memory_request: str
    memory_limit: str


@dataclass(frozen=True)
class OperatorConfig:
    server_ip: str
    server_url: str
    image: str
    storage_class: str
    proxy_host: str
    proxy_port: int
    zones: tuple[str, ...]
    sizes: Mapping[str, BoxSize]
    ceiling: int
    default_size: str
    ca_cert: str  # the test CA's public certificate, from the operator's own mounted file
    managed_settings: str  # the managed settings JSON, from the operator's own mounted file
    split: bool = True
    extra: Mapping[str, Any] = field(default_factory=dict)
    # The images an existing box may run: `image` plus the earlier digests still in use.
    allowed_images: frozenset[str] = frozenset()

    def image_allowed(self, image: Any) -> bool:
        return (
            isinstance(image, str)
            and DIGEST_IMAGE_RE.fullmatch(image) is not None
            and (image == self.image or image in self.allowed_images)
        )


def _canonical_cpu(quantity: str) -> bool:
    """Whole cores or millicores, in the one form the API server stores: 4 and 500m, never 4000m or 0.5. Resources
    on an existing box are compared exactly, so any other form would never match one of this operator's own boxes."""
    if re.fullmatch(r"[1-9][0-9]{0,5}", quantity):
        return True
    millis = re.fullmatch(r"([1-9][0-9]{0,8})m", quantity)
    return millis is not None and int(millis.group(1)) % 1000 != 0


def _canonical_bytes(quantity: str, units: Sequence[str]) -> bool:
    """A whole number of one binary unit, the largest that holds it exactly (as the API server stores it): 1536Mi and
    2Gi, never 1.5Gi or 2048Mi."""
    match = re.fullmatch(r"([1-9][0-9]{0,6})(Mi|Gi|Ti)", quantity)
    if match is None or match.group(2) not in units:
        return False
    return int(match.group(1)) % 1024 != 0


def config_from(raw: Any, ca_cert: str, managed_settings: str) -> OperatorConfig:
    """The operator's configuration, refused whole if anything in it is off."""
    if not isinstance(raw, dict):
        raise ConfigError("the configuration must be an object")
    known = {
        "server_ip", "server_url", "image", "storage_class", "proxy_host", "proxy_port", "zones", "sizes",
        "ceiling", "default_size", "split", "allowed_images",
    }  # fmt: skip
    unknown = set(raw) - known
    if unknown:
        raise ConfigError(f"unknown configuration keys: {sorted(unknown)}")
    server_ip = raw.get("server_ip")
    if not isinstance(server_ip, str) or not re.fullmatch(r"(\d{1,3}\.){3}\d{1,3}", server_ip):
        raise ConfigError("server_ip must be an IPv4 address")
    server_url = raw.get("server_url")
    if not isinstance(server_url, str) or not server_url.startswith("https://"):
        raise ConfigError("server_url must be an https URL")
    image = raw.get("image")
    if not isinstance(image, str) or not DIGEST_IMAGE_RE.fullmatch(image):
        raise ConfigError("image must be pinned by its full sha256 digest")
    allowed_raw = raw.get("allowed_images", [])
    if (
        not isinstance(allowed_raw, list)
        or len(allowed_raw) > MAX_ALLOWED_IMAGES
        or not all(isinstance(i, str) and DIGEST_IMAGE_RE.fullmatch(i) for i in allowed_raw)
        or len(set(allowed_raw)) != len(allowed_raw)
    ):
        raise ConfigError(
            f"allowed_images must be a list of at most {MAX_ALLOWED_IMAGES} distinct images, each pinned by its"
            " full sha256 digest"
        )
    storage_class = raw.get("storage_class")
    if not isinstance(storage_class, str) or not re.fullmatch(r"[a-z0-9-]{1,63}", storage_class):
        raise ConfigError("storage_class must be a storage class name")
    proxy_host = raw.get("proxy_host")
    if not isinstance(proxy_host, str) or not re.fullmatch(r"[a-z0-9.-]{1,253}", proxy_host):
        raise ConfigError("proxy_host must be a host name")
    proxy_port = raw.get("proxy_port")
    if (
        not isinstance(proxy_port, int)
        or isinstance(proxy_port, bool)
        or not 1 <= proxy_port <= 65535
    ):
        raise ConfigError("proxy_port must be a port")
    zones = raw.get("zones")
    if (
        not isinstance(zones, list)
        or not zones
        or not all(isinstance(z, str) and ZONE_RE.fullmatch(z) for z in zones)
        or len(set(zones)) != len(zones)
    ):
        raise ConfigError("zones must be a non-empty list of distinct zone names")
    sizes_raw = raw.get("sizes")
    if not isinstance(sizes_raw, dict) or not sizes_raw:
        raise ConfigError("sizes must be a non-empty object")
    sizes: dict[str, BoxSize] = {}
    for name, size in sizes_raw.items():
        if not SIZE_RE.fullmatch(name) or not isinstance(size, dict):
            raise ConfigError("each size needs a plain name and an object")
        keys = ("disk", "cpu_request", "cpu_limit", "memory_request", "memory_limit")
        if set(size) != set(keys) or not all(isinstance(size[k], str) for k in keys):
            raise ConfigError(f"size {name!r} needs exactly {', '.join(keys)}, each a quantity")
        if not all(_canonical_cpu(size[k]) for k in ("cpu_request", "cpu_limit")):
            raise ConfigError(
                f"size {name!r}: cpu as whole cores or millicores, as the API server stores it (500m, 4)"
            )
        memory_units = ("Mi", "Gi")
        if not all(
            _canonical_bytes(size[k], memory_units) for k in ("memory_request", "memory_limit")
        ) or not _canonical_bytes(size["disk"], (*memory_units, "Ti")):
            raise ConfigError(
                f"size {name!r}: memory in Mi or Gi and disk in Mi, Gi or Ti, each as the API server"
                " stores it (1536Mi, not 1.5Gi; 1Gi, not 1024Mi)"
            )
        sizes[name] = BoxSize(**{k: size[k] for k in keys})
    ceiling = raw.get("ceiling")
    if not isinstance(ceiling, int) or isinstance(ceiling, bool) or not 1 <= ceiling <= 10_000:
        raise ConfigError("ceiling must be a whole number from 1 to 10000")
    default_size = raw.get("default_size")
    if not isinstance(default_size, str) or default_size not in sizes:
        raise ConfigError("default_size must name one of the sizes")
    split = raw.get("split", True)
    if not isinstance(split, bool):
        raise ConfigError("split must be true or false")
    if not ca_cert.startswith("-----BEGIN CERTIFICATE-----"):
        raise ConfigError("the CA file must hold a PEM certificate")
    if not managed_settings.lstrip().startswith("{"):
        raise ConfigError("the managed settings file must hold a JSON object")
    return OperatorConfig(
        server_ip=server_ip,
        server_url=server_url.rstrip("/"),
        image=image,
        storage_class=storage_class,
        proxy_host=proxy_host,
        proxy_port=proxy_port,
        zones=tuple(zones),
        sizes=sizes,
        ceiling=ceiling,
        default_size=default_size,
        ca_cert=ca_cert,
        managed_settings=managed_settings,
        split=split,
        allowed_images=frozenset([image, *allowed_raw]),
    )


@dataclass(frozen=True)
class ProvisionAction:
    action_id: str
    machine_id: str
    user: str
    size: str | None  # None: Core has no size for this machine yet, so the configured default
    # Core's token for this claim, sent back with the result so a stale worker's result is refused. Kept
    # out of repr, so it never reaches a log line.
    claim_token: str = field(repr=False)

    @classmethod
    def parse(cls, raw: Any) -> ProvisionAction:
        """Only the fields this needs, each in its fixed form. Anything else Core sends is ignored."""
        if not isinstance(raw, dict):
            raise ActionError("not an object")
        action_id, machine_id = raw.get("action_id"), raw.get("machine_id")
        user, size = raw.get("user_keyed_id"), raw.get("size")
        claim_token = raw.get("claim_token")
        if not isinstance(action_id, str) or not ACTION_ID_RE.fullmatch(action_id):
            raise ActionError("action_id")
        if not isinstance(machine_id, str) or not MACHINE_ID_RE.fullmatch(machine_id):
            raise ActionError("machine_id")
        if not isinstance(user, str) or not USER_RE.fullmatch(user):
            raise ActionError("user_keyed_id")
        if size is not None and (not isinstance(size, str) or not SIZE_RE.fullmatch(size)):
            raise ActionError("size")
        if not isinstance(claim_token, str) or not CLAIM_TOKEN_RE.fullmatch(claim_token):
            raise ActionError("claim_token")
        return cls(action_id, machine_id, user, size, claim_token)


def namespace_for(user: str) -> str:
    namespace = f"agents-user-{user}"
    if not NAMESPACE_RE.fullmatch(namespace):
        raise ProvisionFailed("name_refused")
    return namespace


def zone_for(user: str, zones: Sequence[str]) -> str:
    """The same zone for a user every time, so a retry never puts the box and its disks apart, spread evenly over
    keyed ids."""
    digest = hashlib.sha256(user.encode()).digest()
    return zones[int.from_bytes(digest[:8], "big") % len(zones)]


MACHINE_ANNOTATION = "switch.dev/machine-id"
CONTROLLER_DISK = "2Gi"  # the split template's fixed controller disk
CONTROLLER_MEMORY_LIMIT = "768Mi"


def _bytes(quantity: str) -> int:
    """Mi or Gi only (the configuration allows no other unit for memory)."""
    units = {"Mi": 2**20, "Gi": 2**30}
    return int(quantity[:-2]) * units[quantity[-2:]]


def box_objects(action: ProvisionAction, config: OperatorConfig) -> list[tuple[str, dict]]:
    """Every object of the user's box, each with the step it belongs to, in the order they must exist: the namespace,
    then its network policies (before anything that could run), then the rest, the StatefulSet last and at 0
    replicas. Built from the operator's own configuration and Core's three
    checked fields only."""
    size = config.sizes.get(action.size or config.default_size)
    if size is None:
        raise ProvisionFailed("object_refused")
    ns = namespace_for(action.user)
    user_name = f"user-{action.user}"  # the template's __USER__

    def meta(name: str) -> dict:
        return {"name": name, "namespace": ns}

    # As split template v2 has it. The machine-id annotation is what makes an existing namespace this box's own: one
    # made for any other machine never matches.
    namespace = {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": ns,
            "labels": {
                "app.kubernetes.io/part-of": "hosted-agents-test",
                "app.kubernetes.io/managed-by": MANAGED_BY,
                "switch.dev/user": user_name,
                "pod-security.kubernetes.io/enforce": "restricted",
                "pod-security.kubernetes.io/warn": "restricted",
            },
            "annotations": {MACHINE_ANNOTATION: action.machine_id},
        },
    }
    default_deny = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": meta("default-deny"),
        "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
    }
    egress = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": meta("agent-egress"),
        "spec": {
            "podSelector": {},
            "policyTypes": ["Egress"],
            "egress": [
                {
                    "to": [
                        {
                            "namespaceSelector": {
                                "matchLabels": {"kubernetes.io/metadata.name": "kube-system"}
                            },
                            "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}},
                        }
                    ],
                    "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}],
                },
                {
                    "to": [{"ipBlock": {"cidr": f"{config.server_ip}/32"}}],
                    "ports": [{"protocol": "TCP", "port": 443}],
                },
                {
                    "to": [
                        {
                            "namespaceSelector": {
                                "matchLabels": {"kubernetes.io/metadata.name": "egress-proxy"}
                            },
                            "podSelector": {"matchLabels": {"app": "squid"}},
                        }
                    ],
                    "ports": [{"protocol": "TCP", "port": config.proxy_port}],
                },
            ],
        },
    }
    quota = {
        "apiVersion": "v1",
        "kind": "ResourceQuota",
        "metadata": meta("no-shared-services-priority"),
        "spec": {
            "hard": {"pods": "0"},
            "scopeSelector": {
                "matchExpressions": [
                    {
                        "operator": "In",
                        "scopeName": "PriorityClass",
                        "values": ["switch-shared-services"],
                    }
                ]
            },
        },
    }
    account = {
        "apiVersion": "v1",
        "kind": "ServiceAccount",
        "metadata": meta("box"),
        "automountServiceAccountToken": False,
    }
    ca = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": meta(CA_CONFIGMAP),
        "data": {"ca.crt": config.ca_cert},
    }
    settings = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": meta(SETTINGS_CONFIGMAP),
        "data": {"managed-settings.json": config.managed_settings},
    }
    # Both empty: the scaler writes the enrolment code just before the first start, and allow-lists writes
    # the proxy logins once the box is in the box map. This never holds either.
    enrol = {"apiVersion": "v1", "kind": "Secret", "metadata": meta(ENROL_SECRET), "type": "Opaque"}
    login = {"apiVersion": "v1", "kind": "Secret", "metadata": meta(LOGIN_SECRET), "type": "Opaque"}

    def disk(name: str, storage: str) -> dict:
        return {
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": meta(name),
            "spec": {
                "accessModes": ["ReadWriteOnce"],
                "storageClassName": config.storage_class,
                "resources": {"requests": {"storage": storage}},
            },
        }

    box = {
        "apiVersion": "apps/v1",
        "kind": "StatefulSet",
        "metadata": {
            **meta("box"),
            "labels": {"app": "switch-box", "switch.dev/user": user_name},
        },
        "spec": {
            "replicas": 0,  # the scaler starts it, once Core wants it running
            "serviceName": "box",
            "selector": {"matchLabels": {"app": "switch-box"}},
            "template": {
                "metadata": {"labels": {"app": "switch-box", "switch.dev/user": user_name}},
                "spec": _box_pod_spec(config, size, user_name, zone_for(action.user, config.zones)),
            },
        },
    }
    # The eviction watch: one binding for the controller's account to read
    # this box's pod and events. Its name, roleRef and subject are fixed here and pinned by policy P8.
    watch = {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "RoleBinding",
        "metadata": meta(BOX_WATCH),
        "roleRef": {
            "apiGroup": "rbac.authorization.k8s.io",
            "kind": "ClusterRole",
            "name": BOX_WATCH,
        },
        "subjects": [
            {"kind": "ServiceAccount", "name": CONTROLLER_ACCOUNT, "namespace": CONTROLLER_HOME}
        ],
    }
    # Restart's rights (template v2.3): the restart pod runs as the controller's account today, so it is the one
    # subject. Its name, roleRef and subject are fixed here and pinned by policy P8, as the watch binding's are.
    restart = {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "RoleBinding",
        "metadata": meta(BOX_RESTART),
        "roleRef": {
            "apiGroup": "rbac.authorization.k8s.io",
            "kind": "ClusterRole",
            "name": BOX_RESTART,
        },
        "subjects": [
            {"kind": "ServiceAccount", "name": CONTROLLER_ACCOUNT, "namespace": CONTROLLER_HOME}
        ],
    }
    problems = check_box_pod_spec(box["spec"]["template"]["spec"], config.split)
    if problems:
        raise ProvisionFailed("object_refused")
    return [
        ("namespace_ready", namespace),
        ("policies_ready", default_deny),
        ("policies_ready", egress),
        ("objects_ready", quota),
        ("objects_ready", account),
        ("objects_ready", ca),
        ("objects_ready", settings),
        ("objects_ready", enrol),
        ("objects_ready", login),
        ("objects_ready", disk("data-controller", CONTROLLER_DISK)),
        ("objects_ready", disk("data-agents", size.disk)),
        ("objects_ready", watch),
        ("objects_ready", restart),
        ("objects_ready", box),
    ]


def _proxy_env(name: str, key: str) -> dict:
    return {"name": name, "valueFrom": {"secretKeyRef": {"name": LOGIN_SECRET, "key": key}}}


def _proxy_envs(key: str) -> list[dict]:
    """The four proxy variables, each by reference to this box's own login (allow-lists v3.5): never a plain value."""
    return [
        _proxy_env(name, key) for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
    ]


_HARDENED = {
    "allowPrivilegeEscalation": False,
    "readOnlyRootFilesystem": True,
    "capabilities": {"drop": ["ALL"]},
}


def _box_pod_spec(config: OperatorConfig, size: BoxSize, user_name: str, zone: str) -> dict:
    """The split box (two containers on loopback, two disks), as split template v2 has it. Fixed apart from the image
    digest, the agents' size and the server address, all from the operator's own configuration."""
    no_proxy = f"{config.server_ip},.svc,.cluster.local,localhost,127.0.0.1"
    proxy_url = f"http://{config.proxy_host}:{config.proxy_port}"
    common = [
        {"name": "NO_PROXY", "value": no_proxy},
        {"name": "no_proxy", "value": no_proxy},
        {"name": "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "value": "1"},
    ]
    memory_limit = _bytes(CONTROLLER_MEMORY_LIMIT) + _bytes(size.memory_limit)
    controller = {
        "name": "controller",
        "image": config.image,
        "imagePullPolicy": "IfNotPresent",
        "args": [
            "--launcher-address",
            "127.0.0.1:7420",
            "--agents-data-dir",
            "/data/agents",
            "--agents-workspaces",
            "/data/agents/workspaces",
        ],  # fmt: skip
        "securityContext": {"runAsUser": 2001, "runAsGroup": 2000, **_HARDENED},
        "env": [
            {"name": "SWITCH_SERVER", "value": config.server_url},
            {"name": "SWITCH_MACHINE_NAME", "value": MACHINE_NAME},
            {
                "name": "SWITCH_MACHINE_DESCRIPTION",
                "value": f"hosted-agents-test pod ({user_name})",
            },
            {"name": "SWITCH_CONTROLLER_DATA_DIR", "value": "/data/controller"},
            {"name": "HOME", "value": "/data/controller/home"},
            {"name": "NODE_EXTRA_CA_CERTS", "value": "/etc/switch/ca/ca.crt"},
            {"name": "SWITCH_SESSION_PARK_AFTER_MS", "value": "900000"},
            {"name": "SWITCH_CONTROLLER_REST_AFTER_MS", "value": "600000"},
            {"name": "SWITCH_SESSION_START_CONCURRENCY", "value": "3"},
            {"name": "SWITCH_SESSION_START_RESERVE_BYTES", "value": "536870912"},
            {"name": "SWITCH_CONTROLLER_PROVIDER_GATEWAY", "value": "1"},
            {"name": "SWITCH_CONTROLLER_RESERVE_BYTES", "value": "268435456"},
            # The controller's gateway takes its own login; its other traffic uses the plain proxy URL.
            _proxy_env("SWITCH_CONTROLLER_GATEWAY_PROXY", "ctl_https_proxy"),
            *(
                {"name": name, "value": proxy_url}
                for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")
            ),
            *common,
            {"name": "SWITCH_BOX_MEMORY_LIMIT_BYTES", "value": str(memory_limit)},
        ],
        "resources": {
            "requests": {"cpu": "100m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": CONTROLLER_MEMORY_LIMIT},
        },
        "volumeMounts": [
            {"name": "data-controller", "mountPath": "/data/controller"},
            {"name": "tmp-controller", "mountPath": "/tmp"},
            {"name": "ca", "mountPath": "/etc/switch/ca", "readOnly": True},
            {"name": "enrol", "mountPath": "/etc/switch/enrol", "readOnly": True},
        ],
    }
    agents = {
        "name": "agents",
        "image": config.image,
        "imagePullPolicy": "IfNotPresent",
        "command": [
            "/usr/bin/tini",
            "-g",
            "--",
            "switch-agent-controller",
            "launcher",
            "--data-dir",
            "/data/agents",
            "--workspaces",
            "/data/agents/workspaces",
            "--controller-address",
            "127.0.0.1:7420",
        ],  # fmt: skip
        "securityContext": {"runAsUser": 2000, "runAsGroup": 2000, **_HARDENED},
        "env": [
            {"name": "HOME", "value": "/data/agents/home"},
            {"name": "NODE_EXTRA_CA_CERTS", "value": "/etc/switch/ca/ca.crt"},
            *_proxy_envs("https_proxy"),
            *common,
        ],
        "resources": {
            "requests": {"cpu": size.cpu_request, "memory": size.memory_request},
            "limits": {"cpu": size.cpu_limit, "memory": size.memory_limit},
        },
        "volumeMounts": [
            {"name": "data-agents", "mountPath": "/data/agents"},
            {"name": "tmp-agents", "mountPath": "/tmp"},
            {"name": "ca", "mountPath": "/etc/switch/ca", "readOnly": True},
            {"name": "claude-managed", "mountPath": "/etc/claude-code", "readOnly": True},
        ],
    }
    return {
        "runtimeClassName": "gvisor",
        "serviceAccountName": "box",
        "automountServiceAccountToken": False,
        "enableServiceLinks": False,
        "hostname": user_name,
        "terminationGracePeriodSeconds": 60,
        "affinity": {
            "podAntiAffinity": {
                "preferredDuringSchedulingIgnoredDuringExecution": [
                    {
                        "weight": 100,
                        "podAffinityTerm": {
                            "topologyKey": "kubernetes.io/hostname",
                            "labelSelector": {"matchLabels": {"app": "switch-box"}},
                            "namespaceSelector": {
                                "matchExpressions": [
                                    {"key": "switch.dev/user", "operator": "Exists"}
                                ]
                            },
                        },
                    }
                ]
            },
        },
        # The zone keeps the box beside its disks: they bind where the pod first lands (template v2.1).
        "nodeSelector": {"switch.dev/pool": "agents", "topology.kubernetes.io/zone": zone},
        "securityContext": {
            "runAsNonRoot": True,
            "fsGroup": 2000,
            "fsGroupChangePolicy": "OnRootMismatch",
            "seccompProfile": {"type": "RuntimeDefault"},
        },
        "containers": [controller, agents],
        "volumes": [
            {"name": "data-controller", "persistentVolumeClaim": {"claimName": "data-controller"}},
            {"name": "data-agents", "persistentVolumeClaim": {"claimName": "data-agents"}},
            {"name": "tmp-controller", "emptyDir": {"sizeLimit": "512Mi"}},
            {"name": "tmp-agents", "emptyDir": {"sizeLimit": "2Gi"}},
            {"name": "ca", "configMap": {"name": CA_CONFIGMAP}},
            {"name": "enrol", "secret": {"secretName": ENROL_SECRET, "optional": True}},
            {"name": "claude-managed", "configMap": {"name": SETTINGS_CONFIGMAP}},
        ],
    }


# Fields the cluster or the existing parts change after creation, so they never count as a mismatch: the scaler
# scales the box, and the scaler and allow-lists fill the two Secrets.
_IGNORED = {
    "StatefulSet": (("spec", "replicas"),),
    "Secret": (("data",), ("stringData",)),
}


def _without(obj: dict, paths: Sequence[tuple[str, ...]]) -> dict:
    out = dict(obj)
    for path in paths:
        node: Any = out
        for key in path[:-1]:
            if not isinstance(node, dict) or key not in node:
                break
            node[key] = dict(node[key])
            node = node[key]
        else:
            if isinstance(node, dict):
                node.pop(path[-1], None)
    return out


def contains(existing: Any, wanted: Any) -> bool:
    """Whether everything in `wanted` is in `existing`, which may also hold the cluster's own defaults."""
    if isinstance(wanted, dict):
        return isinstance(existing, dict) and all(
            k in existing and contains(existing[k], v) for k, v in wanted.items()
        )
    if isinstance(wanted, list):
        return (
            isinstance(existing, list)
            and len(existing) == len(wanted)
            and all(contains(e, w) for e, w in zip(existing, wanted, strict=True))
        )
    return existing == wanted


def matches(existing: dict, wanted: dict) -> bool:
    paths = _IGNORED.get(wanted["kind"], ())
    trimmed = _without(wanted, paths)
    return contains(existing, {k: v for k, v in trimmed.items() if k not in ("apiVersion", "kind")})


# A box made earlier may since have been rolled to a newer image or resized by platform, and this has no right to
# update anything. So on an existing box those parts are bounded rather than exact:
# each image pinned by digest and on `allowed_images`; the agents container's resources, the
# memory-limit setting and the agents disk all equal one configured size. Everything else must match exactly.
AGENTS_DISK = "data-agents"
MEMORY_LIMIT_ENV = "SWITCH_BOX_MEMORY_LIMIT_BYTES"


# What the API server fills in on a StatefulSet's spec when it stores one, by path ("*" is any list item). On an
# existing box the whole spec is compared strictly: every key this asks for must hold exactly its value, and any
# other key (an init container, `privileged`, an added capability, a node affinity, an extra node selector, an
# annotation on the pod template, ...) is a difference unless it is listed here and holds what the API server puts
# there. `contains` alone would let all of those through.
def _is_whole_number(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_update_strategy(value: Any) -> bool:
    if value == {"type": "OnDelete"}:
        return True
    return (
        isinstance(value, dict)
        and value.get("type") == "RollingUpdate"
        and set(value) <= {"type", "rollingUpdate"}
        and value.get("rollingUpdate", {"partition": 0})
        in (
            {"partition": 0},
            {"partition": 0, "maxUnavailable": 1},
        )  # the latter: MaxUnavailableStatefulSet
    )


RESTARTED_AT = "kubectl.kubernetes.io/restartedAt"
_TIMESTAMP_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})"
)


def _is_restart_mark(value: Any) -> bool:
    """`kubectl rollout restart` stamps the pod template with this one annotation, a timestamp. It changes nothing
    about the pod, so a box restarted that way stays retryable (platform). Nothing else may sit beside it."""
    return (
        isinstance(value, dict)
        and set(value) == {RESTARTED_AT}
        and isinstance(value[RESTARTED_AT], str)
        and _TIMESTAMP_RE.fullmatch(value[RESTARTED_AT]) is not None
    )


@dataclass(frozen=True)
class SameAs:
    """A default the API server copies from a sibling key: it must equal what this asked for there."""

    sibling: str


_SPEC_DEFAULTS: dict[tuple[str, ...], Any] = {
    ("podManagementPolicy",): "OrderedReady",
    ("revisionHistoryLimit",): _is_whole_number,
    ("minReadySeconds",): 0,
    ("updateStrategy",): _is_update_strategy,
    ("persistentVolumeClaimRetentionPolicy",): {"whenDeleted": "Retain", "whenScaled": "Retain"},
    ("template", "metadata", "creationTimestamp"): None,
    ("template", "metadata", "annotations"): _is_restart_mark,
    ("template", "spec", "restartPolicy"): "Always",
    ("template", "spec", "dnsPolicy"): "ClusterFirst",
    ("template", "spec", "schedulerName"): "default-scheduler",
    # The old field, which the API server fills from `serviceAccountName`.
    ("template", "spec", "serviceAccount"): SameAs("serviceAccountName"),
    ("template", "spec", "containers", "*", "terminationMessagePath"): "/dev/termination-log",
    ("template", "spec", "containers", "*", "terminationMessagePolicy"): "File",
    ("template", "spec", "volumes", "*", "configMap", "defaultMode"): 420,
    ("template", "spec", "volumes", "*", "secret", "defaultMode"): 420,
}


def _default_allows(path: tuple[str, ...], value: Any, wanted_parent: dict) -> bool:
    for pattern, allowed in _SPEC_DEFAULTS.items():
        if len(pattern) == len(path) and all(
            p in ("*", k) for p, k in zip(pattern, path, strict=True)
        ):
            if isinstance(allowed, SameAs):
                if allowed.sibling not in wanted_parent:
                    return False
                allowed = wanted_parent[allowed.sibling]
            elif callable(allowed):
                return bool(allowed(value))
            return same_strictly(value, allowed, ("(default)",))  # a path no default matches
    return False


def same_strictly(existing: Any, wanted: Any, path: tuple[str, ...] = ()) -> bool:
    """`existing` is exactly `wanted`, at every depth, apart from keys `_SPEC_DEFAULTS` lists at their default."""
    if isinstance(wanted, dict):
        if not isinstance(existing, dict):
            return False
        for key, value in existing.items():
            if key in wanted:
                if not same_strictly(value, wanted[key], (*path, key)):
                    return False
            elif not _default_allows((*path, key), value, wanted):
                return False
        return all(key in existing for key in wanted)
    if isinstance(wanted, list):
        return (
            isinstance(existing, list)
            and len(existing) == len(wanted)
            and all(
                same_strictly(e, w, (*path, "*")) for e, w in zip(existing, wanted, strict=True)
            )
        )
    return type(existing) is type(wanted) and existing == wanted


def existing_images(existing: dict) -> list[Any]:
    """Every image the existing StatefulSet's pod would run, init and ephemeral containers included."""
    spec = existing.get("spec")
    template = spec.get("template") if isinstance(spec, dict) else None
    pod = template.get("spec") if isinstance(template, dict) else None
    if not isinstance(pod, dict):
        return [None]
    images: list[Any] = []
    for key in ("initContainers", "containers", "ephemeralContainers"):
        group = pod.get(key) or []
        if not isinstance(group, list):
            return [None]
        images += [c.get("image") if isinstance(c, dict) else None for c in group]
    return images or [None]


def _pvc_storage(pvc: Any) -> Any:
    try:
        return pvc["spec"]["resources"]["requests"]["storage"]
    except (KeyError, TypeError):
        return None


def _resources_for(size: BoxSize) -> dict:
    return {
        "requests": {"cpu": size.cpu_request, "memory": size.memory_request},
        "limits": {"cpu": size.cpu_limit, "memory": size.memory_limit},
    }


def _memory_limit_for(size: BoxSize) -> str:
    return str(_bytes(CONTROLLER_MEMORY_LIMIT) + _bytes(size.memory_limit))


def _box_as_sized(wanted: dict, existing: dict, size: BoxSize) -> dict:
    """The StatefulSet this would have made at `size`, with the existing (already allowed) image in each container."""
    out = copy.deepcopy(wanted)
    have = existing["spec"]["template"]["spec"]["containers"]
    for container, existing_container in zip(
        out["spec"]["template"]["spec"]["containers"], have, strict=True
    ):
        container["image"] = existing_container["image"]
        if container["name"] == "agents":
            container["resources"] = _resources_for(size)
        for env in container.get("env", []):
            if env.get("name") == MEMORY_LIMIT_ENV:
                env["value"] = _memory_limit_for(size)
    return out


def _containers(sts: Any) -> list[Any] | None:
    try:
        containers = sts["spec"]["template"]["spec"]["containers"]
    except (KeyError, TypeError):
        return None
    return containers if isinstance(containers, list) else None


def box_matches(
    existing: dict, wanted: dict, config: OperatorConfig, agents_disk: str | None
) -> bool:
    """An existing StatefulSet is this box's own when, for one configured size whose disk equals the agents disk's
    request, its whole spec is strictly what this would make at that size, with one allowed image in every container.
    The images must already have passed `config.image_allowed`. Its metadata must hold what this sets, and the scaler
    may have started it (one replica)."""
    have = _containers(existing)
    want = _containers(wanted)
    if have is None or want is None or len(have) != len(want):
        return False
    if not all(isinstance(c, dict) for c in have) or len({c.get("image") for c in have}) != 1:
        return False  # the template runs one image in both containers
    if not contains(existing.get("metadata"), wanted["metadata"]):
        return False
    replicas = existing["spec"].get("replicas")
    if replicas not in (0, 1) or isinstance(replicas, bool):
        return False
    for size in config.sizes.values():
        if size.disk != agents_disk:
            continue
        sized = _box_as_sized(wanted, existing, size)
        sized["spec"]["replicas"] = replicas
        if same_strictly(existing["spec"], sized["spec"]):
            return True
    return False


def agents_disk_matches(existing: dict, wanted: dict, config: OperatorConfig) -> bool:
    """The existing agents disk is this box's own when it matches exactly apart from its storage request, which
    must equal one configured size's disk. The StatefulSet's check then ties it to that same size."""
    storage = _pvc_storage(existing)
    if storage not in {size.disk for size in config.sizes.values()}:
        return False
    sized = copy.deepcopy(wanted)
    sized["spec"]["resources"]["requests"]["storage"] = storage
    return matches(existing, sized)


def with_box(
    current: Mapping[str, str], machine_id: str, namespace: str, ceiling: int
) -> dict[str, str] | None:
    """The box map with this box in it, or None when it's already there. Refused if the machine or the namespace is
    already someone else's, or the map holds the ceiling."""
    if current.get(machine_id) == namespace:
        return None
    if machine_id in current or namespace in current.values():
        raise ProvisionFailed("box_map_failed")
    if len(current) >= ceiling:
        raise ProvisionFailed("ceiling_reached")
    return {**current, machine_id: namespace}


class OperatorCore(Protocol):
    def claim(self) -> dict | None: ...
    def result(
        self,
        action_id: str,
        claim_token: str,
        result: str,
        namespace: str | None,
        failed_at: str | None,
    ) -> None: ...


class OperatorKube(Protocol):
    def create_or_get(
        self, obj: dict
    ) -> dict | None: ...  # None when created, else the existing object
    def box_map(self) -> tuple[dict[str, str], str]: ...  # the map and its resourceVersion
    def write_box_map(
        self, boxes: dict[str, str], resource_version: str
    ) -> None: ...  # BoxMapConflict on 409


class Refused(Exception):
    """The cluster refused a create (the account's rights or an admission policy)."""


# What the Kubernetes client answers for a Secret that already exists: the operator has no right to read any Secret,
# so it can't compare one. That's safe because both are made empty, and the namespace,
# made and checked first, already carries this machine's id.
EXISTS_UNREAD: dict = {}


BOX_MAP_TRIES = 5


class BoxOperator:
    def __init__(self, core: OperatorCore, kube: OperatorKube, config: OperatorConfig):
        self._core = core
        self._kube = kube
        self._config = config

    def run_once(self) -> bool:
        """Claims and makes at most one box. False when Core had nothing waiting."""
        raw = self._core.claim()
        if raw is None:
            return False
        try:
            action = ProvisionAction.parse(raw)
        except ActionError as error:
            # Core makes every action from its own checked ids, so this means a Core fault. It isn't reported: the
            # result would need a namespace this can't form, and Core refuses any other. The claim's lease runs out,
            # and Core ends the action as expired after its 15 minutes.
            logger.error("Provision action refused: bad %s", error)
            return True
        self.provision(action)
        return True

    def provision(self, action: ProvisionAction) -> None:
        namespace: str | None = None
        self._agents_disk: str | None = None  # the agents disk's storage request, made or found
        try:
            namespace = namespace_for(action.user)
            for step, obj in box_objects(action, self._config):
                self._make(step, obj)
            self._add_to_box_map(action.machine_id, namespace)
            self._core.result(action.action_id, action.claim_token, "done", namespace, None)
            logger.info(
                "Box made: action=%s machine=%s namespace=%s",
                action.action_id,
                action.machine_id,
                namespace,
            )
        except ProvisionFailed as failure:
            logger.warning(
                "Box not made: action=%s machine=%s failed at %s",
                action.action_id,
                action.machine_id,
                failure.code,
            )
            self._core.result(
                action.action_id, action.claim_token, "failed", namespace, failure.code
            )

    def _make(self, step: str, obj: dict) -> None:
        refused = (
            "name_refused"
            if step == "namespace_ready"
            else ("policy_refused" if step == "policies_ready" else "object_refused")
        )
        try:
            existing = self._kube.create_or_get(obj)
        except Refused:
            logger.warning("Create refused: %s %s", obj["kind"], obj["metadata"]["name"])
            raise ProvisionFailed(refused) from None
        if existing is EXISTS_UNREAD:
            if obj["kind"] != "Secret":
                raise ProvisionFailed(refused)  # only a Secret may come back unread
            return
        is_agents_disk = (
            obj["kind"] == "PersistentVolumeClaim" and obj["metadata"]["name"] == AGENTS_DISK
        )
        if existing is None:
            if is_agents_disk:
                self._agents_disk = _pvc_storage(obj)
            return
        if obj["kind"] == "StatefulSet":
            if not all(self._config.image_allowed(i) for i in existing_images(existing)):
                # Never logs the image itself: it's whatever was put there.
                logger.error(
                    "Box operator ALERT: an existing box runs an image that isn't pinned or allowed: namespace=%s",
                    obj["metadata"]["namespace"],
                )
                raise ProvisionFailed(refused)
            ours = box_matches(existing, obj, self._config, self._agents_disk)
        elif is_agents_disk:
            ours = agents_disk_matches(existing, obj, self._config)
            if ours:
                self._agents_disk = _pvc_storage(existing)
        else:
            ours = matches(existing, obj)
        if not ours:
            logger.warning(
                "Already there, and not ours: %s %s", obj["kind"], obj["metadata"]["name"]
            )
            raise ProvisionFailed(refused)

    def _add_to_box_map(self, machine_id: str, namespace: str) -> None:
        for _ in range(BOX_MAP_TRIES):
            boxes, version = self._kube.box_map()
            updated = with_box(boxes, machine_id, namespace, self._config.ceiling)
            if updated is None:
                return
            try:
                self._kube.write_box_map(updated, version)
                return
            except BoxMapConflict:
                continue
        raise ProvisionFailed("box_map_failed")
