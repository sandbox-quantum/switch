"""What the node gate creates for each check: its namespace's objects and its Jobs (see `node_gate`).

Everything here is built from the gate's configuration, which is checked when it loads: images pinned by digest, a
fixed in-cluster responder as the proxy check's "other workload" target (never a user's box), and the proxy check's
allow and deny list for this deployment. Each check namespace gets the same walls a user's box gets (default deny,
egress only to DNS, the server and the egress proxy), so the checks see what a box would see.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

GATE1_TAINT = "switch.dev/gate1"
LEVEL_TAINT = "switch.dev/level"
MANAGED_BY = "switch-node-gate"
CHECK_CLUSTER_ROLE = "switch-node-gate-check"  # the one role the gate may bind in a check namespace
NODE_ANNOTATION = "switch.dev/check-node"
CHECK_LABEL = "switch.dev/check"  # the label squid's NetworkPolicy admits for check namespaces

DIGEST_IMAGE_RE = re.compile(r"[a-z0-9][a-z0-9./-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}")
IPV4_RE = re.compile(r"(\d{1,3}\.){3}\d{1,3}")
LABEL_RE = re.compile(r"[A-Za-z0-9 ._:/()-]{1,64}")
URL_RE = re.compile(r"https?://[A-Za-z0-9._:\-/?=]+")  # __NODE_IP__ is filled inside the pod
DNS_NAME_RE = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?")

DENIED_ROUTES = [  # (label, host or NODE, port): gate 1's 16, unchanged from the watcher's
    ("public 93.184.215.14:80", "93.184.215.14", 80),
    ("IMDS 169.254.169.254:80", "169.254.169.254", 80),
    ("own node :10250", "NODE", 10250),
    ("own node :10256", "NODE", 10256),
    ("own node :22", "NODE", 22),
    ("own node :61678", "NODE", 61678),
    ("own node :8162", "NODE", 8162),
    ("own node :8163", "NODE", 8163),
    ("own node :80", "NODE", 80),
    ("own node :2703", "NODE", 2703),
    ("own node :4443", "NODE", 4443),
    ("own node :9808", "NODE", 9808),
    ("own node :10249", "NODE", 10249),
    ("own node :61679", "NODE", 61679),
    ("Pod Identity 169.254.170.23:80", "169.254.170.23", 80),
    ("public 1.1.1.1:443 direct", "1.1.1.1", 443),
]


class GateConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ProxyEntry:
    verdict: str  # ALLOW or DENY
    label: str
    url: str
    via_proxy: bool


@dataclass(frozen=True)
class GateConfig:
    python_image: str
    alpine_image: str
    server_ip: str  # the one address a box reaches directly, on 443
    proxy_host: str  # e.g. squid.egress-proxy.svc
    proxy_namespace: str  # where the egress proxy runs: the only namespace a check pod may reach
    proxy_port: int
    responder_url: str  # the fixed in-cluster target that must stay unreachable from a box
    proxy_entries: tuple[ProxyEntry, ...]  # this deployment's allow and deny list
    gate_namespace: str  # where the gate's own service account lives
    # Subnets accepted besides those tagged switch:level=l3. The watcher also accepted the base node subnet
    # (terraform's node_subnet_id), so put it here if l3 machines can land there.
    extra_l3_subnets: tuple[str, ...] = ()
    max_parallel: int = 4
    # The gate's own proxy login (per-box allow-lists), `http://gate-check:<password>@host:port`, read from its
    # mounted Secret at start, never from the JSON config. Empty until the per-box lists are on.
    proxy_login: str = field(default="", repr=False)

    def all_proxy_entries(self) -> list[ProxyEntry]:
        """The deployment's list, plus the ones the gate always adds: the server direct, nothing public direct, and
        neither the responder nor the machine itself reachable, direct or through the proxy."""
        fixed = [
            ProxyEntry(
                "ALLOW",
                f"server direct {self.server_ip}",
                f"https://{self.server_ip}/health",
                False,
            ),
            ProxyEntry(
                "DENY", "public direct (no proxy) example.com", "https://example.com/", False
            ),
            ProxyEntry("DENY", "direct the responder", self.responder_url, False),
            ProxyEntry("DENY", "via proxy the responder", self.responder_url, True),
            ProxyEntry("DENY", "via proxy own node :10250", "https://__NODE_IP__:10250/pods", True),
            ProxyEntry(
                "DENY",
                "via proxy metadata 169.254.169.254",
                "https://169.254.169.254/latest/meta-data/",
                True,
            ),
        ]
        return fixed + list(self.proxy_entries)


def gate_config_from(raw: Mapping) -> GateConfig:
    """The gate's configuration, refused whole if anything is off: no guessing at a check's shape."""

    def need(key: str, pattern: re.Pattern[str], what: str) -> str:
        value = raw.get(key)
        if not isinstance(value, str) or not pattern.fullmatch(value):
            raise GateConfigError(f"{key} must be {what}")
        return value

    python_image = need("python_image", DIGEST_IMAGE_RE, "an image pinned by sha256 digest")
    alpine_image = need("alpine_image", DIGEST_IMAGE_RE, "an image pinned by sha256 digest")
    server_ip = need("server_ip", IPV4_RE, "an IPv4 address")
    proxy_host = need("proxy_host", DNS_NAME_RE, "a host name")
    proxy_namespace = need(
        "proxy_namespace", re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"), "a namespace name"
    )
    responder_url = need("responder_url", URL_RE, "an http(s) URL")
    gate_namespace = need(
        "gate_namespace", re.compile(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"), "a namespace name"
    )
    port = raw.get("proxy_port")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise GateConfigError("proxy_port must be a port number")
    entries = []
    for item in raw.get("proxy_entries") or []:
        verdict, label, url, via = (
            item.get("verdict"),
            item.get("label"),
            item.get("url"),
            item.get("via_proxy"),
        )
        if verdict not in ("ALLOW", "DENY") or not isinstance(via, bool):
            raise GateConfigError(
                "each proxy entry needs verdict ALLOW or DENY and via_proxy true or false"
            )
        if not isinstance(label, str) or not LABEL_RE.fullmatch(label):
            raise GateConfigError("a proxy entry's label has characters it may not")
        if not isinstance(url, str) or not URL_RE.fullmatch(url):
            raise GateConfigError("a proxy entry's url must be an http(s) URL")
        entries.append(ProxyEntry(verdict, label, url, via))
    subnets = raw.get("extra_l3_subnets") or []
    if not all(isinstance(s, str) and re.fullmatch(r"subnet-[0-9a-f]+", s) for s in subnets):
        raise GateConfigError("extra_l3_subnets must be subnet ids")
    max_parallel = raw.get("max_parallel", 4)
    if not isinstance(max_parallel, int) or not 1 <= max_parallel <= 16:
        raise GateConfigError("max_parallel must be 1 to 16")
    return GateConfig(
        python_image,
        alpine_image,
        server_ip,
        proxy_host,
        proxy_namespace,
        port,
        responder_url,
        tuple(entries),
        gate_namespace,
        tuple(subnets),
        max_parallel,
    )


# ---- a check namespace ----


def namespace_objects(
    ns: str, node: str, config: GateConfig, gate_sa: str = "switch-node-gate"
) -> list[dict]:
    """The namespace and the walls it gets, as a box's: restricted pod security, no shared-services priority, default
    deny, and egress to DNS, the server on 443 and the egress proxy only. Plus the one RoleBinding that lets the gate
    run its Jobs there, to the one fixed role."""
    labels = {
        "app.kubernetes.io/managed-by": MANAGED_BY,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
        # The gate's own label, which squid's NetworkPolicy admits by name (its proposed entry:
        # switch.dev/check present, switch.dev/user absent). Without it the proxy check's ALLOW lines could
        # never be reached and every machine would fail. Never switch.dev/user: a check namespace isn't a box.
        CHECK_LABEL: ns.removeprefix("agents-"),
    }
    return [
        {
            "apiVersion": "v1",
            "kind": "Namespace",
            "metadata": {"name": ns, "labels": labels, "annotations": {NODE_ANNOTATION: node}},
        },
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "RoleBinding",
            "metadata": {"name": "switch-node-gate", "namespace": ns},
            "roleRef": {
                "apiGroup": "rbac.authorization.k8s.io",
                "kind": "ClusterRole",
                "name": CHECK_CLUSTER_ROLE,
            },
            "subjects": [
                {"kind": "ServiceAccount", "name": gate_sa, "namespace": config.gate_namespace}
            ],
        },
        {
            "apiVersion": "v1",
            "kind": "ResourceQuota",
            "metadata": {"name": "no-shared-services-priority", "namespace": ns},
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
        },
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": {"name": "default-deny", "namespace": ns},
            "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
        },
        {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": {"name": "agent-egress", "namespace": ns},
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
                                    "matchLabels": {
                                        "kubernetes.io/metadata.name": config.proxy_namespace
                                    }
                                },
                                "podSelector": {"matchLabels": {"app": "squid"}},
                            }
                        ],
                        "ports": [{"protocol": "TCP", "port": config.proxy_port}],
                    },
                ],
            },
        },
    ]


# ---- the Jobs ----


def _job(
    name: str,
    ns: str,
    node: str,
    image: str,
    script: str,
    env: list[dict] | None = None,
    python: bool = True,
    ttl: int = 600,
) -> dict:
    """One check: pinned to the machine, tolerating only the gate and l3 taints, under gVisor, non-root, no token, no
    host access, and gone 10 minutes after it ends."""
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": name,
            "namespace": ns,
            "labels": {"app.kubernetes.io/managed-by": MANAGED_BY},
        },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 300,
            "ttlSecondsAfterFinished": ttl,
            "template": {
                "metadata": {
                    "labels": {"app.kubernetes.io/managed-by": MANAGED_BY, "switch.dev/check": name}
                },
                "spec": {
                    "nodeName": node,
                    "runtimeClassName": "gvisor",
                    "restartPolicy": "Never",
                    "automountServiceAccountToken": False,
                    "enableServiceLinks": False,
                    "tolerations": [
                        {
                            "key": GATE1_TAINT,
                            "operator": "Equal",
                            "value": "pending",
                            "effect": "NoSchedule",
                        },
                        {
                            "key": LEVEL_TAINT,
                            "operator": "Equal",
                            "value": "l3",
                            "effect": "NoSchedule",
                        },
                    ],
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 1000,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [
                        {
                            "name": "check",
                            "image": image,
                            "command": ["python3", "-u", "-c", script]
                            if python
                            else ["sh", "-c", script],
                            "env": env or [],
                            "resources": {
                                "requests": {"cpu": "50m", "memory": "64Mi"},
                                "limits": {"cpu": "200m", "memory": "128Mi"},
                            },
                            "securityContext": {
                                "allowPrivilegeEscalation": False,
                                "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]},
                            },
                        }
                    ],
                },
            },
        },
    }


NODE_IP_ENV = {"name": "NODE_IP", "valueFrom": {"fieldRef": {"fieldPath": "status.hostIP"}}}

FIRST_SECOND = """
import time, socket, os, ssl, urllib.request as u
T0=time.time(); n=os.environ["NODE_IP"]; ROUTES=__ROUTES__; SERVER=os.environ["SERVER_IP"]
def tcp(h,p,to=1.5):
    s=socket.socket(); s.settimeout(to)
    try: s.connect((h,p)); return "OPEN"
    except Exception as e: return "blocked("+type(e).__name__+")"
    finally: s.close()
ctx=ssl._create_unverified_context(); dns=srv=None
while time.time()-T0<60 and (dns is None or srv is None):
    if dns is None:
        try: socket.gethostbyname(os.environ["PROXY_HOST"]); dns=time.time()-T0
        except Exception: pass
    if srv is None:
        try: u.urlopen("https://%s/health" % SERVER,context=ctx,timeout=1); srv=time.time()-T0
        except Exception: pass
    time.sleep(0.25)
print(f"DNS works from t={dns}s ; test server works from t={srv}s" if srv is not None else "test server NOT reached")
print(f"t={time.time()-T0:5.2f}s  -- denied routes after policy attached --")
for label,h,p in ROUTES:
    print(f"t={time.time()-T0:5.2f}s  {label:30} {tcp(n if h=='NODE' else h,p,4)}")
"""

KUBELET = """
import time, ssl, os, urllib.request as u
time.sleep(30)
ctx=ssl._create_unverified_context()
for path in ["/pods","/healthz","/metrics"]:
    try: r=u.urlopen(f"https://{os.environ['NODE_IP']}:10250{path}",context=ctx,timeout=5); print(path,"HTTP",r.status,"(BAD: data returned)")
    except Exception as e: print(path, str(e)[:80])
"""

IMDS = """
import urllib.request as u
try:
    r=u.urlopen(u.Request("http://169.254.169.254/latest/api/token",method="PUT",headers={"X-aws-ec2-metadata-token-ttl-seconds":"60"}),timeout=5)
    print("IMDSv2 TOKEN OBTAINED (BAD):", len(r.read()), "bytes")
except Exception as e:
    print("IMDSv2 token refused (good):", type(e).__name__, str(e)[:100])
"""

PROXY = """
import json, os, time, ssl, urllib.request as u
time.sleep(30)
P={"https": os.environ.get("PROXY_URL") or "http://%s:%s" % (os.environ["PROXY_HOST"], os.environ["PROXY_PORT"])}
for verdict,label,url,via in json.loads(os.environ["PLAN"]):
    url=url.replace("__NODE_IP__", os.environ["NODE_IP"])
    op=u.build_opener(u.ProxyHandler(P if via else {}), u.HTTPSHandler(context=ssl._create_unverified_context()))
    try: r=op.open(url,timeout=8); res=f"reached (HTTP {r.status})"
    except u.HTTPError as e: res=f"reached (HTTP {e.code})"
    except Exception as e: res=f"BLOCKED: {str(e)[:70]}"
    print(f"{verdict:6} {label:52} {res}", flush=True)
"""

RUNSC = "uname -sr; dmesg 2>/dev/null | head -3"


def check_jobs(check: str, ns: str, node: str, config: GateConfig) -> list[dict]:
    """The Jobs for one check, in the order their results are read: gate 1 is first-second, kubelet, imds."""
    common_env = [
        NODE_IP_ENV,
        {"name": "SERVER_IP", "value": config.server_ip},
        {"name": "PROXY_HOST", "value": config.proxy_host},
        {"name": "PROXY_PORT", "value": str(config.proxy_port)},
    ]
    if check == "gate1":
        return [
            _job(
                "first-second-check",
                ns,
                node,
                config.python_image,
                FIRST_SECOND.replace("__ROUTES__", json.dumps(DENIED_ROUTES)),
                common_env,
            ),
            _job("kubelet-check", ns, node, config.python_image, KUBELET, common_env),
            _job("imds-hop-check", ns, node, config.python_image, IMDS, common_env),
        ]
    if check == "proxy":
        plan = [[e.verdict, e.label, e.url, e.via_proxy] for e in config.all_proxy_entries()]
        env = common_env + [{"name": "PLAN", "value": json.dumps(plan)}]
        if config.proxy_login:
            # The gate's login sits in this Job's env, so the Job is gone a minute
            # after it ends rather than ten; the namespace is deleted straight after the check anyway.
            env.append({"name": "PROXY_URL", "value": config.proxy_login})
            return [_job("proxy-check", ns, node, config.python_image, PROXY, env, ttl=60)]
        return [_job("proxy-check", ns, node, config.python_image, PROXY, env)]
    if check == "runsc":
        return [_job("runsc-check", ns, node, config.alpine_image, RUNSC, python=False)]
    raise ValueError(f"no such check: {check}")
