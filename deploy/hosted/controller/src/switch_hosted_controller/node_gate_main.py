"""The node gate's Kubernetes and EC2 clients, and its loop (`switch-node-gate`).

It runs in the cluster as one replica, under its own service account (RBAC and the admission policy in
`deploy/hosted/gate/`) and its own AWS identity, which may only call `ec2:DescribeInstances` and
`ec2:DescribeSubnets`. Its configuration is one JSON file (`SWITCH_NODE_GATE_CONFIG`), refused whole if anything in
it is off.
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import ssl
import time
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPSHandler, Request, build_opener

from .node_gate import (
    CHECK_NAMESPACE_RE,
    LEVEL_L3,
    LEVEL_LABEL,
    CheckRun,
    GateNode,
    GateResult,
    Instance,
    NodeGate,
)
from .node_gate_jobs import (
    GATE1_TAINT,
    MANAGED_BY,
    GateConfig,
    check_jobs,
    gate_config_from,
    namespace_objects,
)

logger = logging.getLogger(__name__)

PROXY_LOGIN_RE = re.compile(r"http://gate-check:[A-Za-z0-9_-]{20,}@[a-z0-9.-]+:[0-9]{1,5}")

SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")
CALL_TIMEOUT_S = 10.0
JOB_WAIT_S = 300.0
BINDING_TRIES = 5
FAILED_ANNOTATION = "switch.dev/gate-result"
PARTIAL_METADATA = "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1"
STUCK_AFTER_S = 600.0  # a Ready machine still tainted this long raises the alert


def _epoch(stamp: str | None) -> float | None:
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def gate_nodes_from_list(items: list[dict]) -> list[GateNode]:
    out = []
    for item in items:
        meta, spec, status = item.get("metadata", {}), item.get("spec", {}), item.get("status", {})
        ready = next(
            (c for c in status.get("conditions", []) or [] if c.get("type") == "Ready"), {}
        )
        ip = next(
            (
                a.get("address", "")
                for a in status.get("addresses", []) or []
                if a.get("type") == "InternalIP"
            ),
            "",
        )
        out.append(
            GateNode(
                name=meta.get("name", ""),
                ready=ready.get("status") == "True",
                tainted=any(t.get("key") == GATE1_TAINT for t in spec.get("taints", []) or []),
                internal_ip=ip,
                ready_since=_epoch(ready.get("lastTransitionTime")),
            )
        )
    return out


def untaint_patch(node: dict) -> list[dict] | None:
    """A JSON patch that removes the gate taint and nothing else: it tests the key at that index before removing it,
    so a node whose taints moved in between refuses the patch rather than losing another taint."""
    for i, taint in enumerate((node.get("spec") or {}).get("taints") or []):
        if taint.get("key") == GATE1_TAINT:
            return [
                {"op": "test", "path": f"/spec/taints/{i}/key", "value": GATE1_TAINT},
                {"op": "remove", "path": f"/spec/taints/{i}"},
            ]
    return None


class GateKubeApi:
    """The calls the gate makes, and no others. Every namespace it names is checked against the check pattern
    before any call, so a bug can't point it at anyone else's namespace."""

    def __init__(
        self,
        server: str,
        token: str,
        ca_file: str,
        config: GateConfig,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._server = server.rstrip("/")
        self._token = token
        self._ctx = ssl.create_default_context(cafile=ca_file)
        self._config = config
        self._sleep = sleep

    def _call(
        self,
        method: str,
        path: str,
        body=None,
        content_type: str = "application/json",
        accept: str = "application/json",
    ):
        req = Request(
            self._server + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": accept,
                "Content-Type": content_type,
            },
        )
        with build_opener(HTTPSHandler(context=self._ctx)).open(req, timeout=CALL_TIMEOUT_S) as r:
            raw = r.read()
            return json.loads(raw) if raw[:1] in (b"{", b"[") else raw.decode("utf-8", "replace")

    @staticmethod
    def _check_ns(name: str) -> str:
        if not CHECK_NAMESPACE_RE.fullmatch(name) or len(name) > 63:
            raise ValueError("not a check namespace")
        return name

    def gate_nodes(self) -> list[GateNode]:
        listed = self._call(
            "GET", f"/api/v1/nodes?labelSelector={quote(f'{LEVEL_LABEL}={LEVEL_L3}')}"
        )
        return gate_nodes_from_list(listed.get("items", []))

    def namespaces(self) -> list[str]:
        listed = self._call(
            "GET",
            f"/api/v1/namespaces?labelSelector={quote(f'app.kubernetes.io/managed-by={MANAGED_BY}')}",
        )
        return [item.get("metadata", {}).get("name", "") for item in listed.get("items", [])]

    def namespace_exists(self, name: str) -> bool:
        try:
            self._call("GET", f"/api/v1/namespaces/{self._check_ns(name)}")
            return True
        except HTTPError as error:
            if error.code == 404:
                return False
            raise

    def _create(self, obj: dict) -> None:
        kind, meta = obj["kind"], obj["metadata"]
        paths = {
            "Namespace": "/api/v1/namespaces",
            "RoleBinding": f"/apis/rbac.authorization.k8s.io/v1/namespaces/{meta.get('namespace')}/rolebindings",
            "ResourceQuota": f"/api/v1/namespaces/{meta.get('namespace')}/resourcequotas",
            "NetworkPolicy": f"/apis/networking.k8s.io/v1/namespaces/{meta.get('namespace')}/networkpolicies",
            "Job": f"/apis/batch/v1/namespaces/{meta.get('namespace')}/jobs",
        }
        if kind != "Namespace":
            self._check_ns(meta.get("namespace", ""))
        # Everything after the Namespace and its RoleBinding is allowed only through that new binding, which the API
        # server may take a moment to see: a 403 there is retried briefly, never anywhere else.
        tries = 1 if kind in ("Namespace", "RoleBinding") else BINDING_TRIES
        for attempt in range(tries):
            try:
                self._call("POST", paths[kind], obj)
                return
            except HTTPError as error:
                if error.code != 403 or attempt == tries - 1:
                    raise
                self._sleep(1)

    def run_check(self, node: GateNode, namespace: str, check: str) -> list[CheckRun]:
        """Creates the check's namespace and Jobs, waits for each to finish, and reads where it ran and its logs."""
        self._check_ns(namespace)
        for obj in namespace_objects(namespace, node.name, self._config):
            self._create(obj)
        jobs = check_jobs(check, namespace, node.name, self._config)
        for job in jobs:
            self._create(job)
        return [self._wait_and_read(namespace, job["metadata"]["name"]) for job in jobs]

    def _wait_and_read(self, ns: str, job: str) -> CheckRun:
        deadline = time.monotonic() + JOB_WAIT_S
        completed = False
        while time.monotonic() < deadline:
            status = self._call("GET", f"/apis/batch/v1/namespaces/{ns}/jobs/{job}").get(
                "status", {}
            )
            if status.get("succeeded"):
                completed = True
                break
            if status.get("failed"):
                break
            self._sleep(3)
        pods = self._call(
            "GET", f"/api/v1/namespaces/{ns}/pods?labelSelector={quote('job-name=' + job)}"
        ).get("items", [])
        if not pods:
            return CheckRun("", "", "", False)
        pod = pods[0]
        spec = pod.get("spec", {})
        logs = self._call(
            "GET", f"/api/v1/namespaces/{ns}/pods/{pod['metadata']['name']}/log?limitBytes=65536"
        )
        return CheckRun(
            spec.get("nodeName", ""),
            spec.get("runtimeClassName", ""),
            logs if isinstance(logs, str) else "",
            completed,
        )

    def mark_failed(self, node: GateNode, namespace: str) -> None:
        """An empty check namespace, the same as a real one less its walls, marking the machine as failed."""
        obj = namespace_objects(self._check_ns(namespace), node.name, self._config)[0]
        obj["metadata"]["annotations"][FAILED_ANNOTATION] = (
            "failed; a person looks before deleting this"
        )
        self._create(obj)

    def delete_namespace(self, name: str) -> None:
        try:
            self._call("DELETE", f"/api/v1/namespaces/{self._check_ns(name)}")
        except HTTPError as error:
            if error.code != 404:
                raise

    def pods_on(self, node: str) -> list[tuple[str, str]]:
        """Unfinished pods on one machine (namespace, owner kind): listed by node name only, and nothing else of
        their spec is kept."""
        selector = quote(f"spec.nodeName={node},status.phase!=Succeeded,status.phase!=Failed")
        # metadata only: the gate never pulls a pod's spec into memory
        listed = self._call(
            "GET", f"/api/v1/pods?fieldSelector={selector}", accept=PARTIAL_METADATA
        )
        out = []
        for item in listed.get("items", []):
            meta = item.get("metadata", {})
            owners = meta.get("ownerReferences") or [{}]
            out.append((meta.get("namespace", ""), owners[0].get("kind", "")))
        return out

    def untaint(self, node: str) -> None:
        current = self._call("GET", f"/api/v1/nodes/{quote(node)}")
        patch = untaint_patch(current)
        if patch is None:
            return  # already untainted
        self._call(
            "PATCH",
            f"/api/v1/nodes/{quote(node)}",
            patch,
            content_type="application/json-patch+json",
        )


class GateEc2Api:
    """Two read-only EC2 calls; nothing else is allowed by the gate's AWS identity."""

    def __init__(self, ec2, extra_l3_subnets: tuple[str, ...] = ()):
        self._ec2 = ec2
        self._extra = set(extra_l3_subnets)

    def instance_by_ip(self, ip: str) -> Instance | None:
        # Running only, and exactly one: a terminated instance can keep the same private address for a while.
        # Anything else reads as "no instance found", which fails the machine.
        found = self._ec2.describe_instances(
            Filters=[
                {"Name": "private-ip-address", "Values": [ip]},
                {"Name": "instance-state-name", "Values": ["running"]},
            ]
        )
        instances = [i for r in found.get("Reservations", []) for i in r.get("Instances", [])]
        if len(instances) != 1:
            return None
        (inst,) = instances
        options = inst.get("MetadataOptions", {})
        tags = {t.get("Key"): t.get("Value") for t in inst.get("Tags", []) or []}
        return Instance(
            http_tokens=options.get("HttpTokens", ""),
            hop_limit=int(options.get("HttpPutResponseHopLimit") or 0),
            public_ip=inst.get("PublicIpAddress"),
            subnet_id=inst.get("SubnetId", ""),
            level_tag=tags.get("switch:level"),
        )

    def l3_subnets(self) -> set[str]:
        found = self._ec2.describe_subnets(
            Filters=[{"Name": "tag:switch:level", "Values": [LEVEL_L3]}]
        )
        return {s.get("SubnetId", "") for s in found.get("Subnets", [])} | self._extra


def stuck_machines(nodes: list[GateNode], now: float, after_s: float = STUCK_AFTER_S) -> list[str]:
    """Ready machines still carrying the gate taint for longer than `after_s`, to alert on."""
    return [
        n.name
        for n in nodes
        if n.ready and n.tainted and n.ready_since is not None and now - n.ready_since > after_s
    ]


def run(
    gate: NodeGate,
    kube: GateKubeApi,
    interval: float = 10.0,
    stop: Callable[[], bool] = lambda: False,
) -> None:
    alerted: set[str] = set()
    while not stop():
        try:
            gate.tick()
            for name in stuck_machines(kube.gate_nodes(), time.time()):
                if name not in alerted:
                    alerted.add(name)
                    logger.error(
                        "Node gate ALERT: %s has been Ready and still tainted for over %d s",
                        name,
                        STUCK_AFTER_S,
                    )
        except Exception:
            logger.exception("Node gate pass failed; retrying")
        time.sleep(interval)
    gate.shutdown()


def record(result: GateResult) -> None:
    """One structured line per machine, for the metric and the evidence: ids, times and check names only."""
    logger.info(
        "node_gate_result %s",
        json.dumps(
            {
                "node": result.node,
                "passed": result.passed,
                "took_s": round(result.took_s, 1),
                "ready_to_decided_s": None
                if result.from_ready_s is None
                else round(result.from_ready_s, 1),
                "problems": result.problems,
            }
        ),
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    import boto3  # imported here so the tests need no AWS

    config_path = os.environ.get("SWITCH_NODE_GATE_CONFIG", "")
    if not config_path:
        logger.error("SWITCH_NODE_GATE_CONFIG is not set")
        return 2
    config = gate_config_from(json.loads(Path(config_path).read_text()))
    login_path = os.environ.get("SWITCH_NODE_GATE_PROXY_LOGIN", "")
    if login_path:
        login = Path(login_path).read_text().strip()
        if not PROXY_LOGIN_RE.fullmatch(login):
            logger.error(
                "SWITCH_NODE_GATE_PROXY_LOGIN does not hold a proxy login URL"
            )  # never the value
            return 2
        config = replace(config, proxy_login=login)
    server = f"https://{os.environ['KUBERNETES_SERVICE_HOST']}:{os.environ.get('KUBERNETES_SERVICE_PORT', '443')}"
    kube = GateKubeApi(
        server, (SA_DIR / "token").read_text().strip(), str(SA_DIR / "ca.crt"), config
    )
    ec2 = GateEc2Api(boto3.client("ec2"), config.extra_l3_subnets)
    gate = NodeGate(
        kube,
        ec2,
        config.max_parallel,
        on_result=record,
        proxy_lines=len(config.all_proxy_entries()),
    )
    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__("now", True))
    logger.info(
        "Node gate on: max_parallel=%d, proxy checks=%d",
        config.max_parallel,
        len(config.all_proxy_entries()),
    )
    run(gate, kube, stop=lambda: stopping["now"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
