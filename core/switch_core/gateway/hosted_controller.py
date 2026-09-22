import json
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
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
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
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
    launch = await session.get(HostedLaunch, (require_tenant_id(), str(request_id)))
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
    launch = await launch_by_id(session, request_id)
    if await session.get(TenantMember, (require_tenant_id(), launch.owner_id)) is None:
        raise HTTPException(
            422, "The cloud agent owner is no longer a workspace member."
        )
    if launch.state == "error" or launch.agent_id not in {
        str(value) for value in settings.agent_ids
    }:
        raise HTTPException(409, "Cloud launch cannot be provisioned.")
    # OAuth refresh commits before registration, so reacquire the launch lock afterwards.
    await connection_status(launch.owner_id, session, config, github)
    launch = await launch_by_id(session, request_id)
    github_connection = await session.scalar(
        select(ProviderConnection).where(*conditions(launch.owner_id))
    )
    claude = await ProviderConnectionStore().get(session, launch.owner_id)
    if github_connection is None or claude is None:
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
    agent = await session.get(Agent, launch.agent_id)
    if agent is None:
        known = KNOWN_AGENTS["claude-code"]
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
                    "known_agent_type": "claude-code",
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
        "provider_kind": claude.kind,
        "provider_credential": decrypt_token(
            claude.encrypted_credential, config.jwt_secret_key
        ),
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
    state: Literal["provisioning", "running", "error"]


@router.post("/{request_id}/observation")
async def observe(
    request_id: UUID,
    body: Observation,
    session: Annotated[AsyncSession, Depends(controller_session)],
    protocol: Annotated[ProtocolService, Depends(get_protocol)],
) -> dict:
    launch = await launch_by_id(session, request_id)
    if body.state == "error":
        launch.state = "error"
        launch.error = (
            "The cloud worker could not start. Contact your server administrator."
        )
    else:
        listening = (
            any(
                connection.spawn_capable
                for connection in protocol.connections.for_agent(launch.agent_id)
            )
            if launch.agent_id
            else False
        )
        launch.state = (
            "ready" if body.state == "running" and listening else "provisioning"
        )
        launch.error = None
    launch.updated_at = datetime.now(UTC)
    await session.commit()
    return summary(launch)
