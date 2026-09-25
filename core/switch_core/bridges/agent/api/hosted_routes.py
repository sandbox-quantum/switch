from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config, get_session
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Agent,
    HostedLaunch,
    HostedOperation,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.github_connections import (
    conditions,
    discard_github_credential,
    github_credentials,
)
from switch_core.gateway.github_connections import lock as github_lock
from switch_core.gateway.hosted_launches import operation_summary
from switch_core.providers.github import (
    GitHubConnections,
    GitHubError,
    GitHubUnavailableError,
)
from switch_core.providers.github_installation import GitHubInstallationCredentials
from switch_core.providers.github_revocations import remember_repository_token
from switch_core.providers.hosted import HostedControllerSettings

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
        "credential": decrypt_token(
            connection.encrypted_credential, config.jwt_secret_key
        ),
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


@router.post("/operations/claim")
async def claim_operation(
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict | None:
    launch = await operation_launch(session, agent)
    rows = list(
        await session.scalars(
            select(HostedOperation)
            .where(
                HostedOperation.tenant_id == require_tenant_id(),
                HostedOperation.launch_id == launch.id,
                HostedOperation.state.in_(["queued", "claimed"]),
            )
            .order_by(HostedOperation.created_at)
            .with_for_update()
        )
    )
    now = datetime.now(UTC)
    for operation in rows:
        if operation.launch_revision != launch.revision:
            operation.state = "unknown" if operation.state == "claimed" else "failed"
            operation.error = (
                "The worker changed. Inspect the session if the outcome is unknown."
            )
            operation.updated_at = now
            continue
        if operation.state == "claimed" and operation.updated_at < now - timedelta(
            minutes=5
        ):
            operation.state = "unknown"
            operation.error = "The worker did not confirm the outcome. Inspect the session before issuing another operation."
        elif operation.state == "queued":
            operation.state = "claimed"
            operation.updated_at = now
            await session.commit()
            return operation_summary(operation)
    await session.commit()
    return None


class OperationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["applied", "failed", "unknown"]
    error: str | None = Field(max_length=512)


@router.post("/operations/{operation_id}/result")
async def operation_result(
    operation_id: UUID,
    body: OperationResult,
    agent: Annotated[Agent, Depends(get_agent_from_scope)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    launch = await operation_launch(session, agent)
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
    if operation.launch_revision != launch.revision:
        raise HTTPException(
            409, "The operation belongs to an earlier worker generation."
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
            HostedLaunch.desired_state == "running",
        )
    )
    if launch is None:
        raise HTTPException(403, "This agent is not a managed cloud worker.")
    if await session.get(TenantMember, (require_tenant_id(), launch.owner_id)) is None:
        raise HTTPException(
            403, "The cloud agent owner is no longer a workspace member."
        )
    revision = launch.revision
    launch_id = launch.id
    owner_id = launch.owner_id
    installation_id = launch.spec["installation_id"]
    repository_id = launch.spec["repository_id"]
    github = GitHubConnections(config.hosted_github_config_path)
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
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"hosted-launch:{require_tenant_id()}:{launch_id}"},
        )
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), launch_id), populate_existing=True
        )
        row = await session.scalar(
            select(ProviderConnection)
            .where(*conditions(owner_id))
            .execution_options(populate_existing=True)
        )
        if (
            launch is None
            or launch.revision != revision
            or launch.desired_state != "running"
            or launch.state == "error"
            or row is None
            or row.verified_at != github_revision
            or await session.get(
                TenantMember, (require_tenant_id(), owner_id), populate_existing=True
            )
            is None
        ):
            raise HTTPException(
                409, "Cloud launch or GitHub connection changed. Please retry."
            )
        remember_repository_token(session, launch, credential, config)
        await session.commit()
        return {
            "token": credential.token,
            "expires_at": credential.expires_at.isoformat(),
            "repository": credential.repository_name,
        }
    except BaseException as error:
        await discard_github_credential(
            session, signer, credential, config, launch_id, error
        )
        raise
