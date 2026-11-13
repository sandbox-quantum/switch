"""A box's registration code, written just before it first starts.

A box registers with Core once, using a one-time code it reads from its Secret `switch-enrol` (key `code`) when it
boots. Codes last 30 minutes on purpose, so one written when the user was set up has usually expired by the box's
first start. Instead, just before a box goes 0 -> 1 this asks Core for the machine's code (`prepare`, with the hosted
controller token the scaler already holds) and writes it into the Secret, then the scaler starts the box.

- Only for machines in the scaler's own box map, and only for a box being started or waiting to register.
- Core returns no code for a registered box, so later starts change nothing; once a box is registered its Secret is
  emptied, so spent codes don't linger.
- A box that is running but never registered (its code went dead before it booted) is restarted once Core has a
  fresh code: the box reads the code only at boot.
- The code is held in a local variable for one call, written into the Secret, and dropped. It is never logged,
  returned or reported; log lines carry machine ids, namespaces and times only.
- Asks Core at most once per box every 5 minutes; Core itself mints at most once per box per 30 minutes.
Nothing here ever stops a start: every failure is logged by type and the box starts as it would have.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

logger = logging.getLogger(__name__)

ASK_INTERVAL_S = 300.0  # at most one `prepare` per box per 5 minutes
WAIT_BEFORE_RESTART_S = (
    90.0  # a box just started has this long to register before it counts as stuck
)


class CodeCore(Protocol):
    def prepare(self, machine_id: str) -> dict[str, Any]: ...


class CodeKube(Protocol):
    def enrol_code(self, namespace: str) -> str | None: ...  # the code in the box's Secret, or None
    def set_enrol_code(self, namespace: str, code: str | None) -> None: ...  # None empties it


class RegistrationCodes:
    def __init__(
        self,
        core: CodeCore,
        kube: CodeKube,
        boxes: dict[str, str],
        clock: Callable[[], float] = time.monotonic,
    ):
        self._core = core
        self._kube = kube
        self._boxes = boxes
        self._clock = clock
        self._asked: dict[str, float] = {}  # machine id -> when Core was last asked
        self._cleared: set[str] = (
            set()
        )  # machines whose Secret was emptied since this scaler started

    def _ours(self, machine_id: str, namespace: str) -> bool:
        return self._boxes.get(machine_id) == namespace

    def _ask(self, machine_id: str) -> list[str] | None:
        """The codes Core holds for the machine's workspaces, [] when it is registered everywhere, or None when not
        asked (too soon) or the call failed."""
        now = self._clock()
        last = self._asked.get(machine_id)
        if last is not None and now - last < ASK_INTERVAL_S:
            return None
        self._asked[machine_id] = now
        try:
            answer = self._core.prepare(machine_id)
        except Exception as exc:  # never stop a start over it
            logger.warning(
                "Machine %s: could not ask Core for its registration code (%s).",
                machine_id,
                type(exc).__name__,
            )
            return None
        controllers = answer.get("controllers") if isinstance(answer, dict) else None
        if not isinstance(controllers, list):
            logger.warning("Machine %s: Core's prepare answer has no controller list.", machine_id)
            return None
        return [
            c["enrollment_code"]
            for c in controllers
            if isinstance(c, dict) and c.get("enrollment_code")
        ]

    def _write(self, machine_id: str, namespace: str, codes: list[str]) -> bool:
        if len(codes) != 1:
            logger.warning(
                "Machine %s: Core holds %d registration codes and a box takes one; none written.",
                machine_id,
                len(codes),
            )
            return False
        try:
            self._kube.set_enrol_code(namespace, codes[0])
        except Exception as exc:
            logger.warning(
                "Machine %s: could not write the registration code for %s (%s).",
                machine_id,
                namespace,
                type(exc).__name__,
            )
            return False
        self._cleared.discard(machine_id)
        logger.info(
            "Machine %s: registration code written for %s, expires within 30 min.",
            machine_id,
            namespace,
        )
        return True

    def before_start(self, machine_id: str, namespace: str) -> None:
        """Just before the scaler takes the box 0 -> 1: give it a live code if it isn't registered yet."""
        if not self._ours(machine_id, namespace):
            return
        codes = self._ask(machine_id)
        if codes:
            self._write(machine_id, namespace, codes)

    def stuck(self, machine_id: str, namespace: str, waited_s: float) -> bool:
        """A box running but not ready: when it isn't registered and Core has a code its Secret doesn't hold (its
        code went dead), write the new one and say so, so the scaler restarts it (a box reads its code at boot)."""
        if not self._ours(machine_id, namespace) or waited_s < WAIT_BEFORE_RESTART_S:
            return False
        codes = self._ask(machine_id)
        if not codes or len(codes) != 1:
            return False
        try:
            current = self._kube.enrol_code(namespace)
        except Exception as exc:
            logger.warning(
                "Machine %s: could not read the registration code for %s (%s).",
                machine_id,
                namespace,
                type(exc).__name__,
            )
            return False
        if current == codes[0]:
            return False  # it has the live code already: waiting longer is all that helps
        return self._write(machine_id, namespace, codes)

    def ready(self, machine_id: str, namespace: str) -> None:
        """A box that is up: once Core says it's registered, empty its Secret (once per scaler run)."""
        if not self._ours(machine_id, namespace) or machine_id in self._cleared:
            return
        codes = self._ask(machine_id)
        if codes is None or codes:
            return  # not asked, failed, or still holds a code: try again later
        try:
            self._kube.set_enrol_code(namespace, None)
        except Exception as exc:
            logger.warning(
                "Machine %s: could not empty the registration code for %s (%s).",
                machine_id,
                namespace,
                type(exc).__name__,
            )
            return
        self._cleared.add(machine_id)
        logger.info(
            "Machine %s: registered; registration code emptied for %s.", machine_id, namespace
        )
