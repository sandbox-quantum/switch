"""The box provisioner's two routes, on its own credential.

The provisioner is a separate pod on its own cluster account (one of three
identities: controller, provisioner, drain). On Core's side it has its own
bearer, `provisioner_token` in the hosted controller settings, accepted on
these two routes and nowhere else; the controller's `token` is refused here,
and the provisioner's is refused on every controller route (they're compared
to different secrets).

- `POST /hosted-provisioner/claim`: 204, or the oldest open provision with
  `{action_id, machine_id, user_keyed_id, size, lease_seconds, claim_token}`.
  Ids and a size only; the provisioner names the namespace from the keyed id.
  The gates are checked again here: a request whose owner was paused, turned
  off or taken off the lists since Core asked ends `failed` at `blocked`.
- `POST /hosted-provisioner/actions/{action_id}/result`:
  `{result, namespace, failed_at, claim_token}`, codes only, checked against
  the request. Accepted after the lease if the token is still the current
  claim's and the request hasn't expired (15 minutes).
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import CloudMachine
from switch_core.db.stores import hosted_pool_store
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_controller import _refuse
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import no_tenant
from switch_core.visibility.box_provision import (
    ProvisionRefused,
    action_is_open,
    box_allowed,
    box_provisioning_on,
    claim_provision,
    record_pool_box_gone,
    record_provision_result,
    record_provision_step,
)

router = APIRouter(prefix="/hosted-provisioner")


async def provisioner_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate the provisioner, on a session with no tenant bound. With
    no `provisioner_token` configured, every call is refused."""
    supplied = request.headers.get("authorization", "")
    token = settings.provisioner_token
    if token is None or not secrets.compare_digest(
        supplied, "Bearer " + token.get_secret_value()
    ):
        _refuse(request, supplied, route="hosted_provisioner")
    with no_tenant():
        async with factory() as session:
            yield session


class ProvisionClaim(BaseModel):
    action_id: str
    machine_id: str
    # None for a `pool` action: a pool box has no person.
    user_keyed_id: str | None
    size: str | None
    lease_seconds: int
    # Sent back with the result; a result with an older claim's token is
    # refused, so a worker whose lease passed can't report over a new one.
    claim_token: str
    # `provision` (today's), `pool` or `bind`; an operator that reported no
    # `capabilities` only ever gets `provision`.
    kind: str
    # Core's keyed id for the box, and the exact namespace the result must
    # name: the operator never derives either.
    box_keyed_id: str
    namespace: str


class ClaimRequest(BaseModel):
    """What the operator says about itself with each claim. Optional: an
    operator from before sends no body, and is treated as one with no
    capabilities."""

    model_config = ConfigDict(extra="forbid")

    template_revision: str | None = Field(
        default=None, max_length=64, pattern=r"^[A-Za-z0-9._-]+$"
    )
    # Fixed words (`box_keyed_names`, `pool`, `bind`); any other is ignored.
    capabilities: list[Annotated[str, Field(max_length=32)]] = Field(
        default_factory=list, max_length=8
    )


class StepReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # A bind's write-ahead step, sent before the operator writes the box's
    # owner (B2): from then on Core treats the box as the person's. The claim
    # token travels in `X-Claim-Token`, as on the re-check.
    step: Literal["owner_writing"]


class ActionState(BaseModel):
    # True only while this claim is current, the action has no result and
    # hasn't expired, and Core hasn't failed it.
    open: bool


class ProvisionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result: Literal["done", "failed"]
    namespace: str = Field(min_length=1, max_length=63)
    failed_at: str | None = Field(default=None, max_length=32)
    claim_token: str = Field(min_length=1, max_length=64)


# The longest a claim waits for an action before answering 204.
MAX_WAIT_S = 25
# How often a waiting claim looks again.
_POLL_S = 0.5


@router.post("/claim", response_model=None)
async def claim(
    session: Annotated[AsyncSession, Depends(provisioner_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    body: ClaimRequest | None = None,
    wait_s: Annotated[int, Query(ge=0, le=MAX_WAIT_S)] = 0,
) -> ProvisionClaim | Response:
    """The next action this operator can carry out, or 204. With `wait_s`,
    it answers as soon as one is open, or 204 at the timeout (a long-poll).
    The operator's revision and capabilities are recorded on each call."""
    report = body or ClaimRequest()
    capabilities = hosted_pool_store.known_capabilities(report.capabilities)
    await hosted_pool_store.record_operator(
        session,
        template_revision=report.template_revision,
        capabilities=capabilities,
        now=datetime.now(UTC),
    )
    await session.commit()
    deadline = time.monotonic() + wait_s
    while True:
        found = await _claim_once(
            session, factory, config, settings, capabilities, report.template_revision
        )
        if found is not None or time.monotonic() >= deadline:
            return found if found is not None else Response(status_code=204)
        await asyncio.sleep(_POLL_S)


async def _claim_once(
    session: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    settings: HostedControllerSettings,
    capabilities: frozenset[str],
    template_revision: str | None,
) -> ProvisionClaim | None:
    async def is_blocked(machine_id: str) -> bool:
        # The gates again, at claim: provisioning turned off, or
        # the owner paused, turned off or off the lists since Core asked.
        if not box_provisioning_on(config):
            return True
        machine = await session.get(CloudMachine, machine_id)
        return machine is None or not await box_allowed(
            factory, config, settings, machine
        )

    async def pool_blocked(pool_box_id: str) -> bool:
        # A pool box has no person: only the server's switches gate it, and
        # it must still be the `requested` row this action is for.
        if (
            not box_provisioning_on(config)
            or getattr(config, "hosted_pool_size", 0) <= 0
        ):
            return True
        row = await hosted_pool_store.get(session, pool_box_id)
        return row is None or row.state != "requested"

    claimed = await claim_provision(
        session,
        datetime.now(UTC),
        is_blocked,
        capabilities=capabilities,
        pool_blocked=pool_blocked,
        template_revision=template_revision,
    )
    await session.commit()
    if claimed is None:
        return None
    return ProvisionClaim(
        action_id=claimed.action_id,
        machine_id=claimed.machine_id,
        user_keyed_id=claimed.user_keyed_id,
        size=claimed.size,
        lease_seconds=claimed.lease_seconds,
        claim_token=claimed.claim_token,
        kind=claimed.kind,
        box_keyed_id=claimed.box_keyed_id,
        namespace=claimed.namespace,
    )


@router.post("/actions/{action_id}/result", status_code=204)
async def result(
    action_id: Annotated[str, PathParam(pattern=r"^[A-Za-z0-9-]{1,64}$")],
    body: ProvisionResult,
    session: Annotated[AsyncSession, Depends(provisioner_session)],
) -> Response:
    try:
        await record_provision_result(
            session,
            action_id=action_id,
            result=body.result,
            namespace=body.namespace,
            failed_at=body.failed_at,
            claim_token=body.claim_token,
            now=datetime.now(UTC),
        )
    except ProvisionRefused as refused:
        await session.rollback()
        raise HTTPException(refused.status, str(refused)) from None
    await session.commit()
    return Response(status_code=204)


_ACTION_ID = PathParam(pattern=r"^[A-Za-z0-9-]{1,64}$")


@router.get("/actions/{action_id}")
async def action_state(
    action_id: Annotated[str, _ACTION_ID],
    request: Request,
    session: Annotated[AsyncSession, Depends(provisioner_session)],
) -> ActionState:
    """The re-check before a bind's last step (B4): whether this claim of the
    action is still open. The claim token comes in `X-Claim-Token`, read here
    only and never logged."""
    token = request.headers.get("x-claim-token", "")
    is_open = await action_is_open(session, action_id, token, datetime.now(UTC))
    await session.commit()
    return ActionState(open=is_open)


@router.post("/actions/{action_id}/steps", status_code=204)
async def step(
    action_id: Annotated[str, _ACTION_ID],
    body: StepReport,
    request: Request,
    session: Annotated[AsyncSession, Depends(provisioner_session)],
) -> Response:
    """A bind's write-ahead step, `owner_writing`, before the operator writes
    the box's owner, with the claim token in `X-Claim-Token` (read here only,
    never logged). Refused (409) unless the bind is still open: the operator
    then writes nothing, and the box stays reapable."""
    try:
        await record_provision_step(
            session,
            action_id=action_id,
            step=body.step,
            claim_token=request.headers.get("x-claim-token", ""),
            now=datetime.now(UTC),
        )
    except ProvisionRefused as refused:
        await session.rollback()
        raise HTTPException(refused.status, str(refused)) from None
    await session.commit()
    return Response(status_code=204)


# ── the reaper's two routes, on its own bearer ──


async def reaper_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate the warm pool's reaper, on a session with no tenant bound.
    With no `reaper_token` configured, every call is refused."""
    supplied = request.headers.get("authorization", "")
    token = settings.reaper_token
    if token is None or not secrets.compare_digest(
        supplied, "Bearer " + token.get_secret_value()
    ):
        _refuse(request, supplied, route="hosted_reaper")
    with no_tenant():
        async with factory() as session:
            yield session


class RetiringBox(BaseModel):
    pool_box_id: str
    namespace: str | None


class RetiringList(BaseModel):
    boxes: list[RetiringBox]


@router.get("/pool/retiring")
async def pool_retiring(
    session: Annotated[AsyncSession, Depends(reaper_session)],
) -> RetiringList:
    """The pool boxes the reaper may destroy: `retiring`, with a reason that
    means nothing of a person's ever reached them. Ids and namespaces only."""
    rows = await hosted_pool_store.retiring(session)
    await session.commit()
    return RetiringList(
        boxes=[RetiringBox(pool_box_id=row.id, namespace=row.namespace) for row in rows]
    )


@router.post("/pool/{pool_box_id}/gone", status_code=204)
async def pool_gone(
    pool_box_id: Annotated[str, PathParam(pattern=r"^[0-9a-f-]{36}$")],
    session: Annotated[AsyncSession, Depends(reaper_session)],
) -> Response:
    """The reaper destroyed a retiring pool box. Refused (409), with an
    alert, for any box that isn't retiring with a reapable reason, or whose
    bind reached `owner_writing`; Core writes the `retired` audit entry."""
    try:
        await record_pool_box_gone(session, pool_box_id, datetime.now(UTC))
    except ProvisionRefused as refused:
        await session.rollback()
        raise HTTPException(refused.status, str(refused)) from None
    await session.commit()
    return Response(status_code=204)
