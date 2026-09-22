import json
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config, get_session
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Agent,
    HostedLaunch,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.gateway.github_connections import conditions, connection_status
from switch_core.providers.github import GitHubConnections, GitHubError
from switch_core.providers.github_installation import GitHubInstallationCredentials
from switch_core.providers.hosted import HostedControllerSettings

router = APIRouter(prefix="/hosted")


@router.post("/github-credential")
async def repository_credential(
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if not config.hosted_controller_config_path or not config.hosted_github_config_path:
        raise HTTPException(503, "Cloud repository credentials are not enabled.")
    settings = HostedControllerSettings.model_validate_json(
        Path(config.hosted_controller_config_path).read_text()
    )
    if settings.tenant_id != require_tenant_id():
        raise HTTPException(403, "This agent is not a managed cloud worker.")
    launch = await session.scalar(
        select(HostedLaunch).where(
            HostedLaunch.tenant_id == require_tenant_id(),
            HostedLaunch.agent_id == agent.id,
            HostedLaunch.owner_id == agent.owner_id,
            HostedLaunch.state != "error",
        )
    )
    if launch is None:
        raise HTTPException(403, "This agent is not a managed cloud worker.")
    if await session.get(TenantMember, (require_tenant_id(), launch.owner_id)) is None:
        raise HTTPException(
            403, "The cloud agent owner is no longer a workspace member."
        )
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"hosted-launch:{require_tenant_id()}:{launch.id}"},
    )
    github = GitHubConnections(config.hosted_github_config_path)
    await connection_status(launch.owner_id, session, config, github)
    row = await session.scalar(
        select(ProviderConnection).where(*conditions(launch.owner_id))
    )
    if row is None:
        raise HTTPException(422, "The owner must reconnect GitHub.")
    credentials = json.loads(
        decrypt_token(row.encrypted_credential, config.jwt_secret_key)
    )
    signer = GitHubInstallationCredentials(
        github.client_id, str(settings.github_private_key_path)
    )
    try:
        credential = await signer.issue(
            github,
            credentials["access_token"],
            launch.spec["installation_id"],
            launch.spec["repository_id"],
        )
    except GitHubError as error:
        raise HTTPException(422, str(error)) from None
    return {
        "token": credential.token,
        "expires_at": credential.expires_at.isoformat(),
        "repository": credential.repository_name,
    }
