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

import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi import Path as PathParam
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import CloudMachine
from switch_core.gateway.dependencies import get_config, get_session_factory
from switch_core.gateway.hosted_controller import _refuse
from switch_core.gateway.hosted_machines import controller_settings
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import no_tenant
from switch_core.visibility.box_provision import (
    ProvisionRefused,
    box_allowed,
    box_provisioning_on,
    claim_provision,
    record_provision_result,
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
    user_keyed_id: str
    size: str | None
    lease_seconds: int
    # Sent back with the result; a result with an older claim's token is
    # refused, so a worker whose lease passed can't report over a new one.
    claim_token: str


class ProvisionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    result: Literal["done", "failed"]
    namespace: str = Field(min_length=1, max_length=63)
    failed_at: str | None = Field(default=None, max_length=32)
    claim_token: str = Field(min_length=1, max_length=64)


@router.post("/claim", response_model=None)
async def claim(
    session: Annotated[AsyncSession, Depends(provisioner_session)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
) -> ProvisionClaim | Response:
    async def is_blocked(machine_id: str) -> bool:
        # The gates again, at claim: provisioning turned off, or
        # the owner paused, turned off or off the lists since Core asked.
        if not box_provisioning_on(config):
            return True
        machine = await session.get(CloudMachine, machine_id)
        return machine is None or not await box_allowed(
            factory, config, settings, machine
        )

    claimed = await claim_provision(session, datetime.now(UTC), is_blocked)
    await session.commit()
    if claimed is None:
        return Response(status_code=204)
    return ProvisionClaim(
        action_id=claimed.action_id,
        machine_id=claimed.machine_id,
        user_keyed_id=claimed.user_keyed_id,
        size=claimed.size,
        lease_seconds=claimed.lease_seconds,
        claim_token=claimed.claim_token,
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
