"""Routes for an operator's pause and a workspace admin's per-person
switch. The work is in `hosted_access.py`.

- `POST /shared-cloud/users/{user keyed id}/pause` and `.../resume`: Core's
  hosted operators only, with a typed reason, naming the user by the full
  keyed id they see (resolved by recomputing, never reversing). An id that
  matches no one is a plain 404, audited as failed. They answer once the audit
  entry, the mark and the revoke are done; the wait for the box to stop and
  the result entry follow in the background. Both count towards the operator
  rate limits (`operator_limits`): over one, the request is audited as
  `rate_limited` and answered 429, and nothing else happens. The limit's lock
  covers only the count and the request entry; the action runs after it.
- `PUT /tenants/{tenant_id}/hosted-people/{user_id}`: that workspace's owners
  and admins only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import HTTPConnection

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import User
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.tenant_context import current_tenant_id
from switch_core.visibility.alerts import action_alert
from switch_core.visibility.audit_log import (
    AuditInputError,
    record_operator_result,
)
from switch_core.visibility.dependencies import get_keyed_id_key
from switch_core.visibility.guards import require_operator, require_workspace_admin
from switch_core.visibility.hosted_access import HostedAccess
from switch_core.visibility.keyed_id import is_keyed_id
from switch_core.visibility.operator_limits import (
    RATE_LIMITED,
    RETRY_AFTER_S,
    LimitBusy,
    Limits,
    limited_request,
    note_bulk_actions,
)

router = APIRouter()


class ReasonBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=500)


class SwitchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool
    # By design, the admin's switch asks for a short reason too,
    # through the same dialog as every other action on someone's agents.
    reason: str = Field(min_length=1, max_length=500)


class ActionAnswer(BaseModel):
    action_id: str


class SwitchAnswer(BaseModel):
    event_id: str
    enabled: bool


def get_hosted_access(request: HTTPConnection) -> HostedAccess:
    """One per app, so the background parts of each action are kept. The
    controller revocation comes through the process wiring (`main` sets
    `controller_revoker` when agent management is on), so Core never imports
    agent management (`test_import_boundary`)."""
    access = getattr(request.app.state, "hosted_access", None)
    if not isinstance(access, HostedAccess):
        revoker = getattr(request.app.state, "controller_revoker", None)
        if revoker is None:
            raise HTTPException(
                status_code=503, detail="Hosted agents aren't managed on this server"
            )
        session_factory = get_session_factory()
        access = HostedAccess(
            session_factory=session_factory,
            revoker=revoker,
            key=get_keyed_id_key(request),
            keyring=get_config().keyring,
            # A8 and A9: a pause or turn-off still failed after 2 minutes.
            alert=action_alert(session_factory),
        )
        request.app.state.hosted_access = access
    return access


def _checked_id(value: str) -> str:
    if not value or len(value) > 64 or not all(c.isalnum() or c == "-" for c in value):
        raise HTTPException(status_code=404, detail="Not found")
    return value


_AUDIT_ACTION = {
    "pause": ServerAuditAction.HOSTED_USER_PAUSED,
    "resume": ServerAuditAction.HOSTED_USER_RESUMED,
}


async def _operator_action(
    action: str,
    user_keyed_id: str,
    body: ReasonBody,
    operator: User,
    access: HostedAccess,
    config: SwitchConfig,
) -> ActionAnswer:
    if not is_keyed_id(user_keyed_id):
        # Not even a keyed id: a plain 404, with nothing written or counted,
        # as before the limits.
        raise HTTPException(status_code=404, detail="Not found")
    limits = Limits.from_config(config)
    factory = access.session_factory
    now = datetime.now(UTC)
    # Resolved before the lock, so the lock covers only the count and the
    # request entry.
    user_id = await access.resolve_user(user_keyed_id)
    workspaces = await access.workspaces_for(user_id) if user_id else []
    try:
        request, over = await limited_request(
            factory,
            operator_id=operator.id,
            kind="action",
            limits=limits,
            now=now,
            action=_AUDIT_ACTION[action],
            target_type="user",
            target_keyed_id=user_keyed_id,
            reason=body.reason,
            workspaces=workspaces,
        )
    except AuditInputError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except LimitBusy:
        raise HTTPException(
            status_code=503,
            detail="Operator actions are busy. Try again in a minute.",
            headers={"Retry-After": "60"},
        ) from None
    # The request entry is written, so the attempt counts towards A11 however
    # it ends: refused, not found, done, or failed partway.
    try:
        if over:
            await record_operator_result(
                factory, request, result="failed", step=RATE_LIMITED
            )
            raise HTTPException(
                status_code=429,
                detail="Too many operator actions this hour. Try again later.",
                headers={"Retry-After": str(RETRY_AFTER_S)},
            )
        try:
            if user_id is None:
                raise LookupError("no such user")
            act = access.pause if action == "pause" else access.resume
            request = await act(
                actor_id=operator.id,
                user_id=user_id,
                reason=body.reason,
                request=request,
            )
        except LookupError:
            await record_operator_result(
                factory, request, result="failed", step="not_found"
            )
            raise HTTPException(status_code=404, detail="Not found") from None
    finally:
        await note_bulk_actions(factory, access.key, operator.id, limits, now)
    return ActionAnswer(action_id=request.event_id)


@router.post("/shared-cloud/users/{user_keyed_id}/pause")
async def pause_user(
    user_keyed_id: str,
    body: ReasonBody,
    operator: Annotated[User, Depends(require_operator)],
    access: Annotated[HostedAccess, Depends(get_hosted_access)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> ActionAnswer:
    return await _operator_action(
        "pause", user_keyed_id, body, operator, access, config
    )


@router.post("/shared-cloud/users/{user_keyed_id}/resume")
async def resume_user(
    user_keyed_id: str,
    body: ReasonBody,
    operator: Annotated[User, Depends(require_operator)],
    access: Annotated[HostedAccess, Depends(get_hosted_access)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> ActionAnswer:
    return await _operator_action(
        "resume", user_keyed_id, body, operator, access, config
    )


@router.put("/tenants/{tenant_id}/hosted-people/{user_id}")
async def set_member_hosted(
    tenant_id: str,
    user_id: str,
    body: SwitchBody,
    admin: Annotated[User, Depends(require_workspace_admin)],
    access: Annotated[HostedAccess, Depends(get_hosted_access)],
) -> SwitchAnswer:
    # The admin check is for the bound workspace: the path must name it.
    if current_tenant_id() != tenant_id:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        event_id = await access.set_member(
            actor_id=admin.id,
            tenant_id=tenant_id,
            user_id=_checked_id(user_id),
            enabled=body.enabled,
            reason=body.reason,
        )
    except AuditInputError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except LookupError:
        raise HTTPException(
            status_code=404, detail="Not a member of this workspace"
        ) from None
    return SwitchAnswer(event_id=event_id, enabled=body.enabled)
