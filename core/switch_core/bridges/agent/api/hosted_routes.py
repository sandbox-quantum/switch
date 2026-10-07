from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.api.hosted_worker_routes import refusal, require_worker
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config, get_protocol, get_session
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.config import SwitchConfig
from switch_core.connections.broker import (
    Principal,
    ServiceBroker,
    ServiceError,
    get_service_broker,
)
from switch_core.db.models import (
    Agent,
    HostedLaunch,
    HostedOperation,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.hosted_launches import operation_summary

router = APIRouter(prefix="/hosted")


@router.post("/provider-credential")
async def provider_credential(
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    launch = await worker_launch(session, agent)
    connection = await session.scalar(
        select(ProviderConnection).where(
            ProviderConnection.tenant_id == require_tenant_id(),
            ProviderConnection.user_id == launch.owner_id,
            ProviderConnection.provider == launch.spec.get("provider", "claude"),
        )
    )
    if connection is None:
        return {"status": "revoked"}
    return {
        "status": "connected",
        "kind": connection.kind,
        "provider": connection.provider,
        "revision": str(connection.verified_at),
        "credential": config.keyring.decrypt(connection.encrypted_credential),
    }


async def worker_launch(session: AsyncSession, agent: Agent) -> HostedLaunch:
    launch = await session.scalar(
        select(HostedLaunch).where(
            HostedLaunch.tenant_id == require_tenant_id(),
            HostedLaunch.agent_id == agent.id,
            HostedLaunch.owner_id == agent.owner_id,
            HostedLaunch.desired_state == "running",
            HostedLaunch.state != "error",
        )
    )
    if (
        launch is None
        or await session.get(TenantMember, (require_tenant_id(), launch.owner_id))
        is None
    ):
        raise HTTPException(
            403, "This worker is not authorized to execute cloud operations."
        )
    return launch


async def operation_launch(session: AsyncSession, agent: Agent) -> HostedLaunch:
    launch = await worker_launch(session, agent)
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"hosted-launch:{require_tenant_id()}:{launch.id}"},
    )
    session.expire(launch)
    return await worker_launch(session, agent)


class ProviderStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    authenticated: bool
    revision: str


@router.post("/provider-status")
async def provider_status(
    body: ProviderStatus,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    current = await worker_launch(session, agent)
    await ProviderConnectionStore().wait_user(session, current.owner_id)
    launch = await session.scalar(
        select(HostedLaunch)
        .where(
            HostedLaunch.tenant_id == require_tenant_id(),
            HostedLaunch.id == current.id,
            HostedLaunch.desired_state == "running",
            HostedLaunch.state != "error",
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if launch is None:
        raise HTTPException(409, "The worker changed during verification.")
    connection = await session.get(
        ProviderConnection,
        (require_tenant_id(), launch.owner_id, launch.spec.get("provider", "claude")),
    )
    if connection is None:
        raise HTTPException(409, "The provider was disconnected.")
    if str(connection.verified_at) != body.revision:
        raise HTTPException(409, "The provider credential changed during verification.")
    connection.verification_status = "verified" if body.authenticated else "configured"
    if not body.authenticated:
        launch.error = (
            "The provider could not authenticate on the worker. "
            "Sign in again locally, then reconnect it and retry."
        )
        launch.state = "error"
    await session.commit()
    return {"verified": body.authenticated}


class WorkerFence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0)


async def locked_operation(
    session: AsyncSession, launch: HostedLaunch, operation_id: UUID
) -> HostedOperation:
    operation = await session.scalar(
        select(HostedOperation)
        .where(
            HostedOperation.tenant_id == require_tenant_id(),
            HostedOperation.id == str(operation_id),
            HostedOperation.launch_id == launch.id,
        )
        .with_for_update()
    )
    if operation is None:
        raise HTTPException(404, "Cloud operation not found.")
    return operation


@router.post("/operations/{operation_id}/claim")
async def claim_operation(
    operation_id: UUID,
    body: WorkerFence,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict:
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    launch = await operation_launch(session, agent)
    operation = await locked_operation(session, launch, operation_id)
    assert conn.worker is not None
    reclaim = (
        operation.state == "claimed"
        and operation.claimed_boot_id == conn.worker.boot_id
    )
    if (
        (operation.state != "queued" and not reclaim)
        or operation.launch_revision != launch.revision
        or conn.worker.launch_revision != launch.revision
    ):
        raise refusal(
            409, "operation_not_claimable", "This operation cannot be claimed."
        )
    operation.state = "claimed"
    operation.claimed_by = f"{protocol.event_buffer.boot}:{conn.id}:{body.generation}"
    operation.claimed_boot_id = conn.worker.boot_id
    operation.updated_at = datetime.now(UTC)
    await session.commit()
    return operation_summary(operation)


class OperationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0)
    state: Literal["applied", "failed", "unknown"]
    error: str | None = Field(max_length=512)


@router.post("/operations/{operation_id}/result")
async def operation_result(
    operation_id: UUID,
    body: OperationResult,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict:
    conn = require_worker(
        protocol.connections, agent, body.connection_id, body.generation
    )
    launch = await operation_launch(session, agent)
    operation = await locked_operation(session, launch, operation_id)
    assert conn.worker is not None
    if operation.launch_revision != launch.revision:
        raise HTTPException(
            409, "The operation belongs to an earlier worker generation."
        )
    if operation.claimed_boot_id != conn.worker.boot_id:
        raise refusal(
            409, "operation_not_claimed", "This worker did not claim the operation."
        )
    if operation.state not in ("claimed", body.state):
        raise HTTPException(409, "This operation is no longer awaiting a result.")
    operation.state = body.state
    operation.error = body.error
    operation.updated_at = datetime.now(UTC)
    await session.commit()
    return operation_summary(operation)


@router.post("/github-credential")
async def repository_credential(
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict:
    """A cloud worker's GitHub token, for workers from before the agent route.

    Issued by the broker on the agent's GitHub grant, as
    `POST /agents/{agent_id}/service-tokens/github` issues it, and answered in
    the shape those workers check: their repository, by name. Goes in the next
    release.
    """
    response.headers["Cache-Control"] = "no-store"
    launch = await session.scalar(
        select(HostedLaunch).where(
            HostedLaunch.tenant_id == require_tenant_id(),
            HostedLaunch.agent_id == agent.id,
            HostedLaunch.owner_id == agent.owner_id,
            HostedLaunch.state != "error",
            HostedLaunch.desired_state == "running",
        )
    )
    if launch is None or launch.repository is None:
        raise HTTPException(403, "This agent is not a managed cloud worker.")
    launch_id, revision, repository = launch.id, launch.revision, launch.repository
    try:
        token = await broker.issue(session, agent.id, Principal.agent_key(), "github")
    except ServiceError as error:
        raise HTTPException(error.status_code, error.message) from None
    # A launch change while the token was issued ends the worker it was for.
    # The lifecycle routes queue the agent's tokens under this lock, so either
    # they saw this token's record or this sees their change.
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"hosted-launch:{require_tenant_id()}:{launch_id}"},
    )
    current = await session.get(
        HostedLaunch, (require_tenant_id(), launch_id), populate_existing=True
    )
    if (
        current is None
        or current.revision != revision
        or current.desired_state != "running"
        or current.state == "error"
    ):
        issued = await broker.queue_agent_revocation(session, agent.id, "github")
        await session.commit()
        await broker.revoke_pending(session, issued)
        raise HTTPException(409, "The cloud launch changed. Please retry.")
    await session.commit()
    return {
        "token": token.token,
        "expires_at": token.expires_at.isoformat(),
        "repository": repository,
    }
