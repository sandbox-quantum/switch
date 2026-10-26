"""Everything the harness asks of Kubernetes, all of it read-only.

`kubectl get` to find the switch-core pods and the Secret holding the admin
login, `kubectl exec` to run the sampler inside the pods, and, only with
`--via port-forward`, `kubectl port-forward` to reach the pods without the
tailnet. Nothing here creates, changes, scales or restarts a Kubernetes
object.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

CORE_SELECTOR = "app.kubernetes.io/component=switch-core"
CORE_CONTAINER = "switch-core"
SAMPLER = Path(__file__).with_name("pod_sampler.py")

# The pilot's namespace and its public hostnames. A load test never goes there.
PILOT_NAMESPACE = "switch"
PILOT_HOST_LABELS = {"switch-gateway", "switch-api"}


class Refused(SystemExit):
    """A target the harness will not run against."""


def guard_target(namespace: str, *urls: str) -> None:
    """Refuse the pilot and anything that looks like prod, before any request."""
    if namespace == PILOT_NAMESPACE:
        raise Refused(f"refusing namespace {namespace!r}: that is the pilot")
    if "prod" in namespace.lower():
        raise Refused(f"refusing namespace {namespace!r}: looks like prod")
    for url in urls:
        if not url:
            continue
        host = (urlparse(url).hostname or "").lower()
        if host.split(".")[0] in PILOT_HOST_LABELS:
            raise Refused(f"refusing {url}: that is the pilot's hostname")
        if "prod" in host:
            raise Refused(f"refusing {url}: looks like prod")


class Kube:
    def __init__(self, context: str, namespace: str) -> None:
        self.context = context
        self.namespace = namespace
        self.base = ["kubectl", "--context", context, "-n", namespace]

    def get_json(self, *args: str) -> dict:
        out = subprocess.run(
            [*self.base, "get", *args, "-o", "json"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if out.returncode != 0:
            raise RuntimeError(
                f"kubectl get {' '.join(args)}: {out.stderr.strip()[:300]}"
            )
        return json.loads(out.stdout)

    def core_pods(self) -> list[dict]:
        """The switch-core pods that are running, by name."""
        items = self.get_json("pods", "-l", CORE_SELECTOR)["items"]
        pods = []
        for p in items:
            if p["status"].get("phase") != "Running" or p["metadata"].get(
                "deletionTimestamp"
            ):
                continue
            statuses = p["status"].get("containerStatuses") or []
            pods.append(
                {
                    "name": p["metadata"]["name"],
                    "ready": all(s.get("ready") for s in statuses),
                    "restarts": sum(s.get("restartCount", 0) for s in statuses),
                    "node": p["spec"].get("nodeName"),
                }
            )
        return sorted(pods, key=lambda p: p["name"])

    def core_env(self) -> dict[str, dict]:
        """The switch-core container's environment, as declared (no values
        resolved): name to either {"value": ...} or {"secret": (name, key)}."""
        deploys = self.get_json("deployments", "-l", CORE_SELECTOR)["items"]
        if not deploys:
            raise RuntimeError(
                f"no switch-core deployment in namespace {self.namespace}"
            )
        containers = deploys[0]["spec"]["template"]["spec"]["containers"]
        core = next(
            (c for c in containers if c["name"] == CORE_CONTAINER), containers[0]
        )
        env: dict[str, dict] = {}
        for e in core.get("env") or []:
            ref = (e.get("valueFrom") or {}).get("secretKeyRef")
            if ref:
                env[e["name"]] = {"secret": (ref["name"], ref["key"])}
            elif "value" in e:
                env[e["name"]] = {"value": e["value"]}
        return env

    def admin_login(self) -> tuple[str, str]:
        """The gateway admin's email and password, from the Secret the
        switch-core pod reads them from. Kept in memory only."""
        env = self.core_env()
        values = []
        for name in ("GATEWAY_ADMIN_EMAIL", "GATEWAY_ADMIN_PASSWORD"):
            ref = env.get(name, {}).get("secret")
            if ref is None:
                raise RuntimeError(
                    f"switch-core does not read {name} from a Secret here"
                )
            secret, key = ref
            data = self.get_json("secret", secret).get("data") or {}
            if key not in data:
                raise RuntimeError(f"Secret {secret} has no key {key}")
            values.append(base64.b64decode(data[key]).decode())
        return values[0], values[1]

    def public_urls(self) -> tuple[str | None, str | None]:
        """The gateway and API URLs this release was deployed with
        (FRONTEND_BASE_URL and GATEWAY_PUBLIC_URL, from napoleon's values)."""
        env = self.core_env()
        gw = env.get("FRONTEND_BASE_URL", {}).get("value")
        api = env.get("GATEWAY_PUBLIC_URL", {}).get("value")
        return gw, api


@dataclass
class Sampler:
    """Runs pod_sampler.py in every switch-core pod and collects its lines.

    One `pod` sampler per pod (CPU and memory), and one `db` sampler in one of
    them for the database-wide numbers. Pods are looked up again every
    `rediscover` seconds: a pod that appears gets a sampler, one that goes
    away loses it, and if the pod running the database sampler goes, another
    one takes it over.
    """

    kube: Kube
    interval: float = 1.0
    rediscover: float = 10.0
    phase: str = "setup"
    samples: list[dict] = field(default_factory=list)
    pods_seen: dict[str, dict] = field(default_factory=dict)
    _procs: dict[tuple[str, str], asyncio.subprocess.Process] = field(
        default_factory=dict
    )
    _tasks: list[asyncio.Task] = field(default_factory=list)

    async def run(self) -> None:
        src = SAMPLER.read_bytes()
        while True:
            try:
                pods = await asyncio.to_thread(self.kube.core_pods)
            except Exception as exc:  # noqa: BLE001 - keep sampling through a blip
                self.samples.append(
                    {"kind": "error", "ts": time.time(), "error": str(exc)}
                )
                pods = None
            if pods is not None:
                names = [p["name"] for p in pods]
                for p in pods:
                    self.pods_seen[p["name"]] = p
                for key in [k for k in self._procs if k[0] not in names]:
                    self._stop(key)
                for name in names:
                    if (name, "pod") not in self._procs:
                        await self._start(name, "pod", src)
                if names and not any(k[1] == "db" for k in self._procs):
                    await self._start(names[0], "db", src)
            await asyncio.sleep(self.rediscover)

    async def _start(self, pod: str, mode: str, src: bytes) -> None:
        proc = await asyncio.create_subprocess_exec(
            *self.kube.base,
            "exec",
            "-i",
            pod,
            "-c",
            CORE_CONTAINER,
            "--",
            "python",
            "-",
            mode,
            str(self.interval),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        assert proc.stdin is not None
        proc.stdin.write(src)
        proc.stdin.close()
        self._procs[(pod, mode)] = proc
        self._tasks.append(asyncio.create_task(self._read(pod, mode, proc)))

    async def _read(
        self, pod: str, mode: str, proc: asyncio.subprocess.Process
    ) -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                d = json.loads(line)
            except ValueError:
                continue
            d["kind"] = mode
            d["pod"] = pod
            d["phase"] = self.phase
            self.samples.append(d)
        await proc.wait()
        # Ended on its own (pod gone, exec dropped): forget it, so the next
        # discovery starts it again if the pod is still there.
        if self._procs.get((pod, mode)) is proc:
            del self._procs[(pod, mode)]

    def _stop(self, key: tuple[str, str]) -> None:
        proc = self._procs.pop(key, None)
        if proc and proc.returncode is None:
            proc.kill()

    async def close(self) -> None:
        for key in list(self._procs):
            self._stop(key)
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)


@dataclass
class PortForward:
    """`kubectl port-forward` to each switch-core pod, for a Mac that is not on
    the tailnet. It goes through the Kubernetes API server, which adds latency
    and a bottleneck of its own: fine for a smoke run, not for capacity numbers."""

    kube: Kube
    urls: dict[str, str] = field(default_factory=dict)
    _procs: list[subprocess.Popen] = field(default_factory=list)

    def open(self) -> list[str]:
        for pod in self.kube.core_pods():
            proc = subprocess.Popen(
                [*self.kube.base, "port-forward", f"pod/{pod['name']}", ":8000"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
            self._procs.append(proc)
            assert proc.stdout is not None
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                m = re.search(r"127\.0\.0\.1:(\d+)", line or "")
                if m:
                    self.urls[pod["name"]] = f"http://127.0.0.1:{m.group(1)}"
                    # kubectl prints a line per connection it handles; keep
                    # reading them, or the pipe fills and kubectl stalls.
                    threading.Thread(
                        target=lambda out=proc.stdout: [None for _ in out], daemon=True
                    ).start()
                    break
            else:
                raise RuntimeError(f"port-forward to {pod['name']} did not come up")
        return list(self.urls.values())

    def close(self) -> None:
        for p in self._procs:
            p.terminate()
