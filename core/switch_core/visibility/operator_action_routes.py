"""Routes for operator actions the cluster carries out (restart and
drain). The work is in `operator_actions.py`.

- `POST /shared-cloud/boxes/{box keyed id}/restart`: Core's hosted operators
  only, with a typed reason. Answers `{action_id}` once the request is written.
- `POST /shared-cloud/machines/{machine keyed id}/drain`: the same, for one
  node of the cluster report. Every refusal carries a code, `{code, message,
  ...}`, so the web picks its own words.
- `GET /hosted-controller/actions?kind=restart|drain` and
  `POST /hosted-controller/actions/{action_id}/steps`: the in-cluster operator
  workers only, on the operator API's own bearer
  (`require_operator_bearer`). The controller's bearer is refused here outside
  the move-over window, and a box's controller credentials always are.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import HTTPConnection

from switch_core.config import SwitchConfig
from switch_core.db.models import User
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_operator_bearer import require_operator_bearer
from switch_core.visibility.audit_log import (
    AuditInputError,
    record_operator_result,
)
from switch_core.visibility.dependencies import get_keyed_id_key
from switch_core.visibility.guards import require_operator
from switch_core.visibility.keyed_id import is_keyed_id
from switch_core.visibility.operator_actions import (
    ActionRefused,
    OpenAction,
    OperatorActions,
    RateLimited,
)
from switch_core.visibility.operator_limits import (
    DRAIN_DAILY_CAP,
    RATE_LIMITED,
    RETRY_AFTER_S,
    LimitBusy,
    Limits,
    note_bulk_actions,
)

router = APIRouter()


class ReasonBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=500)


class ActionAnswer(BaseModel):
    action_id: str


class Target(BaseModel):
    machine_id: str


class DrainTarget(BaseModel):
    """A drain's node as the current report names it, and the uid fixed when
    it was asked for: the operator refuses with `node_replaced` if the live
    node's uid differs."""

    node: str
    node_uid: str


class Counts(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    moved: int = Field(ge=0, le=200)
    total: int = Field(ge=0, le=200)


class ActionView(BaseModel):
    action_id: str
    kind: str
    target: Target | DrainTarget
    requested_at: str
    expires_at: str
    step: str | None
    # Per kind, only the ids and codes `VIEW_EXTRA` names; empty for both.
    extra: dict[str, str] = {}
    # A drain's latest counts once it's moving; None otherwise.
    counts: Counts | None = None


class ActionsAnswer(BaseModel):
    actions: list[ActionView]


class StepBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step: str = Field(min_length=1, max_length=40, pattern=r"^[a-z_]+$")
    state: Literal["running", "done", "failed"]
    # A drain's `{moved, total}`, on the steps that take it.
    counts: Counts | None = None


def get_operator_actions(
    request: HTTPConnection,
    session_factory: Annotated[
        async_sessionmaker[AsyncSession], Depends(get_session_factory)
    ],
) -> OperatorActions:
    """One per app. The session factory comes through the dependency, so an
    app's override of it (tests, other wiring) is the one used. Without a
    keyed-id key it answers 503, whatever was built before."""
    key = get_keyed_id_key(request)
    actions = getattr(request.app.state, "operator_actions", None)
    if not isinstance(actions, OperatorActions) or actions.key is not key:
        actions = OperatorActions(session_factory=session_factory, key=key)
        request.app.state.operator_actions = actions
    return actions


def _refused(error: ActionRefused) -> HTTPException:
    if error.code is None:
        return HTTPException(status_code=error.status, detail=error.detail)
    return HTTPException(
        status_code=error.status,
        detail={"code": error.code, "message": error.detail, **error.fields},
    )


#: A drain's 429s, by the limit that refused it.
_DRAIN_LIMITED = {
    RATE_LIMITED: "Too many operator actions this hour. Try again later.",
    DRAIN_DAILY_CAP: "This server's drain limit for the last 24 hours was reached.",
}


@router.post("/shared-cloud/boxes/{box_keyed_id}/restart")
async def restart_box(
    box_keyed_id: str,
    body: ReasonBody,
    operator: Annotated[User, Depends(require_operator)],
    actions: Annotated[OperatorActions, Depends(get_operator_actions)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> ActionAnswer:
    """Counts towards the operator rate limits (`operator_limits`): over one,
    the request is audited as `rate_limited` and answered 429, and nothing is
    asked of the cluster. The limit's lock covers the count and the request
    entry only, after the box is found and checked; a 409 counts for nothing.
    The operator carries the restart out later. A busy lock is a 503 with
    nothing written."""
    if not is_keyed_id(box_keyed_id):
        raise HTTPException(status_code=404, detail="Not found")
    limits = Limits.from_config(config)
    factory = actions.session_factory
    now = datetime.now(UTC)
    # Looked up before any lock: the limit's lock covers only the count and
    # the request entry, taken after the box checks (rate limit v1.2's helper).
    machine = await actions.resolve_box(box_keyed_id)
    # Every attempt is counted towards A11 however it ends, a failure of any
    # kind included (the same rule as for pause and resume). The count comes from the audit log, so an attempt
    # that wrote nothing adds nothing.
    try:
        try:
            request = await actions.request_restart(
                actor_id=operator.id,
                box_keyed_id=box_keyed_id,
                reason=body.reason,
                limits=limits,
                resolved=(machine,),
            )
        except AuditInputError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
        except LimitBusy:
            raise HTTPException(
                status_code=503,
                detail="Operator actions are busy. Try again in a minute.",
                headers={"Retry-After": "60"},
            ) from None
        except RateLimited as limited:
            await record_operator_result(
                factory, limited.record, result="failed", step=RATE_LIMITED
            )
            raise HTTPException(
                status_code=429,
                detail="Too many operator actions this hour. Try again later.",
                headers={"Retry-After": str(RETRY_AFTER_S)},
            ) from None
        except ActionRefused as error:
            raise _refused(error) from None
    finally:
        await note_bulk_actions(factory, actions.key, operator.id, limits, now)
    return ActionAnswer(action_id=request.event_id)


@router.post("/shared-cloud/machines/{machine_keyed_id}/drain")
async def drain_machine(
    machine_keyed_id: str,
    body: ReasonBody,
    operator: Annotated[User, Depends(require_operator)],
    actions: Annotated[OperatorActions, Depends(get_operator_actions)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> ActionAnswer:
    """Ask for one node to be drained. Counts towards the hourly operator
    limits and A11 and, as kind `drain`, the daily drain cap. Over a limit the
    request is audited with that limit's code as its result step and answered
    429. Any drain raises A11. The operator carries the drain out
    later. A busy lock is a 503 with nothing written. A 409 (`report_stale`,
    `node_uid_missing`, `drain_open`, `restart_open`, `no_boxes`) writes
    nothing either, so like restart's 409s it doesn't count towards A11."""
    if not is_keyed_id(machine_keyed_id):
        raise HTTPException(status_code=404, detail="Not found")
    limits = Limits.from_config(config)
    factory = actions.session_factory
    now = datetime.now(UTC)
    # Every attempt counts towards A11 however it ends (as for restart).
    # The count comes from the audit log, so one that wrote nothing,
    # such as a 409 or a 503, adds nothing.
    try:
        try:
            request = await actions.request_drain(
                actor_id=operator.id,
                machine_keyed_id=machine_keyed_id,
                reason=body.reason,
                limits=limits,
            )
        except AuditInputError as error:
            raise HTTPException(status_code=422, detail=str(error)) from None
        except LimitBusy:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "busy",
                    "message": "Operator actions are busy. Try again in a minute.",
                },
                headers={"Retry-After": "60"},
            ) from None
        except RateLimited as limited:
            await record_operator_result(
                factory, limited.record, result="failed", step=limited.code
            )
            raise HTTPException(
                status_code=429,
                detail={
                    "code": limited.code,
                    "message": _DRAIN_LIMITED.get(limited.code, "Try again later."),
                },
                headers={"Retry-After": str(RETRY_AFTER_S)},
            ) from None
        except ActionRefused as error:
            raise _refused(error) from None
    finally:
        await note_bulk_actions(factory, actions.key, operator.id, limits, now)
    return ActionAnswer(action_id=request.event_id)


@router.get("/hosted-controller/actions")
async def list_actions(
    _auth: Annotated[None, Depends(require_operator_bearer)],
    actions: Annotated[OperatorActions, Depends(get_operator_actions)],
    kind: Annotated[str, Query(pattern=r"^[a-z_]+$", max_length=20)],
) -> ActionsAnswer:
    try:
        found = await actions.open_actions(kind)
    except ActionRefused as error:
        raise _refused(error) from None
    return ActionsAnswer(
        actions=[
            ActionView(
                action_id=a.action_id,
                kind=a.kind,
                target=_target(a),
                requested_at=a.requested_at.isoformat(),
                expires_at=a.expires_at.isoformat(),
                step=a.step,
                extra=a.extra,
                counts=Counts(moved=a.counts[0], total=a.counts[1])
                if a.counts
                else None,
            )
            for a in found
        ]
    )


@router.post("/hosted-controller/actions/{action_id}/steps", status_code=204)
async def report_step(
    action_id: str,
    body: StepBody,
    _auth: Annotated[None, Depends(require_operator_bearer)],
    actions: Annotated[OperatorActions, Depends(get_operator_actions)],
) -> None:
    if len(action_id) > 64 or not all(c.isalnum() or c == "-" for c in action_id):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        await actions.step(
            action_id,
            body.step,
            body.state,
            (body.counts.moved, body.counts.total) if body.counts else None,
        )
    except ActionRefused as error:
        raise _refused(error) from None


def _target(action: OpenAction) -> Target | DrainTarget:
    if action.kind == "drain":
        assert action.node is not None and action.node_uid is not None
        return DrainTarget(node=action.node, node_uid=action.node_uid)
    assert action.machine_id is not None
    return Target(machine_id=action.machine_id)
