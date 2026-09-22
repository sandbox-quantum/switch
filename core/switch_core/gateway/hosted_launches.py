import json
from datetime import UTC, datetime
from typing import Annotated, Literal, Self, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import AddressingPolicy
from switch_core.agent_display_name import normalise_display_name
from switch_core.agent_icon import normalise_icon_url
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token
from switch_core.db.models import HostedLaunch, User, require_tenant_id
from switch_core.db.stores.hosted_launch_store import (
    HostedLaunchConflict,
    HostedLaunchStore,
)
from switch_core.db.stores.provider_connection_store import (
    ProviderConnectionBusy,
    ProviderConnectionStore,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.github_connections import connection_status
from switch_core.gateway.github_connections import service as get_github
from switch_core.gateway.provider_connections import get_verifier
from switch_core.providers.claude_verifier import (
    ClaudeVerificationError,
    ClaudeVerifier,
)
from switch_core.providers.github import GitHubConnections
from switch_core.providers.hosted import HostedControllerSettings

router = APIRouter(prefix="/hosted-launches")


def controller_settings(request: Request) -> HostedControllerSettings:
    settings = request.app.state.hosted_controller_settings
    if settings is None:
        raise HTTPException(503, "Cloud agent launch is not enabled on this server.")
    return cast(HostedControllerSettings, settings)


class LaunchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: UUID
    name: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,127}$")
    description: str = Field(min_length=1, max_length=4096)
    display_name: str | None
    icon_url: str | None
    instructions: str = Field(max_length=32768)
    definition: str = Field(min_length=1, max_length=65536)
    installation_id: int = Field(gt=0, strict=True)
    repository_id: int = Field(gt=0, strict=True)
    definition_attributes: dict
    auto_session: Literal[True]
    auto_approve: bool
    addressing_policy: AddressingPolicy | None

    @model_validator(mode="after")
    def bounded_spec(self) -> Self:
        if len(json.dumps(self.model_dump(mode="json")).encode()) > 32768:
            raise ValueError("Cloud agent configuration must fit within 32 KiB.")
        return self


def summary(launch: HostedLaunch) -> dict:
    return {
        "request_id": launch.id,
        "name": launch.name,
        "state": launch.state,
        "agent_id": launch.agent_id,
        "error": launch.error,
    }


@router.get("")
async def owned_launches(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[dict]:
    rows = await session.scalars(
        select(HostedLaunch)
        .where(
            HostedLaunch.tenant_id == require_tenant_id(),
            HostedLaunch.owner_id == user.id,
        )
        .order_by(HostedLaunch.created_at)
    )
    return [summary(row) for row in rows]


@router.get("/{request_id}")
async def status(
    request_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    return summary(launch)


@router.post("", status_code=202)
async def create(
    body: LaunchRequest,
    user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[HostedControllerSettings, Depends(controller_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    verifier: Annotated[ClaudeVerifier, Depends(get_verifier)],
    github: Annotated[GitHubConnections, Depends(get_github)],
) -> dict:
    if config.hosted_launch_capacity == 0 or settings.tenant_id != require_tenant_id():
        raise HTTPException(503, "Cloud agent launch is not enabled on this server.")
    try:
        body.icon_url = normalise_icon_url(body.icon_url)
        body.display_name = normalise_display_name(body.display_name)
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    spec = body.model_dump(mode="json", exclude={"request_id"})
    store = HostedLaunchStore()
    existing = await store.owned(session, str(body.request_id), user.id)
    if existing:
        if existing.spec != spec:
            raise HTTPException(
                409, "This launch request was already used for different agent details."
            )
        return summary(existing)
    connections = ProviderConnectionStore()
    try:
        await connections.lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    claude = await connections.get(session, user.id)
    if claude is None:
        raise HTTPException(422, "Connect Claude Code before creating a cloud agent.")
    try:
        await verifier.verify(
            claude.kind,
            decrypt_token(claude.encrypted_credential, config.jwt_secret_key),
        )
    except ClaudeVerificationError as error:
        raise HTTPException(422, str(error)) from None
    await connections.save(
        session, user.id, claude.kind, claude.encrypted_credential, datetime.now(UTC)
    )
    await session.commit()
    access = await connection_status(user.id, session, config, github)
    repository = next(
        (
            repo
            for installation in access.get("installations", [])
            if installation["id"] == body.installation_id
            for repo in installation["repositories"]
            if repo["id"] == body.repository_id
        ),
        None,
    )
    if repository is None:
        raise HTTPException(
            422, "Your GitHub account no longer has access to the selected repository."
        )
    try:
        launch = await store.reserve(
            session,
            request_id=str(body.request_id),
            owner_id=user.id,
            name=body.name,
            spec=spec,
            capacity=config.hosted_launch_capacity,
            agent_ids=[str(value) for value in settings.agent_ids],
        )
    except HostedLaunchConflict as error:
        raise HTTPException(409, str(error)) from None
    await session.commit()
    return summary(launch)
