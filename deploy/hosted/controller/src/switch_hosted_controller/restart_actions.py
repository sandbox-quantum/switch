"""Restart a user's box when a Switch operator asks (operator side).

Core keeps the action: an operator asks Core to
restart a box, Core writes a run-once request that expires after 10 minutes, and
this worker carries it out on the cluster and reports each step back.

What the worker may do is deliberately small:

- It learns of actions only from Core's `GET /gateway/hosted-controller/actions?kind=restart`,
  on the hosted controller's own bearer. An action names a Core machine id and
  nothing else: no namespace, pod name, person or reason.
- It turns the machine id into a box namespace through its own box map. An id
  that isn't there fails the action (`box_not_found`); a name from Core is never used.
- Its only change to the cluster is deleting the one box pod, `box-0`, in that
  namespace (the `switch-operator-restart` Role, by name). The StatefulSet
  starts a fresh pod on the same disk.
- It reports codes only: `claimed`, `pod_deleted`, `box_ready`, or one of
  `box_not_found`, `delete_refused`, `not_ready_in_time`.

It never deletes twice for one action. Before deleting, it looks at the pod: if
the pod was created after the action was requested, an earlier run already
deleted it (the worker stopped before reporting `pod_deleted`), so it reports
that step instead. After `pod_deleted` it only waits for the new pod to be
Ready, up to 5 minutes, and inside the action's own expiry.
"""

from __future__ import annotations

import json
import logging
import ssl
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener
from uuid import UUID

from .box_scaler import NAMESPACE_RE, check_core_origin

logger = logging.getLogger(__name__)

POD = "box-0"
READY_WITHIN_S = 300.0
KIND = "restart"

CLAIMED, POD_DELETED, BOX_READY = "claimed", "pod_deleted", "box_ready"
BOX_NOT_FOUND, DELETE_REFUSED, NOT_READY_IN_TIME = (
    "box_not_found",
    "delete_refused",
    "not_ready_in_time",
)
RUNNING, DONE, FAILED = "running", "done", "failed"


class _NoRedirect(HTTPRedirectHandler):
    """Refuses every redirect, so a bearer is never carried anywhere but the host it was meant for."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # urllib then raises HTTPError for the 3xx


class StepRefused(Exception):
    """Core answered 409: the step is no longer allowed (claimed elsewhere, finished or expired)."""


class Kube(Protocol):
    def box_pod(self, namespace: str) -> dict[str, Any] | None: ...
    def delete_box_pod(self, namespace: str, uid: str | None = None) -> None: ...


class Core(Protocol):
    def open_actions(self) -> list[dict[str, Any]]: ...
    def step(self, action_id: str, step: str, state: str) -> None: ...


def parse_time(value: Any) -> float | None:
    """An RFC 3339 time as epoch seconds, or None."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def pod_facts(pod: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The few fields the worker looks at: uid, created, ready, images. Nothing else is kept."""
    if not pod:
        return None
    meta = pod.get("metadata") or {}
    status = pod.get("status") or {}
    ready = any(
        c.get("type") == "Ready" and c.get("status") == "True"
        for c in status.get("conditions") or []
    )
    images = [c.get("image") for c in (pod.get("spec") or {}).get("containers") or []]
    return {
        "uid": meta.get("uid"),
        "created": parse_time(meta.get("creationTimestamp")),
        "deleting": bool(meta.get("deletionTimestamp")),
        "ready": ready,
        "images": tuple(i for i in images if isinstance(i, str)),
    }


@dataclass
class _Running:
    namespace: str
    deadline: float
    old_uid: str | None
    images: tuple[str, ...]
    not_before: float | None = (
        None  # the new pod must be created after this (the action's requested_at)
    )


@dataclass
class RestartWorker:
    kube: Kube
    core: Core
    boxes: Mapping[str, str]  # machine id -> box namespace, the operator's own map
    clock: Callable[[], float] = time.time
    _running: dict[str, _Running] = field(default_factory=dict)

    def tick(self) -> None:
        """One pass: list Core's open restart actions and move each one step on."""
        try:
            actions = self.core.open_actions()
        except Exception as exc:  # never stop the operator's loop
            logger.warning("Could not list restart actions (%s).", type(exc).__name__)
            return
        seen = set()
        for action in actions:
            action_id = str(action.get("action_id") or "")
            if action.get("kind") != KIND or not _is_uuid(action_id):
                continue
            seen.add(action_id)
            try:
                self._advance(action_id, action)
            except StepRefused:
                logger.info("Restart action %s: Core refused the next step; leaving it.", action_id)
                self._running.pop(action_id, None)
            except Exception as exc:
                logger.warning(
                    "Restart action %s: step failed (%s); trying again next pass.",
                    action_id,
                    type(exc).__name__,
                )
        for gone in set(self._running) - seen:  # finished or expired in Core
            self._running.pop(gone, None)

    def _advance(self, action_id: str, action: Mapping[str, Any]) -> None:
        step = action.get("step")
        machine_id = str((action.get("target") or {}).get("machine_id") or "")
        namespace = self.boxes.get(machine_id) if _is_uuid(machine_id) else None
        expires = parse_time(action.get("expires_at"))
        requested = parse_time(action.get("requested_at"))
        now = self.clock()

        if step is None:
            self.core.step(action_id, CLAIMED, RUNNING)
            step = CLAIMED
        if namespace is None or not NAMESPACE_RE.fullmatch(namespace):
            logger.warning(
                "Restart action %s: machine %s isn't in the box map.", action_id, machine_id or "?"
            )
            self.core.step(action_id, BOX_NOT_FOUND, FAILED)
            return

        if step == CLAIMED:
            before = pod_facts(self.kube.box_pod(namespace))
            already = (
                before is not None
                and requested is not None
                and before["created"] is not None
                and before["created"] > requested
            )
            if already:
                # The pod is newer than the request: an earlier run of ours, or the scaler or an eviction, replaced it.
                logger.info(
                    "Restart action %s: the box pod for machine %s is already newer than the request; no delete by this run.",
                    action_id,
                    machine_id,
                )
            else:
                try:
                    # Only the pod looked at: a uid precondition, so a pod replaced in between is never touched.
                    self.kube.delete_box_pod(namespace, None if before is None else before["uid"])
                except HTTPError as exc:
                    if exc.code not in (
                        404,
                        409,
                    ):  # gone already, or already replaced: the same outcome
                        logger.warning(
                            "Restart action %s: the delete was refused (HTTP %s).",
                            action_id,
                            exc.code,
                        )
                        self.core.step(action_id, DELETE_REFUSED, FAILED)
                        return
            self._running[action_id] = _Running(
                namespace,
                _deadline(now, expires),
                None if already or before is None else before["uid"],
                () if before is None else before["images"],
                requested,
            )
            self.core.step(action_id, POD_DELETED, RUNNING)
            logger.info("Restart action %s: box pod deleted for machine %s.", action_id, machine_id)
            return

        if step == POD_DELETED:
            run = self._running.get(action_id)
            if run is None:  # resumed after the worker restarted: only wait, never delete again
                run = self._running[action_id] = _Running(
                    namespace, _deadline(now, expires), None, (), requested
                )
            pod = pod_facts(self.kube.box_pod(namespace))
            fresh = (
                pod is not None
                and pod["ready"]
                and not pod["deleting"]
                and pod["uid"] != run.old_uid
                and (
                    run.not_before is None
                    or (pod["created"] is not None and pod["created"] > run.not_before)
                )
                and (not run.images or pod["images"] == run.images)
            )
            if fresh:
                self.core.step(action_id, BOX_READY, DONE)
                self._running.pop(action_id, None)
                logger.info("Restart action %s: the box is back and Ready.", action_id)
            elif now >= run.deadline:
                self.core.step(action_id, NOT_READY_IN_TIME, FAILED)
                self._running.pop(action_id, None)
                logger.warning("Restart action %s: the box wasn't Ready in time.", action_id)


def _deadline(now: float, expires: float | None) -> float:
    limit = now + READY_WITHIN_S
    return min(limit, expires) if expires is not None else limit


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
        return True
    except ValueError:
        return False


class RestartKubeApi:
    """The two Kubernetes calls restart needs: read and delete `box-0` in a box namespace."""

    def __init__(self, server: str, token: str, ca_file: str):
        self._server = server.rstrip("/")
        self._token = token
        self._ctx = ssl.create_default_context(cafile=ca_file)

    def _path(self, namespace: str) -> str:
        if not NAMESPACE_RE.fullmatch(namespace):
            raise ValueError("not a user box namespace")
        return f"/api/v1/namespaces/{namespace}/pods/{POD}"

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        req = Request(
            self._server + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self._token,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        with build_opener(_NoRedirect, HTTPSHandler(context=self._ctx)).open(req, timeout=20) as r:
            return json.load(r)

    def box_pod(self, namespace: str) -> dict[str, Any] | None:
        try:
            return self._call("GET", self._path(namespace))
        except HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def delete_box_pod(self, namespace: str, uid: str | None = None) -> None:
        options = {"kind": "DeleteOptions", "apiVersion": "v1"}
        if uid:
            options["preconditions"] = {"uid": uid}
        self._call("DELETE", self._path(namespace), options)


class RestartCoreApi:
    """Core's restart action routes, on the hosted controller's own bearer (never a box's credential)."""

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
                text = r.read()
                return json.loads(text) if text else None
        except HTTPError as exc:
            if exc.code == 409:
                raise StepRefused() from None
            raise RuntimeError(f"Core call failed: HTTP {exc.code}") from None
        except (URLError, TimeoutError) as exc:
            raise RuntimeError(f"Core call failed: {type(exc).__name__}") from None

    def open_actions(self) -> list[dict[str, Any]]:
        listed = self._call(f"/actions?kind={KIND}")
        actions = listed.get("actions") if isinstance(listed, dict) else None
        return [a for a in actions or [] if isinstance(a, dict)]

    def step(self, action_id: str, step: str, state: str) -> None:
        self._call(f"/actions/{quote(str(UUID(action_id)))}/steps", {"step": step, "state": state})
