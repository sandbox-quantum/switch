import json
from datetime import UTC, datetime
from typing import Annotated, Literal, Self, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import AddressingPolicy
from switch_core.agent_display_name import normalise_display_name
from switch_core.agent_icon import normalise_icon_url
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    HostedLaunch,
    HostedOperation,
    ProviderConnection,
    SdkSession,
    User,
    require_tenant_id,
)
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
    provider: Literal["claude", "codex", "opencode", "cursor", "antigravity"] = "claude"
    definition: str = Field(max_length=65536)
    installation_id: int = Field(gt=0, strict=True)
    repository_id: int = Field(gt=0, strict=True)
    definition_attributes: dict
    auto_session: bool
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
        "provider": launch.spec.get("provider", "claude"),
        "state": launch.state,
        "agent_id": launch.agent_id,
        "error": launch.error,
        "desired_state": launch.desired_state,
        "revision": launch.revision,
        "sleeping": launch.sleeping,
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


class LifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["stop", "start", "restart", "remove", "retry"]
    revision: int = Field(ge=1)


@router.post("/{request_id}/lifecycle")
async def lifecycle(
    request_id: UUID,
    body: LifecycleRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"hosted-launch:{require_tenant_id()}:{request_id}"},
    )
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    if launch.revision != body.revision and not (
        body.action == "stop"
        and launch.sleeping
        and launch.desired_state == "stopped"
        and launch.revision == body.revision + 1
    ):
        raise HTTPException(
            409, "The worker changed. Refresh its status before trying again."
        )
    if launch.desired_state == "deleted":
        raise HTTPException(409, "This worker has been removed.")
    if body.action == "remove" and launch.state != "stopped":
        raise HTTPException(
            409, "Stop the worker before removing it. Its data disk will be retained."
        )
    if body.action == "restart" and launch.state != "ready":
        raise HTTPException(409, "Only a ready worker can be restarted.")
    already_stopped = launch.state == "stopped"
    launch.desired_state = {
        "stop": "stopped",
        "start": "running",
        "restart": "restart",
        "remove": "deleted",
        "retry": "running",
    }[body.action]
    launch.state = {
        "stopped": "stopping",
        "running": "queued",
        "restart": "stopping",
        "deleted": "deleting",
    }[launch.desired_state]
    if body.action == "stop" and already_stopped:
        launch.state = "stopped"
    launch.error = None
    launch.sleeping = False
    launch.revision += 1
    launch.updated_at = datetime.now(UTC)
    await session.commit()
    return summary(launch)


def operation_summary(operation: HostedOperation) -> dict:
    return {
        "id": operation.id,
        "session_id": operation.session_id,
        "action": operation.action,
        "state": operation.state,
        "error": operation.error,
    }


class SessionOperationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    session_id: UUID
    action: Literal["start", "restart"]


@router.post("/{request_id}/sessions", status_code=202)
async def session_operation(
    request_id: UUID,
    body: SessionOperationRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"hosted-launch:{require_tenant_id()}:{request_id}"},
    )
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    existing = await session.get(HostedOperation, (require_tenant_id(), str(body.id)))
    if existing:
        if (
            existing.launch_id != launch.id
            or existing.action != body.action
            or existing.session_id != str(body.session_id)
        ):
            raise HTTPException(
                409, "This operation ID was already used for different details."
            )
        return operation_summary(existing)
    if launch.state != "ready" or launch.desired_state != "running":
        raise HTTPException(409, "Start the cloud worker and wait until it is ready.")
    target = await session.get(SdkSession, (require_tenant_id(), str(body.session_id)))
    if body.action == "restart" and (
        target is None or target.agent_id != launch.agent_id
    ):
        raise HTTPException(404, "Cloud session not found.")
    if body.action == "start" and target is not None:
        raise HTTPException(409, "This session already exists.")
    pending = list(
        await session.scalars(
            select(HostedOperation).where(
                HostedOperation.tenant_id == require_tenant_id(),
                HostedOperation.launch_id == launch.id,
                HostedOperation.state.in_(["queued", "claimed"]),
            )
        )
    )
    if any(row.session_id == str(body.session_id) for row in pending):
        raise HTTPException(409, "This session already has a pending operation.")
    active = list(
        await session.scalars(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.agent_id == launch.agent_id,
            )
        )
    )
    if (
        body.action == "start"
        or target is not None
        and target.snapshot.get("session", {}).get("status") in ("stopped", "error")
    ) and sum(
        row.snapshot.get("session", {}).get("status") not in ("stopped", "error")
        and not row.snapshot.get("session", {}).get("retired")
        for row in active
    ) + len(pending) >= config.hosted_sessions_per_agent:
        raise HTTPException(
            409,
            "This worker has reached its session limit. Stop a session before starting another.",
        )
    operation = HostedOperation(
        id=str(body.id),
        launch_id=launch.id,
        session_id=str(body.session_id),
        action=body.action,
    )
    session.add(operation)
    await session.commit()
    return operation_summary(operation)


@router.get("/{request_id}/sessions/{operation_id}")
async def session_operation_status(
    request_id: UUID,
    operation_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    operation = await session.get(
        HostedOperation, (require_tenant_id(), str(operation_id))
    )
    if launch is None or operation is None or operation.launch_id != launch.id:
        raise HTTPException(404, "Cloud operation not found.")
    return operation_summary(operation)


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
    spec["session_limit"] = config.hosted_sessions_per_agent
    store = HostedLaunchStore()
    existing = await store.owned(session, str(body.request_id), user.id)
    if existing:
        previous = {"provider": "claude", **existing.spec}
        previous.pop("session_limit", None)
        requested = {
            key: value for key, value in spec.items() if key != "session_limit"
        }
        if previous != requested:
            raise HTTPException(
                409, "This launch request was already used for different agent details."
            )
        return summary(existing)
    connections = ProviderConnectionStore()
    try:
        await connections.lock_user(session, user.id)
    except ProviderConnectionBusy as error:
        raise HTTPException(409, str(error)) from None
    connection = await session.get(
        ProviderConnection, (require_tenant_id(), user.id, body.provider)
    )
    if connection is None:
        raise HTTPException(
            422, "Connect the selected provider before creating a cloud agent."
        )
    if body.provider == "claude":
        if not body.definition:
            raise HTTPException(422, "Claude Code requires an agent definition.")
        try:
            await verifier.verify(
                connection.kind,
                decrypt_token(connection.encrypted_credential, config.jwt_secret_key),
            )
        except ClaudeVerificationError as error:
            raise HTTPException(422, str(error)) from None
        await connections.save(
            session,
            user.id,
            connection.kind,
            connection.encrypted_credential,
            datetime.now(UTC),
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
            owner_capacity=config.hosted_agents_per_owner,
            agent_ids=[str(value) for value in settings.agent_ids],
        )
    except HostedLaunchConflict as error:
        raise HTTPException(409, str(error)) from None
    await session.commit()
    return summary(launch)
