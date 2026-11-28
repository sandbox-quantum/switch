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
import logging
import secrets
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.box_cluster import box_cluster_on
from switch_core.config import SwitchConfig
from switch_core.db.models import CloudMachine
from switch_core.db.stores import hosted_pool_store
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_controller import _refuse, revoke_owned_box_controllers
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.observability.hosted import record_box_removal
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import no_tenant
from switch_core.visibility.box_provision import (
    ProvisionRefused,
    action_is_open,
    box_allowed,
    claim_provision,
    record_pool_box_gone,
    record_provision_result,
    record_provision_step,
)
from switch_core.visibility.box_removal import (
    RemovalRefused,
    claim_removal,
    confirmed_gone_among,
    record_removal_gone,
    removal_verdict,
    unjustified_entries,
)

logger = logging.getLogger(__name__)

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
    # The operator's live boxes (box map entries not in `box-removals`) and
    # the ceiling it refuses new boxes at, for the near-ceiling alert.
    boxes_live: int | None = Field(default=None, ge=0, le=1_000_000)
    ceiling: int | None = Field(default=None, ge=1, le=1_000_000)
    # The box namespaces in its box map (sorted), for the orphan check: a box
    # on the cluster that Core has no live machine for. Optional: a box map it
    # couldn't read is left out.
    boxes: list[Annotated[str, Field(max_length=63)]] | None = Field(
        default=None, max_length=20_000
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
        boxes_live=report.boxes_live,
        box_ceiling=report.ceiling,
    )
    await session.commit()
    if report.boxes_live is not None and report.ceiling is not None:
        await near_ceiling_alerts(factory, report.boxes_live, report.ceiling)
    deadline = time.monotonic() + wait_s
    while True:
        found = await _claim_once(
            session, factory, config, settings, capabilities, report.template_revision
        )
        if found is not None or time.monotonic() >= deadline:
            return found if found is not None else Response(status_code=204)
        await asyncio.sleep(_POLL_S)


# The near-ceiling alert's two levels, as a share of the operator's ceiling.
NEAR_CEILING = (("box_map_80", 80.0), ("box_map_95", 95.0))


async def near_ceiling_alerts(
    factory: async_sessionmaker[AsyncSession], boxes_live: int, ceiling: int
) -> None:
    """Raise A14 at each level the operator's live boxes have reached, and
    clear it below. Only a change writes a row (`apply_alert`); an alert that
    fails is logged and the claim goes on."""
    from switch_core.visibility.alerts import Condition, Verdict, apply_alert

    used = round(100.0 * boxes_live / ceiling, 1)
    for target, level in NEAR_CEILING:
        try:
            await apply_alert(
                factory,
                Verdict(Condition.BOX_MAP_NEAR_CEILING, target, used >= level, used),
            )
        except Exception:  # noqa: BLE001 -- the claim goes on without it
            logger.exception("Could not update the near-ceiling alert")


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
        if not box_cluster_on():
            return True
        machine = await session.get(CloudMachine, machine_id)
        return machine is None or not await box_allowed(
            factory, config, settings, machine
        )

    async def pool_blocked(pool_box_id: str) -> bool:
        # A pool box has no person: only the server's switches gate it, and
        # it must still be the `requested` row this action is for.
        if not box_cluster_on() or getattr(config, "hosted_pool_size", 0) <= 0:
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
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> Response:
    try:
        owned = await record_provision_result(
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
    if owned is not None:
        # A bind that failed after its owner was written: the box is the
        # person's, removed through the normal path, controllers revoked.
        await revoke_owned_box_controllers(factory, [owned])
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


async def remover_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate box removal's remover, on a session with no tenant bound.
    Its own bearer, never the reaper's, so a leak of either pod's credential
    gives only that pod's power. With no `remover_token` configured, every
    call is refused."""
    supplied = request.headers.get("authorization", "")
    token = settings.remover_token
    if token is None or not secrets.compare_digest(
        supplied, "Bearer " + token.get_secret_value()
    ):
        _refuse(request, supplied, route="hosted_remover")
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


# ── box removal: the provisioner claims and confirms, the remover checks ──

_MACHINE_ID = PathParam(pattern=r"^[0-9a-f-]{36}$")
# A box namespace of either shape: person-keyed or box-keyed, each a keyed id.
_NAMESPACE = r"^agents-(user|box)-k[0-9]{1,3}-[0-9a-f]{16}$"


class RemovalClaim(BaseModel):
    machine_id: str
    # The namespace to list in `box-removals`, and the one the remover's check
    # and the confirmation are held to.
    namespace: str
    box_keyed_id: str
    lease_seconds: int
    claim_token: str


class RemovalGone(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claim_token: str = Field(min_length=1, max_length=64)


class RemovalCheck(BaseModel):
    removable: bool
    # For the remover's log: none, pending, claimed, cancelled or gone.
    state: str


class ListedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    namespace: str = Field(pattern=_NAMESPACE)
    machine_id: str = Field(pattern=r"^[0-9a-f-]{36}$")


class ListedReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: list[ListedEntry] = Field(max_length=20_000)


class ListedAnswer(BaseModel):
    # How many reported entries Core doesn't back (each raised an alert).
    unjustified: int
    # The reported namespaces Core has confirmed gone: the only entries the
    # admin compaction runbook may remove from the lists.
    confirmed_gone: list[str]


async def _alert_unjustified(
    factory: async_sessionmaker[AsyncSession], machine_ids: list[str]
) -> None:
    """A12 for each box Core doesn't back, after the caller's commit. An alert
    that fails is logged; the answer stands."""
    from switch_core.visibility.alerts import Condition, Verdict, apply_alert
    from switch_core.visibility.dependencies import process_keyed_id_key
    from switch_core.visibility.keyed_id import KeyedIdKind

    key = process_keyed_id_key()
    if key is None:
        return
    for machine_id in machine_ids:
        try:
            await apply_alert(
                factory,
                Verdict(
                    Condition.BOX_REMOVAL_UNJUSTIFIED,
                    key.keyed_id(KeyedIdKind.BOX, machine_id),
                    True,
                    None,
                ),
            )
        except Exception:  # noqa: BLE001 -- the refusal stands without it
            logger.exception("Could not raise a box removal alert")


@router.post("/removals/claim", response_model=None)
async def removal_claim(
    session: Annotated[AsyncSession, Depends(provisioner_session)],
) -> RemovalClaim | Response:
    """The next box named for removal, claimed for a lease, or 204."""
    claimed = await claim_removal(session, datetime.now(UTC))
    await session.commit()
    if claimed is None:
        return Response(status_code=204)
    record_box_removal("claimed")
    return RemovalClaim(
        machine_id=claimed.machine_id,
        namespace=claimed.namespace,
        box_keyed_id=claimed.box_keyed_id,
        lease_seconds=claimed.lease_seconds,
        claim_token=claimed.claim_token,
    )


@router.post("/removals/{machine_id}/gone", status_code=204)
async def removal_gone(
    machine_id: Annotated[str, _MACHINE_ID],
    body: RemovalGone,
    session: Annotated[AsyncSession, Depends(provisioner_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> Response:
    """The provisioner's confirmation that the box's namespace and volumes are
    gone. Refused (409), with an alert, unless it's the removal's current
    claim of a machine still deleted and named for removal."""
    try:
        wrote = await record_removal_gone(
            session, machine_id, body.claim_token, datetime.now(UTC)
        )
    except RemovalRefused as refused:
        await session.rollback()
        logger.error("A box removal confirmation was refused: %s", refused)
        record_box_removal("refused")
        await _alert_unjustified(factory, [machine_id])
        raise HTTPException(refused.status, str(refused)) from None
    await session.commit()
    if wrote:
        record_box_removal("removed")
    return Response(status_code=204)


@router.get("/removals/{machine_id}")
async def removal_check(
    machine_id: Annotated[str, _MACHINE_ID],
    namespace: Annotated[str, Query(pattern=_NAMESPACE)],
    session: Annotated[AsyncSession, Depends(remover_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> RemovalCheck:
    """The remover's check before deleting a listed namespace: `removable` only
    for a claimed, uncancelled removal of a deleted machine, under the
    namespace Core recorded. Anything else is false, logged and alerted; the
    remover never deletes on false."""
    verdict = await removal_verdict(session, machine_id, namespace)
    await session.commit()
    if not verdict.removable and verdict.state != "gone":
        logger.error(
            "The remover asked to remove a box Core doesn't back (state %s).",
            verdict.state,
        )
        record_box_removal("refused")
        await _alert_unjustified(factory, [machine_id])
    return RemovalCheck(removable=verdict.removable, state=verdict.state)


@router.post("/removals/listed")
async def removals_listed(
    body: ListedReport,
    session: Annotated[AsyncSession, Depends(remover_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> ListedAnswer:
    """The `box-removals` entries the remover read this pass. Core alerts on
    each one it doesn't back: a wrong entry is permanent (the list is
    add-only), so it must never go unseen."""
    reported = [(entry.namespace, entry.machine_id) for entry in body.entries]
    unbacked = await unjustified_entries(session, reported)
    gone = await confirmed_gone_among(session, reported)
    await session.commit()
    if unbacked:
        logger.error("%d box-removals entries have no claim from Core.", len(unbacked))
        record_box_removal("unjustified", len(unbacked))
        await _alert_unjustified(factory, [machine_id for _, machine_id in unbacked])
    return ListedAnswer(unjustified=len(unbacked), confirmed_gone=gone)
