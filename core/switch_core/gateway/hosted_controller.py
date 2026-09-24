import json
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import AgentExistsError, ProtocolService
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    HostedLaunch,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session_factory,
)
from switch_core.gateway.github_connections import conditions, connection_status
from switch_core.gateway.github_connections import service as get_github
from switch_core.gateway.hosted_launches import controller_settings, summary
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.providers.github import GitHubConnections, GitHubError
from switch_core.providers.github_installation import GitHubInstallationCredentials
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import tenant_scope

router = APIRouter(prefix="/hosted-controller")


async def controller_session(
    request: Request,
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[AsyncSession]:
    """Authenticate the operator controller and bind its configured tenant.

    The bearer credential can provision only this tenant's reserved workers;
    it is never accepted as a user or agent credential on other routes.
    """
    supplied = request.headers.get("authorization", "")
    if not secrets.compare_digest(
        supplied, "Bearer " + settings.token.get_secret_value()
    ):
        raise HTTPException(401, "Invalid cloud controller credential.")
    with tenant_scope(settings.tenant_id):
        async with factory() as session:
            yield session


async def launch_by_id(session: AsyncSession, request_id: UUID) -> HostedLaunch:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"hosted-launch:{require_tenant_id()}:{request_id}"},
    )
    launch = await session.get(
        HostedLaunch, (require_tenant_id(), str(request_id)), populate_existing=True
    )
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    return launch


@router.get("")
async def pending(
    session: Annotated[AsyncSession, Depends(controller_session)],
) -> list[dict]:
    launches = await session.scalars(
        select(HostedLaunch)
        .where(HostedLaunch.tenant_id == require_tenant_id())
        .order_by(HostedLaunch.created_at)
    )
    return [summary(launch) for launch in launches]


@router.post("/{request_id}/prepare")
async def prepare(
    request_id: UUID,
    response: Response,
    session: Annotated[AsyncSession, Depends(controller_session)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
    github: Annotated[GitHubConnections, Depends(get_github)],
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    launch = await session.get(HostedLaunch, (require_tenant_id(), str(request_id)))
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    revision = launch.revision
    if await session.get(TenantMember, (require_tenant_id(), launch.owner_id)) is None:
        raise HTTPException(
            422, "The cloud agent owner is no longer a workspace member."
        )
    if (
        launch.state == "error"
        or launch.desired_state != "running"
        or launch.agent_id not in {str(value) for value in settings.agent_ids}
    ):
        raise HTTPException(409, "Cloud launch cannot be provisioned.")
    await connection_status(launch.owner_id, session, config, github)
    github_connection = await session.scalar(
        select(ProviderConnection).where(*conditions(launch.owner_id))
    )
    provider = launch.spec.get("provider", "claude")
    connection = await session.get(
        ProviderConnection, (require_tenant_id(), launch.owner_id, provider)
    )
    if github_connection is None or connection is None:
        raise HTTPException(
            422, "Reconnect your providers before launching the cloud agent."
        )
    credentials = json.loads(
        decrypt_token(github_connection.encrypted_credential, config.jwt_secret_key)
    )
    signer = GitHubInstallationCredentials(
        github.client_id, str(settings.github_private_key_path)
    )
    try:
        repository = await signer.issue(
            github,
            credentials["access_token"],
            launch.spec["installation_id"],
            launch.spec["repository_id"],
        )
    except GitHubError as error:
        raise HTTPException(422, str(error)) from None
    await session.commit()
    launch = await launch_by_id(session, request_id)
    if (
        launch.revision != revision
        or launch.desired_state != "running"
        or launch.state == "error"
    ):
        raise HTTPException(409, "Cloud launch changed during preparation.")
    if (
        await session.get(
            TenantMember, (require_tenant_id(), launch.owner_id), populate_existing=True
        )
        is None
    ):
        raise HTTPException(
            422, "The cloud agent owner is no longer a workspace member."
        )
    agent = await session.get(Agent, launch.agent_id)
    if agent is None:
        known_type = "claude-code" if provider == "claude" else provider
        known = KNOWN_AGENTS[known_type]
        options = known.parse_options(
            {
                "channels_enabled": True,
                "repo_dir": "/data/workspace",
                "auto_session": launch.spec["auto_session"],
            }
        )
        try:
            await protocol.register_agent(
                reserved_agent_id=launch.agent_id,
                name=launch.name,
                description=launch.spec["description"],
                display_name=launch.spec["display_name"],
                icon_url=launch.spec["icon_url"],
                connector_type=known.connector_type,
                integration_profile=known.build_profile(options),
                tools=known.tools,
                models=known.models,
                metadata={
                    "known_agent_type": known_type,
                    "known_agent_options": options.model_dump(),
                    "hosted_launch_id": launch.id,
                },
                owner_id=launch.owner_id,
            )
        except AgentExistsError:
            raise HTTPException(422, "An agent already uses this name.") from None
        agent = await session.get(Agent, launch.agent_id)
    if (
        agent is None
        or agent.owner_id != launch.owner_id
        or agent.tenant_id != require_tenant_id()
        or (agent.metadata_ or {}).get("hosted_launch_id") != launch.id
    ):
        raise HTTPException(409, "The cloud worker identity is already in use.")
    key = await session.get(ApiKey, agent.api_key_id)
    if key is None or not key.encrypted_key:
        raise HTTPException(409, "The cloud agent credential is unavailable.")
    if launch.spec["addressing_policy"] is not None:
        agent.addressing_policy = launch.spec["addressing_policy"]
    launch.state = "provisioning"
    launch.error = None
    launch.updated_at = datetime.now(UTC)
    await session.commit()
    return {
        "agent_id": agent.id,
        "provider_kind": connection.kind,
        "switch_credentials": {
            "env": {
                "SWITCH_API_ENDPOINT": settings.agent_api_endpoint,
                "SWITCH_API_TOKEN": decrypt_token(
                    key.encrypted_key, config.jwt_secret_key
                ),
                "SWITCH_AGENT_ID": agent.id,
            }
        },
        "github_credential": repository.token,
        "github_expires_at": repository.expires_at.isoformat(),
        "repository": repository.repository_name,
        "spec": launch.spec,
    }


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal[
        "provisioning", "running", "error", "stopping", "stopped", "deleting", "deleted"
    ]
    revision: int = Field(ge=1)
    error: str | None = Field(default=None, max_length=512)


@router.post("/{request_id}/observation")
async def observe(
    request_id: UUID,
    body: Observation,
    session: Annotated[AsyncSession, Depends(controller_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict:
    launch = await launch_by_id(session, request_id)
    if body.revision != launch.revision:
        return summary(launch)
    if launch.state == "error" and launch.desired_state == "running":
        return summary(launch)
    if launch.desired_state == "running" and body.state in {"stopping", "stopped"}:
        body = body.model_copy(update={"state": "provisioning"})
    previous_state = launch.state
    if launch.desired_state in {"stopped", "restart", "deleted"} and body.state not in {
        "stopped",
        "deleted",
        "error",
    }:
        launch.state = "deleting" if launch.desired_state == "deleted" else "stopping"
    elif launch.desired_state == "deleted" and body.state == "stopped":
        launch.state = "deleting"
    elif launch.desired_state == "restart" and body.state == "stopped":
        launch.desired_state = "running"
        launch.revision += 1
        launch.state = "queued"
        launch.error = None
    elif body.state in {"stopping", "stopped", "deleting", "deleted"}:
        launch.state = body.state
        launch.error = None
    elif body.state == "error":
        launch.state = "error"
        launch.error = (
            body.error
            or "The cloud worker could not start. Retry after checking provider access and server capacity."
        )
    else:
        listening = (
            any(
                (connection.spawn_capable or not launch.spec["auto_session"])
                for connection in protocol.connections.for_agent(launch.agent_id)
            )
            if launch.agent_id
            else False
        )
        launch.state = (
            "ready" if body.state == "running" and listening else "provisioning"
        )
        launch.error = None
        if (
            launch.state == "provisioning"
            and previous_state == "provisioning"
            and datetime.now(UTC) - launch.updated_at > timedelta(minutes=10)
        ):
            launch.state = "error"
            launch.error = "The worker did not connect within 10 minutes. Check provider access and worker startup logs, then retry."
        if launch.state == "ready":
            launch.sleeping = False
            now = datetime.now(UTC)
            if previous_state != "ready" or await HostedLaunchStore().idle_busy(
                session, launch
            ):
                launch.active_at = now
            elif (
                config.hosted_idle_stop_minutes > 0
                and launch.spec["auto_session"]
                and now - launch.active_at
                >= timedelta(minutes=config.hosted_idle_stop_minutes)
            ):
                launch.desired_state = "stopped"
                launch.state = "stopping"
                launch.revision += 1
                launch.error = None
                launch.sleeping = True
    if launch.state != previous_state:
        launch.updated_at = datetime.now(UTC)
    await session.commit()
    return summary(launch)
