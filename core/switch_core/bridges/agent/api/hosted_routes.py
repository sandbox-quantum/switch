import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
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
from switch_core.db.stores.hosted_machine_store import HostedMachineStore
from switch_core.gateway.github_connections import (
    GitHubReconnectRequired,
    conditions,
    github_credentials,
)
from switch_core.gateway.github_connections import lock as github_lock
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubConnections,
    GitHubError,
    GitHubUnavailableError,
)
from switch_core.providers.github_installation import (
    GitHubInstallationCredentials,
    granted_repositories,
    visible_installation,
)
from switch_core.providers.hosted import HostedControllerSettings

logger = logging.getLogger(__name__)

CLOUD_CONTROLLER_KIND = "ec2"

router = APIRouter(prefix="/hosted")


class GitHubCredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    installation_id: int = Field(gt=0, strict=True)


def _reconnect(detail: str) -> JSONResponse:
    return JSONResponse(
        {"detail": detail, "code": GitHubReconnectRequired.code},
        status_code=422,
        headers={"Cache-Control": "no-store"},
    )


def _hosted_settings(
    config: SwitchConfig, request: Request
) -> tuple[HostedControllerSettings, GitHubConnections]:
    """The cloud controller settings and the GitHub App, once the caller is
    known to be a Switch cloud controller of this tenant; 503 or 403
    otherwise."""
    if not config.hosted_controller_config_path or not config.hosted_github_config_path:
        raise HTTPException(503, "Cloud connection credentials are not enabled.")
    settings = HostedControllerSettings.model_validate_json(
        Path(config.hosted_controller_config_path).read_text()  # nosemgrep
    )
    if settings.tenant_id != require_tenant_id() or not isinstance(
        request.scope.get("controller"), ControllerPrincipal
    ):
        raise HTTPException(403, "This agent is not on a Switch cloud controller.")
    return settings, GitHubConnections(config.hosted_github_config_path)


@router.get("/connections", response_model=None)
async def connections(
    request: Request,
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict | JSONResponse:
    """The connections granted to the agent, with each GitHub installation's
    account and the names of the repositories a list grants, read live with
    the owner's GitHub sign-in. A granted installation whose grant no longer
    holds is listed with `error` in place of `repositories` (and a null
    `account` when the owner no longer sees it), so the others stay usable."""
    response.headers["Cache-Control"] = "no-store"
    _, github = _hosted_settings(config, request)
    row, grants = await _cloud_grants(session, agent, request.scope["controller"])
    owner_id = row.owner_id
    await session.commit()
    github_grant = grants.get("github")
    if github_grant is None:
        return {"connections": []}
    try:
        saved_github = await github_credentials(owner_id, session, config, github)
    except GitHubReconnectRequired as error:
        return _reconnect(str(error.detail))
    if saved_github is None:
        return _reconnect("The owner must reconnect GitHub.")
    try:
        visible = await github.repositories(saved_github[0]["access_token"])
    except GitHubAuthorizationError as error:
        return _reconnect(str(error))
    except GitHubUnavailableError as error:
        raise HTTPException(503, str(error)) from None
    except GitHubError as error:
        raise HTTPException(422, str(error)) from None
    installations: list[dict] = []
    for grant in github_grant["installations"]:
        installation_id = grant["installation_id"]
        account = next(
            (item["account"] for item in visible if item["id"] == installation_id),
            None,
        )
        try:
            installation = visible_installation(visible, installation_id)
            selected = granted_repositories(installation, grant["repositories"])
        except GitHubError as error:
            installations.append(
                {
                    "installation_id": installation_id,
                    "account": account,
                    "error": str(error),
                }
            )
            continue
        installations.append(
            {
                "installation_id": installation_id,
                "account": account,
                "repositories": "all"
                if grant["repositories"] == "all"
                else [repo["name"] for repo in selected],
            }
        )
    return {"connections": [{"slug": "github", "installations": installations}]}


@router.post("/connections/github/credential", response_model=None)
async def github_credential(
    body: GitHubCredentialRequest,
    request: Request,
    response: Response,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict | JSONResponse:
    response.headers["Cache-Control"] = "no-store"
    settings, github = _hosted_settings(config, request)
    try:
        return await _controller_github_credential(
            session,
            config,
            settings,
            github,
            agent,
            request.scope["controller"],
            body.installation_id,
        )
    except GitHubReconnectRequired as error:
        return _reconnect(str(error.detail))


async def _cloud_grants(
    session: AsyncSession, agent: Agent, principal: ControllerPrincipal
) -> tuple[AgentDefinitionRow, dict[str, dict]]:
    """The agent's definition and its connection grants by slug, when the
    agent is on the owner's Switch cloud controller that is asking; 403
    otherwise."""
    refused = HTTPException(403, "This agent is not on a Switch cloud controller.")
    controller = await session.get(
        AgentController, principal.controller_id, populate_existing=True
    )
    # Read afresh: the recheck after minting must see a change made meanwhile.
    row = await session.scalar(
        select(AgentDefinitionRow)
        .where(
            AgentDefinitionRow.tenant_id == require_tenant_id(),
            AgentDefinitionRow.agent_id == agent.id,
        )
        .execution_options(populate_existing=True)
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
    if await session.get(TenantMember, (require_tenant_id(), row.owner_id)) is None:
        raise HTTPException(
            403, "The cloud agent owner is no longer a workspace member."
        )
    return row, {
        grant["slug"]: grant for grant in row.definition.get("connections", [])
    }


def _installation_grant(grants: dict[str, dict], installation_id: int) -> dict:
    """The agent's grant of GitHub installation `installation_id`; 403 when
    the installation is not granted."""
    grant: dict | None = next(
        (
            item
            for item in grants.get("github", {}).get("installations", [])
            if item["installation_id"] == installation_id
        ),
        None,
    )
    if grant is None:
        raise HTTPException(
            403, "This GitHub installation is not granted to the agent."
        )
    return grant


async def _controller_github_credential(
    session: AsyncSession,
    config: SwitchConfig,
    settings: HostedControllerSettings,
    github: GitHubConnections,
    agent: Agent,
    principal: ControllerPrincipal,
    installation_id: int,
) -> dict:
    """An installation token for an agent a Switch cloud controller runs,
    limited to the agent's grant of that installation.

    The token is not recorded for revocation, so it lives out its hour. A
    token issued for a grant or GitHub connection that changed meanwhile is
    revoked at once.
    """
    row, grants = await _cloud_grants(session, agent, principal)
    grant = _installation_grant(grants, installation_id)
    owner_id = row.owner_id
    definition_revision = row.revision
    await session.commit()
    saved_github = await github_credentials(owner_id, session, config, github)
    if saved_github is None:
        raise GitHubReconnectRequired("The owner must reconnect GitHub.")
    credentials, github_revision = saved_github
    signer = GitHubInstallationCredentials(
        github.client_id, str(settings.github_private_key_path)
    )
    try:
        credential = await signer.issue(
            github,
            credentials["access_token"],
            installation_id,
            grant["repositories"],
        )
    except GitHubAuthorizationError as error:
        raise GitHubReconnectRequired(str(error)) from None
    except GitHubUnavailableError as error:
        raise HTTPException(503, str(error)) from None
    except GitHubError as error:
        raise HTTPException(422, str(error)) from None
    try:
        await github_lock(session, owner_id)
        current, current_grants = await _cloud_grants(session, agent, principal)
        github_row = await session.scalar(
            select(ProviderConnection)
            .where(*conditions(owner_id))
            .execution_options(populate_existing=True)
        )
        if (
            current.revision != definition_revision
            or _installation_grant(current_grants, installation_id) != grant
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
            "installation_id": credential.installation_id,
            "account": credential.account,
            "repositories": credential.repositories,
        }
    except BaseException:
        await session.rollback()
        try:
            await signer.revoke(credential.token)
        except Exception:
            logger.error(
                "Could not revoke an installation token issued for agent %s; it "
                "expires at %s",
                agent.id,
                credential.expires_at.isoformat(),
                exc_info=True,
            )
        raise
