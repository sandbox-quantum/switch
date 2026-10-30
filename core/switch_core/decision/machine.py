"""Auto-route's decision model on a workspace admin's own machine.

A workspace may run its decisions on one of its admin's agent controllers
(decision backend `machine`, `decision/settings.py`): Switch Console's own
controller on their Mac, or a headless one. The machine only serves the
model; Switch keeps the prompt. A decision is asked over the controller's
existing connection, so nothing on the machine listens and nothing needs a
second credential:

1. switch-core renders the llama.cpp letter prompt with the decision
   service's own code (`switch_decision.prompt.llamacpp_request`).
2. It sends `decision.request {request_id, kind, model, payload, deadline_ms}`
   through the connection's urgent queue, ahead of anything the stream has
   queued (`ControllerConnection.send_urgent`).
3. The controller forwards `payload` to its local llama-server and answers
   `{"type": "decision.result", request_id, ok, body?, model_ms?, error?}`.
4. switch-core reads the letter logprobs and applies the threshold, again
   with the service's code (`read_letter_logprobs`, `picked`).

A connection lives in the process holding its socket, so only that process
can ask (`MessageRouter.decide_pending` claims a workspace's waiting messages
there, and wakes it from elsewhere). Room content never crosses processes.

What the machine says about itself comes from its status report
(`controller.capabilities`, and the `decision` block: its hardware, the
models it offers and the state of the one it serves), stored on its
`agent_controllers` row.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError
from switch_decision.models import DecideRequest
from switch_decision.prompt import DEFAULT_HISTORY_LIMIT, llamacpp_request
from switch_decision.readers import ModelServerError, picked, read_letter_logprobs

from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerGoneError,
)
from switch_core.bridges.agent.protocol.controller_stream import DECISION_REQUEST

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.controller_presence import (
        ControllerPresence,
    )
    from switch_core.db.models import AgentController, DecisionSettings
    from switch_core.process_lease import ProcessLeases

logger = logging.getLogger(__name__)

# What a controller that can serve the decision model reports among its
# capabilities.
MACHINE_CAPABILITY = "decision.v1"
# The kind of model server a machine runs, and so the payload it is sent.
MACHINE_KIND = "llamacpp"

UPDATE_CONTROLLER = "Update this machine's controller"

REMOVED_REASON = (
    "The machine chosen for auto-route was removed. A workspace admin can "
    "choose another in Switch Console → Admin → Decision routing."
)

MachineFailure = Literal[
    "machine_offline",
    "machine_not_ready",
    "machine_busy",
    "machine_error",
    "timeout",
    "bad_answer",
]

# What each error a controller answers with counts as.
_RESULT_ERRORS: dict[str, MachineFailure] = {
    "not_running": "machine_not_ready",
    "busy": "machine_busy",
    "model_server_error": "machine_error",
    "deadline": "timeout",
}

# The states the machine's model can be in, as it reports them, and two of
# Switch's own: `offline` (not connected now) and `removed` (revoked, or gone).
MachineStateName = Literal[
    "off", "downloading", "starting", "running", "failed", "offline", "removed"
]
_REPORTED_STATES = ("off", "downloading", "starting", "running", "failed")

_REASONS = {
    "turned_off_on_machine": "turned off on the machine",
    "not_enough_disk": "not enough disk space",
    "download_failed": "the download failed",
    "checksum_mismatch": "the download did not match its checksum",
    "model_server_crashed": "the model server keeps crashing",
    "out_of_memory": "not enough memory",
    "unsupported_hardware": "this machine can't run it",
}


# ── What the machine reports ──────────────────────────────────────────────────


def capabilities(controller: AgentController) -> list[str]:
    info = (controller.status or {}).get("controller")
    found = info.get("capabilities") if isinstance(info, dict) else None
    return [c for c in found if isinstance(c, str)] if isinstance(found, list) else []


def supports_decisions(controller: AgentController) -> bool:
    return MACHINE_CAPABILITY in capabilities(controller)


def decision_status(controller: AgentController) -> dict[str, Any]:
    """The `decision` block of the machine's last status report, or {}."""
    block = (controller.status or {}).get("decision")
    return block if isinstance(block, dict) else {}


def offered_models(controller: AgentController) -> list[dict[str, Any]]:
    offered = decision_status(controller).get("offered")
    return (
        [entry for entry in offered if isinstance(entry, dict)]
        if isinstance(offered, list)
        else []
    )


def is_removed(controller: AgentController | None) -> bool:
    """Revoked (its credential is gone) or not there at all."""
    return (
        controller is None
        or controller.revoked_at is not None
        or controller.api_key_id is None
    )


def is_connected(controller: AgentController, leases: ProcessLeases) -> bool:
    """Whether the machine's socket is attached in a live process, read from
    its row as every process reads it (`management/placement.py` says the
    same as `online`)."""
    return (
        not is_removed(controller)
        and controller.connected_at is not None
        and controller.disconnected_at is None
        and leases.holds(controller.connection_process_id)
    )


def _gigabytes(n: object) -> str:
    return f"{n / 1e9:.1f}" if isinstance(n, int | float) else "?"


def progress_text(status: dict[str, Any]) -> str:
    """How far along the model is, for a person."""
    state = status.get("state")
    if state == "downloading":
        progress = status.get("progress")
        if isinstance(progress, dict):
            return (
                f"downloading, {_gigabytes(progress.get('done_bytes'))} of "
                f"{_gigabytes(progress.get('total_bytes'))} GB"
            )
        return "downloading"
    if state == "starting":
        return "starting"
    return "waiting for the machine to start it"


# ── The chosen machine, as a setting resolves it ──────────────────────────────


@dataclass(frozen=True)
class MachineChoice:
    """The machine a workspace's decisions run on, as Switch last heard of
    it. `connected` is None where it was not read (deciding needs only
    whether the machine is ready). `usable` is whether decisions are asked of
    it at all: it is there and was ready once; after that, a machine that is
    offline or failing takes the failure path, with a notice naming it."""

    id: str
    name: str
    model: str
    removed: bool
    ready: bool
    connected: bool | None
    state: MachineStateName
    progress: dict[str, Any] | None
    reason: str | None
    detail: str | None
    last_decision_ms: int | None
    # When the machine went offline, or reached the state it reports.
    since: str | None

    @property
    def usable(self) -> bool:
        return not self.removed and self.ready

    @property
    def unavailable_reason(self) -> str | None:
        """Why auto-route can't act yet, for the room toggle and the admin."""
        if self.removed:
            return REMOVED_REASON
        if self.ready:
            return None
        if self.state == "failed":
            why = _REASONS.get(self.reason or "", self.reason or "it failed")
            return (
                f"The decision model on {self.name} isn't running ({why}). "
                "A workspace admin can see more in Switch Console → Admin → "
                "Decision routing."
            )
        if self.reason == "turned_off_on_machine":
            return (
                f"The decision model on {self.name} was turned off on the "
                "machine. Its owner can turn it back on in Switch Console."
            )
        return (
            f"The decision model on {self.name} is getting ready "
            f"({progress_text({'state': self.state, 'progress': self.progress})})."
        )


def machine_choice(
    row: DecisionSettings,
    controller: AgentController | None,
    connected: bool | None,
) -> MachineChoice:
    """What a `machine` row resolves to, given its controller's row (None
    when it is gone)."""
    assert row.controller_id is not None and row.model is not None
    removed = is_removed(controller)
    status = decision_status(controller) if controller is not None else {}
    reported = status.get("state")
    state: MachineStateName
    if removed:
        state = "removed"
    elif connected is False:
        state = "offline"
    elif reported in _REPORTED_STATES:
        state = reported
    else:
        state = "off"
    progress = status.get("progress")
    last = status.get("last_decision_ms")
    since: str | None = (
        status.get("since") if isinstance(status.get("since"), str) else None
    )
    if state == "offline" and controller is not None:
        went = controller.disconnected_at or controller.last_seen_at
        since = wire_time(went) if went is not None else None
    return MachineChoice(
        id=row.controller_id,
        name=controller.name if controller is not None else row.controller_id,
        model=row.model,
        removed=removed,
        ready=row.machine_ready_at is not None,
        connected=connected,
        state=state,
        progress=progress if isinstance(progress, dict) else None,
        reason=status.get("reason") if isinstance(status.get("reason"), str) else None,
        detail=status.get("detail") if isinstance(status.get("detail"), str) else None,
        last_decision_ms=last if isinstance(last, int) else None,
        since=since,
    )


def wire_time(value: datetime) -> str:
    """RFC 3339 in UTC with a `Z`, as the controller routes write times."""
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


# ── Choosing a machine ────────────────────────────────────────────────────────


def machine_option(controller: AgentController, connected: bool) -> dict[str, Any]:
    """One of the caller's machines as the Decision routing picker lists it."""
    decision: dict[str, Any]
    if not supports_decisions(controller):
        decision = {"supported": False, "offered": [], "reason": UPDATE_CONTROLLER}
    else:
        status = decision_status(controller)
        decision = {"supported": True, "offered": offered_models(controller)}
        if isinstance(status.get("hardware"), dict):
            decision["hardware"] = status["hardware"]
        if isinstance(status.get("reason"), str):
            decision["reason"] = status["reason"]
    return {
        "id": controller.id,
        "name": controller.name,
        "connected": connected,
        "decision": decision,
    }


def choice_refusal(
    controller: AgentController | None, owner_id: str, model: str
) -> str | None:
    """Why this caller can't run the workspace's decisions on this machine
    with this model, as a sentence; None when they can. A machine that is
    not theirs reads exactly as one that is not in this workspace."""
    if controller is None or controller.owner_id != owner_id:
        return (
            "That machine isn't one of yours in this workspace. You can only "
            "choose a machine you own and have enrolled in this workspace."
        )
    if is_removed(controller):
        return f"{controller.name} was removed from Switch; choose another machine."
    if not supports_decisions(controller):
        return (
            f"{controller.name} can't run the decision model yet: "
            f"{UPDATE_CONTROLLER.lower()}."
        )
    offered = [entry.get("model") for entry in offered_models(controller)]
    if model not in offered:
        listed = ", ".join(str(m) for m in offered) or "none"
        return (
            f"{controller.name} doesn't offer the model {model!r} (it offers: "
            f"{listed})."
        )
    return None


# ── Asking it ─────────────────────────────────────────────────────────────────


class MachineDecisionError(Exception):
    """The machine gave no usable answer; `reason` says which way."""

    def __init__(self, reason: MachineFailure, message: str) -> None:
        super().__init__(message)
        self.reason: MachineFailure = reason


class _ResultError(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str
    message: str


class DecisionResult(BaseModel):
    """The controller's answer to one `decision.request`."""

    model_config = ConfigDict(extra="ignore")

    type: Literal["decision.result"]
    request_id: str
    ok: bool
    body: dict[str, Any] | None = None
    model_ms: int | None = None
    error: _ResultError | None = None


@dataclass(frozen=True)
class MachineAnswer:
    """What the machine's model chose: `agent` is the candidate the decision
    names, or None (it chose none, or was less sure than `threshold`)."""

    agent: str | None
    choice: str
    confidence: float
    threshold: float
    reason: str
    model_ms: int | None


class MachineDecisions:
    """Asks the decision model on a controller whose socket this process
    holds. One per process, over its `ControllerPresence`."""

    def __init__(self, presence: ControllerPresence) -> None:
        self._presence = presence

    def held_here(self, controller_id: str) -> bool:
        return self._presence.live_connection(controller_id) is not None

    def holder_elsewhere(self, controller_id: str) -> str | None:
        """The other process holding the controller's live socket, if any."""
        return self._presence.holder_elsewhere(controller_id)

    async def ask(
        self,
        *,
        controller_id: str,
        model: str,
        request: DecideRequest,
        threshold: float,
        timeout_seconds: float,
    ) -> MachineAnswer:
        """Ask the machine about `request` and read its answer, as the
        decision service reads its own llama.cpp server's. Raises
        `MachineDecisionError` when there is no usable answer. Never logs the
        request or the answer's body: both carry room content."""
        conn = self._presence.live_connection(controller_id)
        if conn is None:
            raise MachineDecisionError(
                "machine_offline",
                f"controller {controller_id}'s socket is not live in this process",
            )
        payload, letters = llamacpp_request(request, DEFAULT_HISTORY_LIMIT)
        request_id = uuid.uuid4().hex
        waiting = conn.expect_decision(request_id)
        conn.send_urgent(
            {
                "event": DECISION_REQUEST,
                "data": {
                    "request_id": request_id,
                    "kind": MACHINE_KIND,
                    "model": model,
                    "payload": payload,
                    "deadline_ms": round(timeout_seconds * 1000),
                },
            }
        )
        started = time.monotonic()
        try:
            message = await asyncio.wait_for(waiting, timeout=timeout_seconds)
        except TimeoutError as error:
            raise MachineDecisionError(
                "timeout",
                f"controller {controller_id} did not answer within {timeout_seconds}s",
            ) from error
        except ControllerGoneError as error:
            raise MachineDecisionError(
                "machine_offline",
                f"controller {controller_id} went before answering ({error.why})",
            ) from error
        finally:
            conn.forget_decision(request_id)
        try:
            result = DecisionResult.model_validate(message)
        except ValidationError as error:
            raise MachineDecisionError(
                "bad_answer",
                f"controller {controller_id} answered something other than a "
                f"decision result: {error.error_count()} problem(s)",
            ) from error
        if not result.ok:
            code = result.error.code if result.error is not None else "unknown"
            raise MachineDecisionError(
                _RESULT_ERRORS.get(code, "machine_error"),
                f"controller {controller_id} answered {code}"
                + (f": {result.error.message[:200]}" if result.error else ""),
            )
        if result.body is None:
            raise MachineDecisionError(
                "bad_answer", f"controller {controller_id} answered ok with no body"
            )
        try:
            answer = read_letter_logprobs(result.body, letters)
        except ModelServerError as error:
            raise MachineDecisionError(
                "bad_answer",
                f"controller {controller_id}'s model answer can't be read: "
                f"{error.log_text}",
            ) from error
        logger.debug(
            "Decision on controller %s answered in %dms (model %sms)",
            controller_id,
            round((time.monotonic() - started) * 1000),
            result.model_ms,
        )
        return MachineAnswer(
            agent=picked(answer, threshold),
            choice=answer.choice,
            confidence=answer.confidence,
            threshold=threshold,
            reason=answer.reason,
            model_ms=result.model_ms,
        )
