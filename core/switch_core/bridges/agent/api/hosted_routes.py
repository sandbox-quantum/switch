import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import ControllerPrincipal, get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config, get_session
from switch_core.config import SwitchConfig
from switch_core.db.models import (
    Agent,
    AgentController,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.hosted_machine_store import HostedMachineStore
from switch_core.gateway.github_connections import (
    conditions,
    github_credentials,
)
from switch_core.gateway.github_connections import lock as github_lock
from switch_core.providers.github import (
    GitHubConnections,
    GitHubError,
    GitHubUnavailableError,
)
from switch_core.providers.github_installation import GitHubInstallationCredentials
from switch_core.providers.hosted import HostedControllerSettings

logger = logging.getLogger(__name__)

CLOUD_CONTROLLER_KIND = "ec2"

router = APIRouter(prefix="/hosted")


@router.post("/github-credential")
async def repository_credential(
    request: Request,
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if not config.hosted_controller_config_path or not config.hosted_github_config_path:
        raise HTTPException(503, "Cloud repository credentials are not enabled.")
    settings = HostedControllerSettings.model_validate_json(
        Path(config.hosted_controller_config_path).read_text()  # nosemgrep
    )
    if settings.tenant_id != require_tenant_id():
        raise HTTPException(403, "This agent is not on a Switch cloud controller.")
    principal = request.scope.get("controller")
    if isinstance(principal, ControllerPrincipal):
        return await _controller_repository_credential(
            session,
            config,
            settings,
            GitHubConnections(config.hosted_github_config_path),
            agent,
            principal,
        )
    raise HTTPException(403, "This agent is not on a Switch cloud controller.")


async def _cloud_repository(
    session: AsyncSession, agent: Agent, principal: ControllerPrincipal
) -> tuple[AgentDefinitionRow, int, int]:
    """The agent's definition and repository, when the agent is on the
    owner's Switch cloud controller that is asking; 403 otherwise."""
    refused = HTTPException(
        403, "This agent is not on a Switch cloud controller with a repository."
    )
    controller = await session.get(
        AgentController, principal.controller_id, populate_existing=True
    )
    row = await AgentDefinitionStore().get_for_agent(
        session, require_tenant_id(), agent.id
    )
    if (
        controller is None
        or controller.kind != CLOUD_CONTROLLER_KIND
        or controller.revoked_at is not None
        or controller.owner_id != agent.owner_id
        or row is None
        or row.controller_id != controller.id
        or row.owner_id != controller.owner_id
        or await HostedMachineStore().linking_controller(session, controller.id) is None
    ):
        raise refused
    repository = row.definition.get("repository")
    if not isinstance(repository, dict):
        raise refused
    if await session.get(TenantMember, (require_tenant_id(), row.owner_id)) is None:
        raise HTTPException(
            403, "The cloud agent owner is no longer a workspace member."
        )
    return row, repository["installation_id"], repository["repository_id"]


async def _controller_repository_credential(
    session: AsyncSession,
    config: SwitchConfig,
    settings: HostedControllerSettings,
    github: GitHubConnections,
    agent: Agent,
    principal: ControllerPrincipal,
) -> dict:
    """A repository token for an agent a Switch cloud controller runs, from
    the repository in the agent's definition.

    The token is not recorded for revocation, so it lives out its hour. A
    token issued for a definition that changed meanwhile is revoked at once.
    """
    row, installation_id, repository_id = await _cloud_repository(
        session, agent, principal
    )
    owner_id = row.owner_id
    definition_revision = row.revision
    await session.commit()
    saved_github = await github_credentials(owner_id, session, config, github)
    if saved_github is None:
        raise HTTPException(422, "The owner must reconnect GitHub.")
    credentials, github_revision = saved_github
    signer = GitHubInstallationCredentials(
        github.client_id, str(settings.github_private_key_path)
    )
    try:
        credential = await signer.issue(
            github,
            credentials["access_token"],
            installation_id,
            repository_id,
        )
    except GitHubUnavailableError as error:
        raise HTTPException(503, str(error)) from None
    except GitHubError as error:
        raise HTTPException(422, str(error)) from None
    try:
        await github_lock(session, owner_id)
        current, current_installation, current_repository = await _cloud_repository(
            session, agent, principal
        )
        github_row = await session.scalar(
            select(ProviderConnection)
            .where(*conditions(owner_id))
            .execution_options(populate_existing=True)
        )
        if (
            current.revision != definition_revision
            or (current_installation, current_repository)
            != (installation_id, repository_id)
            or github_row is None
            or github_row.verified_at != github_revision
        ):
            raise HTTPException(
                409, "The agent or its GitHub connection changed. Please retry."
            )
        await session.commit()
        return {
            "token": credential.token,
            "expires_at": credential.expires_at.isoformat(),
            "repository": credential.repository_name,
        }
    except BaseException:
        await session.rollback()
        try:
            await signer.revoke(credential.token)
        except Exception:
            logger.error(
                "Could not revoke a repository token issued for agent %s; it "
                "expires at %s",
                agent.id,
                credential.expires_at.isoformat(),
                exc_info=True,
            )
        raise
