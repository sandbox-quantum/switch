"""Where each hosted agents v2 box connects, as security events.

The box cluster's squid logs one line per request a box makes. The network
reporter beside it (`switch-network-report`, the hosted controller image) sums
them per box every minute and posts one report for the whole cluster here, on
its own bearer (`network_report_token`, accepted on this route alone). This writes one
log-only security event per box per report (`security.hosted.box_network`),
with the machine and its owner: the box's totals, how many distinct hosts it
reached, and its busiest hosts by id (at most `MAX_HOSTS`, the rest summed). The log
pipeline alerts per box on upload volume, fan-out to many hosts or refusals, as
it does for agents in rooms. A host is named only by the reporter's random id,
never by its name. So Core gets one small request a minute per squid replica,
however many boxes there are, and the log a line per box per replica a minute.

Nothing is stored. Squid names a box by its proxy login, which is derived from
the box's namespace: `box-k1-…` for a box-keyed box (the box's keyed id) and
`k1-…` for an older person-keyed one (the owner's keyed id). Core alone holds
the key that turns a machine or person into those ids, so it resolves them
here. A box it can't resolve (gone, or a pool box with no owner yet) is still
logged, by its squid id.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import CloudMachine
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.hosted_controller import _refuse
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.security_events import SecuritySignal, log_security_event
from switch_core.tenant_context import no_tenant
from switch_core.visibility.dependencies import process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKind

router = APIRouter(prefix="/hosted-network")

# A box's squid id: `box-k1-<16 hex>` (box-keyed) or `k1-<16 hex>` (person-keyed).
BOX_ID = r"^(box-)?k1-[0-9a-f]{16}$"
# A host as the reporter names it: a random id it keeps in memory (it never sends a hostname).
HOST_MAX_LENGTH = 32
# The busiest hosts a box's line names; the reporter sums the rest.
MAX_HOSTS = 10
MAX_BOXES = 2000
COUNT = Field(ge=0, le=1 << 50)


class HostTotals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host: str = Field(min_length=1, max_length=HOST_MAX_LENGTH)
    requests: int = COUNT
    denied: int = COUNT
    bytes_up: int = COUNT
    bytes_down: int = COUNT


class BoxNetwork(BaseModel):
    model_config = ConfigDict(extra="forbid")

    box: str = Field(pattern=BOX_ID)
    requests: int = COUNT
    denied: int = COUNT
    bytes_up: int = COUNT
    bytes_down: int = COUNT
    # Every host the box reached in the window, the controller's login and
    # the agents' together; `hosts` names the busiest of them.
    distinct_hosts: int = COUNT
    hosts: list[HostTotals] = Field(max_length=MAX_HOSTS)


class NetworkReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    window_seconds: int = Field(ge=1, le=3600)
    boxes: list[BoxNetwork] = Field(max_length=MAX_BOXES)
    # Requests squid logged without a box's login (refused before any box's
    # rule): counted, so a gap is visible rather than silent.
    unattributed_requests: int = COUNT
    # Windows the reporter couldn't send and dropped (Core unreachable).
    dropped_windows: int = Field(default=0, ge=0, le=1_000_000)


async def network_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate the network reporter, on a session with no tenant bound.
    With no `network_report_token` configured, every call is refused."""
    supplied = request.headers.get("authorization", "")
    token = settings.network_report_token
    if token is None or not secrets.compare_digest(
        supplied, "Bearer " + token.get_secret_value()
    ):
        _refuse(request, supplied, route="hosted_network")
    with no_tenant():
        async with factory() as session:
            yield session


async def resolve_boxes(
    session: AsyncSession, boxes: set[str]
) -> dict[str, tuple[str, str]]:
    """Squid id to (machine id, owner id), for the boxes Core can name."""
    key = process_keyed_id_key()
    if key is None or not boxes:
        return {}
    rows = (
        await session.execute(
            select(CloudMachine.id, CloudMachine.owner_id).where(
                CloudMachine.backend == "box", CloudMachine.state != "deleted"
            )
        )
    ).all()
    found: dict[str, tuple[str, str]] = {}
    for machine_id, owner_id in rows:
        by_box = "box-" + key.keyed_id(KeyedIdKind.BOX, machine_id)
        by_owner = key.keyed_id(KeyedIdKind.USER, owner_id)
        for squid_id in (by_box, by_owner):
            if squid_id in boxes:
                found[squid_id] = (machine_id, owner_id)
    return found


@router.post("/report", status_code=204)
async def report(
    body: NetworkReport,
    session: Annotated[AsyncSession, Depends(network_session)],
) -> Response:
    owners = await resolve_boxes(session, {box.box for box in body.boxes})
    for box in body.boxes:
        machine_id, owner_id = owners.get(box.box, (None, None))
        named = box.hosts
        log_security_event(
            SecuritySignal.HOSTED_BOX_NETWORK,
            tenant_id=None,
            actor_user_id=owner_id,
            target_type="cloud_machine",
            target_id=machine_id,
            agent_id=None,
            room_id=None,
            details={
                "box": box.box,
                "window_seconds": body.window_seconds,
                "requests": box.requests,
                "denied": box.denied,
                "bytes_up": box.bytes_up,
                "bytes_down": box.bytes_down,
                "distinct_hosts": box.distinct_hosts,
                "other_hosts": max(box.distinct_hosts - len(named), 0),
                "hosts": json.dumps(
                    [h.model_dump() for h in named], separators=(",", ":")
                ),
            },
        )
    if body.unattributed_requests or body.dropped_windows:
        log_security_event(
            SecuritySignal.HOSTED_BOX_NETWORK_UNATTRIBUTED,
            tenant_id=None,
            actor_user_id=None,
            target_type="egress_proxy",
            target_id=None,
            agent_id=None,
            room_id=None,
            details={
                "requests": body.unattributed_requests,
                "dropped_windows": body.dropped_windows,
                "window_seconds": body.window_seconds,
            },
        )
    return Response(status_code=204)
