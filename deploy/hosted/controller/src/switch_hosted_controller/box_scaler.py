"""Scale a user's Kubernetes box to match the machine Core wants.

Core already decides when a hosted machine should sleep (its idle sweep) and wake
(a message for one of its agents). For a machine that is a Kubernetes box rather
than an EC2 instance, this loop is the cloud side: it scales the user's `box`
StatefulSet to 1 when Core wants the machine running, to 0 when Core wants it
stopped, and reports what it sees back to Core. The disk (a PVC) is never
touched, so a stopped box keeps everything.

It may only read and scale one StatefulSet named `box` in the namespaces it is
given (a Role per namespace). For the eviction watch it also lists and watches
the box pods and the namespace's events, and creates Warning events: it never
deletes anything, and never creates anything else.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import ssl
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener
from uuid import UUID

from .cluster_watch import ClusterWatch, RestartCounter, box_node
from .evictions import EvictionWatch, status_document
from .registration_codes import RegistrationCodes

logger = logging.getLogger(__name__)

BOX = "box"
# The box StatefulSet's one pod, read by name (never listed).
BOX_POD = "box-0"
ENROL_SECRET = "switch-enrol"  # the box reads its one-time registration code from here at boot
ENROL_KEY = "code"
ENROL_TIMEOUT_S = 10.0
RUNNING, STOPPED = "running", "stopped"
NAMESPACE_RE = re.compile(r"agents-user-[a-z0-9-]+")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class _NoRedirect(HTTPRedirectHandler):
    """Refuses every redirect, so the controller's bearer is never sent anywhere but Core."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CoreRefused(RuntimeError):
    """Core answered a call with an HTTP error status (`status`). Its text names the path and status only."""

    def __init__(self, path: str, status: int, reason: object):
        super().__init__(f"Core call {path} failed: HTTP Error {status}: {reason}")
        self.status = status


class ScalerConfigError(ValueError):
    pass


def load_boxes(path: Path) -> dict[str, str]:
    """The scaler's own machine-to-namespace map. Core never chooses a namespace.

    Either a 0600 JSON file (on the Mac), or the `box-map` Secret mounted as a
    directory (in the cluster): one file per box, named by machine id and
    holding its namespace. Refuses a file others can read or write, a namespace
    that isn't a user box namespace, a machine id that isn't a UUID, or a
    namespace listed twice.
    """
    if path.is_dir():
        return _boxes_from_dir(path)
    if path.stat().st_mode & 0o077:
        raise ScalerConfigError("the box map must be readable by its owner only (0600)")
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict) or not raw:
        raise ScalerConfigError("the box map must be a non-empty object of machine id to namespace")
    boxes: dict[str, str] = {}
    for machine_id, namespace in raw.items():
        if not isinstance(namespace, str) or not NAMESPACE_RE.fullmatch(namespace):
            raise ScalerConfigError(f"not a user box namespace: {namespace!r}")
        boxes[str(UUID(machine_id))] = namespace
    if len(set(boxes.values())) != len(boxes):
        raise ScalerConfigError("a namespace is listed more than once")
    return boxes


def _boxes_from_dir(path: Path) -> dict[str, str]:
    """The mounted `box-map` Secret: Kubernetes adds hidden `..data` entries and
    links each key to its file, so only the visible names count, and each file's
    own mode is checked. An empty map is allowed here: a new cluster has no boxes
    until the box operator makes the first."""
    boxes: dict[str, str] = {}
    for entry in sorted(path.iterdir()):
        if entry.name.startswith("."):
            continue
        target = entry.resolve()
        # Each key links into the mount's own `..data`; anything resolving outside it is refused.
        if not target.is_relative_to(path.resolve()):
            raise ScalerConfigError(f"a box map entry points outside the mount: {entry.name!r}")
        # Kubernetes mounts a Secret with the pod's fsGroup able to read it (0440 here), so group read is
        # allowed; group write, and anything for others, is refused.
        if target.stat().st_mode & 0o037:
            raise ScalerConfigError(
                "the box map must be readable by its owner and group only (0440 at most)"
            )
        namespace = target.read_text().strip()
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ScalerConfigError(f"not a user box namespace: {namespace!r}")
        try:
            boxes[str(UUID(entry.name))] = namespace
        except ValueError:
            raise ScalerConfigError(f"not a machine id: {entry.name!r}") from None
    if len(set(boxes.values())) != len(boxes):
        raise ScalerConfigError("a namespace is listed more than once")
    return boxes


def check_core_origin(origin: str) -> str:
    """The controller token only goes to Core over HTTPS, or to the local tunnel."""
    url = urlsplit(origin)
    if url.scheme == "https" or (url.scheme == "http" and url.hostname in LOOPBACK):
        return origin
    raise ScalerConfigError(
        "Core's address must be https://, or http:// on this machine (the tunnel)"
    )


class Kube(Protocol):
    def scale(self, namespace: str) -> tuple[int, int]: ...  # (spec replicas, ready replicas)
    def set_replicas(self, namespace: str, replicas: int) -> None: ...


class Core(Protocol):
    def machines(self) -> list[dict[str, Any]]: ...
    def observe(
        self,
        machine_id: str,
        state: str,
        revision: int,
        error: str | None = None,
        evictions: int | None = None,
        restarts: int | None = None,
        node: str | None = None,
    ) -> None: ...


@dataclass(frozen=True)
class Step:
    machine_id: str
    namespace: str
    desired: str
    replicas: int
    ready: int
    action: str | None  # "scale_up", "scale_down" or None
    observed: str


def decide(desired: str, replicas: int, ready: int) -> tuple[str | None, str]:
    """What to do for one box, and what to tell Core. Pure, so it is tested alone."""
    if desired == RUNNING:
        if replicas == 0:
            return "scale_up", "provisioning"
        return None, "running" if ready >= 1 else "provisioning"
    # Stopped, retained (an agentless box kept for its retention days) and
    # deleted all mean the box is not wanted running: it is scaled to 0 and
    # reported as stopped, its disk kept. This loop never deletes anything
    # (the Kube it is given can only scale): what happens to a retained or
    # deleted box's disk is not its decision.
    if replicas >= 1:
        return "scale_down", "stopping"
    return None, "stopped" if ready == 0 else "stopping"


START_LIMIT_S = 180.0
START_TIMEOUT_ERROR = "The box did not become ready within 3 minutes of starting."


def _observe(
    core: Any,
    machine_id: str,
    observed: str,
    revision: int,
    error: str | None,
    evictions: int | None,
    facts: dict[str, Any],
    watch: Any,
    box_facts: Any,
) -> None:
    """Tell Core what the box is doing. With hosted agents v2 off, Core refuses v2's fields (`evictions`, `restarts`,
    `node`) with a 422, as upstream refuses any unknown field: the observation then goes again with upstream's fields
    only, and those facts stay owed. Any other failure is logged by type and goes no further than this box."""
    try:
        if evictions is None and not facts:
            core.observe(machine_id, observed, revision, error)
            return
        try:
            core.observe(
                machine_id,
                observed,
                revision,
                error,
                **({"evictions": evictions} if evictions is not None else {}),
                **facts,
            )
        except CoreRefused as refused:
            if refused.status != 422:
                raise
            core.observe(machine_id, observed, revision, error)
            return
        # Accepted (a refused call raises): only what came after is still owed.
        if evictions is not None and watch is not None:
            watch.reported(machine_id, evictions)
        if box_facts is not None and facts:
            box_facts.reported(machine_id, facts["restarts"])
    except Exception as exc:
        logger.warning(
            "Machine %s: Core did not take its observation (%s); the pass goes on.",
            machine_id,
            type(exc).__name__,
        )


def reconcile_once(
    core: Core,
    kube: Kube,
    boxes: dict[str, str],
    waiting: dict[str, float] | None = None,
    now: Callable[[], float] = time.monotonic,
    place: Callable[[str], None] | None = None,
    rebalance: Callable[[list[dict[str, Any]], dict[str, str]], None] | None = None,
    codes: RegistrationCodes | None = None,
    watch: EvictionWatch | None = None,
    box_facts: RestartCounter | None = None,
) -> list[Step]:
    """One pass over the machines Core lists that map to a box namespace.

    `waiting` remembers, across passes, since when each box has been wanted
    running but not ready. Past 3 minutes the box is reported to Core as an
    error instead of being waited on for ever.

    `place`, when given, is called with a stopped box's namespace just before
    it is scaled up, to write where it should start (placement). It
    never raises, and the box starts whatever it does.

    `watch`, when given, looks at each box for evictions (`evictions.py`):
    a box pushed off its machine is alerted once, and its count is sent to
    Core in the observation when the watch is set to report it.

    `rebalance`, when given, is called once at the end of the pass with Core's
    machine list and the box map (moves and placeholders). A failure
    there is logged; the pass's scaling is already done.

    `box_facts`, when given with `watch`, counts each box's restarts from the
    pods the watch just listed, and the observation carries them with the
    box's node. Off unless `SWITCH_SCALER_REPORT_BOX_FACTS=1`, since an
    older Core refuses the two fields.

    `codes`, when given, gives a box a live registration code just before its
    first start, restarts one stuck with a dead code, and empties the Secret
    once the box is registered. It never raises.
    """
    waiting = {} if waiting is None else waiting
    steps: list[Step] = []
    listed = core.machines()
    failed = 0
    for raw in listed:
        machine_id = str(raw.get("machine_id", ""))
        namespace = boxes.get(machine_id)
        if namespace is None:
            continue  # not one of ours
        desired = raw.get("desired_state")
        revision = raw.get("revision")
        if desired not in (RUNNING, STOPPED, "retained", "deleted") or not isinstance(
            revision, int
        ):
            logger.warning(
                "Machine %s: skipped, Core sent an invalid desired state or revision.", machine_id
            )
            continue
        # One box failing (Kubernetes, or Core) is that box's alone: the pass goes on,
        # so every other box still gets its scale step this pass.
        try:
            replicas, ready = kube.scale(namespace)
            action, observed = decide(desired, replicas, ready)
            if action == "scale_up":
                if codes is not None:
                    codes.before_start(machine_id, namespace)
                if place is not None:
                    try:  # placement is a preference: nothing it does may stop a start
                        place(namespace)
                    except Exception as exc:
                        logger.warning(
                            "Machine %s: placement failed (%s); starting it anyway.",
                            machine_id,
                            type(exc).__name__,
                        )
                kube.set_replicas(namespace, 1)
            elif action == "scale_down":
                kube.set_replicas(namespace, 0)
            if action:
                logger.info(
                    "Machine %s: %s %s/%s (Core wants %s).",
                    machine_id,
                    action,
                    namespace,
                    BOX,
                    desired,
                )
            evictions = None
            facts: dict[str, Any] = {}
            if watch is not None:
                watch.check(machine_id, namespace)
                if watch.report_to_core:
                    evictions = watch.unreported(machine_id)
                if box_facts is not None and machine_id in watch.last_pods:
                    pods = watch.last_pods[machine_id]
                    box_facts.see(machine_id, pods)
                    facts = {"restarts": box_facts.unreported(machine_id), "node": box_node(pods)}
            error = None
            if desired == RUNNING and observed != RUNNING:
                since = waiting.setdefault(machine_id, now())
                if (
                    codes is not None
                    and action is None
                    and replicas >= 1
                    and codes.stuck(machine_id, namespace, now() - since)
                ):
                    # Never registered and its code went dead: a fresh one is in its
                    # Secret now, and a box reads it only at boot, so start it again.
                    kube.set_replicas(namespace, 0)
                    waiting.pop(machine_id, None)
                    logger.info(
                        "Machine %s: restarting %s/%s to register with its new code.",
                        machine_id,
                        namespace,
                        BOX,
                    )
                    observed = "provisioning"
                elif now() - since > START_LIMIT_S:
                    observed, error = "error", START_TIMEOUT_ERROR
                    logger.warning("Machine %s: not ready 3 minutes after starting.", machine_id)
            else:
                waiting.pop(machine_id, None)
                if codes is not None and desired == RUNNING and observed == RUNNING:
                    codes.ready(machine_id, namespace)
            _observe(
                core, machine_id, observed, revision, error, evictions, facts, watch, box_facts
            )
            steps.append(Step(machine_id, namespace, desired, replicas, ready, action, observed))
        except Exception as exc:
            failed += 1
            logger.warning(
                "Machine %s: its step failed this pass (%s); the pass goes on.",
                machine_id,
                type(exc).__name__,
            )
    if rebalance is not None:
        try:
            rebalance(listed, boxes)
        except Exception as exc:
            logger.warning("Placement pass failed (%s); scaling is unaffected.", type(exc).__name__)
    if failed:
        # Every other box had its step; the pass still reads as failed.
        raise RuntimeError(f"{failed} box step(s) failed this pass")
    return steps


def run(
    core: Core,
    kube: Kube,
    boxes: dict[str, str],
    interval: float = 10.0,
    stop: Callable[[], bool] = lambda: False,
    sleep: Callable[[float], None] = time.sleep,
    place: Callable[[str], None] | None = None,
    rebalance: Callable[[list[dict[str, Any]], dict[str, str]], None] | None = None,
    codes: RegistrationCodes | None = None,
    watch: EvictionWatch | None = None,
    status_file: Path | None = None,
    cluster: ClusterWatch | None = None,
    box_facts: RestartCounter | None = None,
) -> None:
    waiting: dict[str, float] = {}
    while not stop():
        try:
            reconcile_once(
                core,
                kube,
                boxes,
                waiting,
                place=place,
                rebalance=rebalance,
                codes=codes,
                watch=watch,
                box_facts=box_facts,
            )
        except Exception:  # keep going; the next pass retries
            logger.exception("Box scaler pass failed; retrying.")
        if cluster is not None:
            cluster.tick()  # at most every 30 s; never raises
        if watch is not None and status_file is not None:
            write_status(status_file, status_document(watch, boxes.keys()))
        sleep(interval)


def write_status(path: Path, document: dict[str, Any]) -> None:
    """The scaler's status file: written whole, owner-only, counts and ids only."""
    try:
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(document, sort_keys=True))
        temporary.chmod(0o600)
        temporary.replace(path)
    except OSError as exc:
        logger.warning("Could not write the scaler's status file (%s).", type(exc).__name__)


class KubeApi:
    """The Kubernetes API: the box's scale subresource, and for the eviction watch,
    its pod `box-0` by name and its events (read) and one Warning event on the box
    (create). Every call names a user box namespace, checked first."""

    def __init__(self, server: str, token: str, ca_file: str):
        self._server = server.rstrip("/")
        self._token = token
        self._ctx = ssl.create_default_context(cafile=ca_file)

    def _call(self, method: str, path: str, body: dict | None = None, timeout: float = 20) -> dict:
        req = Request(
            self._server + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": "application/json",
                "Content-Type": "application/merge-patch+json"
                if method == "PATCH"
                else "application/json",
            },
        )
        with _open(req, self._ctx, timeout) as r:
            return json.load(r)

    def scale(self, namespace: str) -> tuple[int, int]:
        s = self._call("GET", f"/apis/apps/v1/namespaces/{namespace}/statefulsets/{BOX}/scale")
        spec = int(s.get("spec", {}).get("replicas") or 0)
        sts = self._call("GET", f"/apis/apps/v1/namespaces/{namespace}/statefulsets/{BOX}")
        ready = int(sts.get("status", {}).get("readyReplicas") or 0)
        return spec, ready

    def set_replicas(self, namespace: str, replicas: int) -> None:
        self._call(
            "PATCH",
            f"/apis/apps/v1/namespaces/{namespace}/statefulsets/{BOX}/scale",
            {"spec": {"replicas": replicas}},
        )

    def _enrol_path(self, namespace: str) -> str:
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        return f"/api/v1/namespaces/{namespace}/secrets/{ENROL_SECRET}"

    def enrol_code(self, namespace: str) -> str | None:
        """The registration code in the box's Secret, or None. Never logged."""
        secret = self._call("GET", self._enrol_path(namespace), timeout=ENROL_TIMEOUT_S)
        value = (secret.get("data") or {}).get(ENROL_KEY)
        return base64.b64decode(value).decode() if value else None

    def set_enrol_code(self, namespace: str, code: str | None) -> None:
        """Writes the box's registration code, or with None removes it."""
        value = None if code is None else base64.b64encode(code.encode()).decode()
        self._call(
            "PATCH",
            self._enrol_path(namespace),
            {"data": {ENROL_KEY: value}},
            timeout=ENROL_TIMEOUT_S,
        )

    def box_pods(self, namespace: str) -> list[dict[str, Any]]:
        """The box's one pod, read by its fixed name (`box-0`), so the
        controller needs `get` on that name only, never a pod list (the
        in-cluster controller's narrow rights). None there gives an empty list."""
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        try:
            pod = self._call("GET", f"/api/v1/namespaces/{namespace}/pods/{BOX_POD}")
        except HTTPError as exc:
            if exc.code == 404:
                return []
            raise
        return [pod]

    def events(self, namespace: str) -> list[dict[str, Any]]:
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        listed = self._call(
            "GET", f"/api/v1/namespaces/{namespace}/events?fieldSelector=involvedObject.kind%3DPod"
        )
        return list(listed.get("items") or [])

    def warn_box(self, namespace: str, reason: str, message: str) -> None:
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._call(
            "POST",
            f"/api/v1/namespaces/{namespace}/events",
            {
                "metadata": {"generateName": "box-pushed-off-", "namespace": namespace},
                "involvedObject": {
                    "apiVersion": "apps/v1",
                    "kind": "StatefulSet",
                    "name": BOX,
                    "namespace": namespace,
                },
                "reason": reason,
                "message": message,
                "type": "Warning",
                "source": {"component": "switch-box-scaler"},
                "firstTimestamp": stamp,
                "lastTimestamp": stamp,
                "count": 1,
            },
        )


def _open(req: Request, ctx: ssl.SSLContext, timeout: float = 20):
    # No redirects: the bearer only ever goes to the API it was meant for.
    return build_opener(_NoRedirect, HTTPSHandler(context=ctx)).open(req, timeout=timeout)


class CoreApi:
    """Core's hosted-controller routes, as the existing controller calls them."""

    def __init__(self, origin: str, token: str, context: ssl.SSLContext | None = None):
        self._origin = check_core_origin(origin).rstrip("/") + "/gateway/hosted-controller"
        self._token = token
        # With a context (Core's own CA), only that CA is trusted for Core;
        # without one, the default system store, as before.
        self._handlers = (HTTPSHandler(context=context),) if context is not None else ()

    def _call(self, path: str, body: dict | None = None) -> Any:
        req = Request(
            self._origin + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with build_opener(*self._handlers, _NoRedirect).open(req, timeout=30) as r:
                return json.load(r)
        except HTTPError as exc:
            raise CoreRefused(path, exc.code, exc.reason) from None
        except (URLError, TimeoutError) as exc:
            raise RuntimeError(f"Core call {path} failed: {exc}") from None

    def report_cluster(self, report: dict[str, Any]) -> None:
        """The cluster report: node names, zones, shares and fixed states,
        and the listed services' copies. Nothing else."""
        self._call("/cluster", report)

    def prepare(self, machine_id: str) -> dict[str, Any]:
        """What the machine boots from: per workspace its controller, or a one-time code. The answer carries
        codes, so it is never logged."""
        answer = self._call(f"/machines/{UUID(machine_id)}/prepare", {})
        return answer if isinstance(answer, dict) else {}

    def machines(self) -> list[dict[str, Any]]:
        listed = self._call("/machines")
        return listed.get("machines", []) if isinstance(listed, dict) else []

    def observe(
        self,
        machine_id: str,
        state: str,
        revision: int,
        error: str | None = None,
        evictions: int | None = None,
        restarts: int | None = None,
        node: str | None = None,
    ) -> None:
        self._call(
            f"/machines/{machine_id}/observation",
            {
                # Only when reported: a Core without the fields refuses unknown ones.
                **({"evictions": evictions} if evictions is not None else {}),
                **({"restarts": restarts} if restarts is not None else {}),
                **({"node": node} if node is not None else {}),
                "state": state,
                "revision": revision,
                "error": error,
                "error_code": "machine_needs_attention"
                if error
                else None,  # v3 Core accepts only this code
                "data_volume_id": None,
                "instance_id": None,
                "instance_type": None,
            },
        )
