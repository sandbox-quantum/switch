import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Annotated, Literal, Self, cast
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import AddressingPolicy
from switch_core.agent_display_name import normalise_display_name
from switch_core.agent_icon import normalise_icon_url
from switch_core.bridges.agent.api.hosted_worker_routes import (
    post_mailbox_notices,
    post_room_notice,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore, AgentExistsError
from switch_core.config import SwitchConfig
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    GitHubIssuedToken,
    HostedLaunch,
    HostedMachine,
    HostedOperation,
    ProviderConnection,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.hosted_launch_store import (
    HostedLaunchConflict,
    HostedLaunchStore,
)
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineConflict,
    HostedMachineStore,
    idle_sleeping,
    machine_starting,
    owner_stopped,
)
from switch_core.db.stores.hosted_mailbox_store import (
    HostedMailboxStore,
    MailboxNotice,
    one_per_room,
)
from switch_core.db.stores.provider_connection_store import (
    ProviderConnectionBusy,
    ProviderConnectionStore,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_protocol, get_session
from switch_core.gateway.github_connections import connection_status
from switch_core.gateway.github_connections import service as get_github
from switch_core.gateway.known_agents import KNOWN_AGENTS
from switch_core.gateway.provider_connections import get_verifier
from switch_core.providers.claude_verifier import (
    ClaudeVerificationError,
    ClaudeVerifier,
)
from switch_core.providers.github import GitHubConnections, repository_writable
from switch_core.providers.github_revocations import (
    ACCESS_WARNING,
    queue_revocation,
    revoke_pending,
)
from switch_core.providers.hosted import HostedControllerSettings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hosted-launches")

IDENTITY_FAILED = (
    "Switch could not create this cloud agent's identity. Retry it to try again."
)
MACHINE_ERROR = "The cloud machine needs attention. Retry it in Switch Console."
MACHINE_ERROR_NEEDS_ADMIN = (
    "The cloud machine needs attention. Contact your server administrator."
)
MACHINE_STOPPED = "The owner stopped the cloud machine. Start it in Switch Console."
WORKER_WAKING = "The cloud machine is starting. Try again in a moment."


def coded_conflict(code: str, message: str) -> JSONResponse:
    """A 409 whose `detail` is the message and whose `code` names the refusal."""
    return JSONResponse(status_code=409, content={"detail": message, "code": code})


def machine_error_detail(machine: HostedMachine) -> str:
    """Why an errored machine refuses work, and whether retrying it can help."""
    if machine.error_code == "machine_needs_attention":
        return MACHINE_ERROR_NEEDS_ADMIN
    return MACHINE_ERROR


LAUNCH_DISABLED = "Cloud agent launch is not enabled on this server."


def hosted_settings(request: Request) -> HostedControllerSettings | None:
    return cast(
        HostedControllerSettings | None, request.app.state.hosted_controller_settings
    )


def controller_settings(request: Request) -> HostedControllerSettings:
    settings = hosted_settings(request)
    if settings is None:
        raise HTTPException(503, LAUNCH_DISABLED)
    return settings


def launch_enabled(config: SwitchConfig, settings: HostedControllerSettings) -> bool:
    """Whether the bound tenant may claim cloud machines on this server."""
    return (
        config.hosted_launch_capacity > 0 and settings.tenant_id == require_tenant_id()
    )


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


def summary(launch: HostedLaunch, machine: HostedMachine | None) -> dict:
    return {
        "request_id": launch.id,
        "name": launch.name,
        "provider": launch.spec.get("provider", "claude"),
        "state": launch.state,
        "agent_id": launch.agent_id,
        "error": launch.error,
        "error_code": launch.error_code,
        "desired_state": launch.desired_state,
        "revision": launch.revision,
        "sleeping": machine is not None and idle_sleeping(machine),
        "machine_id": launch.machine_id,
        "process_state": launch.process_state,
        "process_restarts": launch.process_restarts,
        "oom_kills": launch.process_oom_kills,
    }


async def launch_summary(session: AsyncSession, launch: HostedLaunch) -> dict:
    machine = (
        None
        if launch.machine_id is None
        else await HostedMachineStore().get(session, launch.machine_id)
    )
    return summary(launch, machine)


def worktree_path(agent_id: str, repository: str | None) -> str:
    """The agent's worktree on its machine's disk, which is also its `repo_dir`."""
    if repository is None:
        return f"/data/worktrees/{agent_id}/workspace"
    return f"/data/worktrees/{agent_id}/{repository.lower()}"


async def locked_owned(
    session: AsyncSession, request_id: str, owner_id: str
) -> tuple[HostedLaunch, HostedMachine]:
    """The owner's launch and its machine, locked machine first, then launch."""
    launch, machine = await HostedMachineStore().locked_launch(session, request_id)
    if launch is None or launch.owner_id != owner_id:
        raise HTTPException(404, "Cloud launch not found.")
    if machine is None:
        raise RuntimeError(f"Cloud launch {launch.id} has no machine.")
    return launch, machine


@router.get("")
async def owned_launches(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[dict]:
    rows = list(
        await session.scalars(
            select(HostedLaunch)
            .where(
                HostedLaunch.tenant_id == require_tenant_id(),
                HostedLaunch.owner_id == user.id,
            )
            .order_by(HostedLaunch.created_at)
        )
    )
    machine_ids = {row.machine_id for row in rows if row.machine_id is not None}
    machines = {
        machine.id: machine
        for machine in await session.scalars(
            select(HostedMachine).where(
                HostedMachine.tenant_id == require_tenant_id(),
                HostedMachine.id.in_(machine_ids),
            )
        )
    }
    return [
        summary(row, None if row.machine_id is None else machines[row.machine_id])
        for row in rows
    ]


@router.get("/{request_id}")
async def status(
    request_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    return await launch_summary(session, launch)


class ConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    instructions: str = Field(max_length=32768)
    definition: str = Field(max_length=65536)
    definition_attributes: dict


def configuration(spec: dict) -> dict:
    return {
        "description": spec["description"],
        "instructions": spec["instructions"],
        "definition_attributes": spec["definition_attributes"],
    }


@router.get("/{request_id}/configuration")
async def get_configuration(
    request_id: UUID,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    launch = await HostedLaunchStore().owned(session, str(request_id), user.id)
    if launch is None:
        raise HTTPException(404, "Cloud launch not found.")
    return configuration(launch.spec)


@router.put("/{request_id}/configuration")
async def update_configuration(
    request_id: UUID,
    body: ConfigurationRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
    """Replace the launch's instructions and definition; the agent's next start runs them.

    The revision is not bumped: a running agent keeps its deployment until a
    lifecycle action issues a new revision, which the machine applies from
    this spec.
    """
    launch, _machine = await locked_owned(session, str(request_id), user.id)
    if launch.desired_state == "deleted":
        raise HTTPException(409, "This worker has been removed.")
    if launch.spec.get("provider", "claude") == "claude" and not body.definition:
        raise HTTPException(422, "Claude Code requires an agent definition.")
    changes = body.model_dump(mode="json")
    spec = {**launch.spec, **changes}
    bounded = {key: value for key, value in spec.items() if key != "session_limit"}
    if len(json.dumps(bounded).encode()) > 32768:
        raise HTTPException(422, "Cloud agent configuration must fit within 32 KiB.")
    await HostedLaunchStore().merge_spec(session, launch.id, changes)
    await session.commit()
    return configuration(spec)


async def _register(protocol: AgentCore, launch: HostedLaunch, agent_id: str) -> None:
    provider = launch.spec.get("provider", "claude")
    known_type = "claude-code" if provider == "claude" else provider
    known = KNOWN_AGENTS[known_type]
    options = known.parse_options(
        {
            "channels_enabled": True,
            "repo_dir": worktree_path(agent_id, launch.repository),
            "auto_session": launch.spec["auto_session"],
        }
    )
    await protocol.register_agent(
        reserved_agent_id=agent_id,
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


async def _identity_failed(
    session: AsyncSession,
    protocol: AgentCore,
    request_id: str,
    agent_id: str,
    error: str,
) -> HostedLaunch:
    """Mark the launch `identity_failed`, dropping an identity left half registered."""
    await session.rollback()
    machines = HostedMachineStore()
    launch, machine = await machines.locked_launch(session, request_id)
    assert launch is not None and machine is not None
    if await session.get(Agent, agent_id) is not None:
        try:
            await protocol.delete_agent(agent_id=agent_id)
        except Exception:
            logger.error(
                "Cloud launch %s: could not delete the partly registered agent %s",
                request_id,
                agent_id,
                exc_info=True,
            )
    if (
        launch.agent_id == agent_id
        and await session.get(Agent, agent_id, populate_existing=True) is None
    ):
        launch.agent_id = None
    if launch.desired_state != "deleted":
        launch.state = "error"
        launch.error = error
        launch.error_code = "identity_failed"
    launch.updated_at = datetime.now(UTC)
    machines.bump_agents(machine)
    await session.commit()
    await protocol.hosted_machine_changed(machine.id)
    return launch


async def register_identity(
    session: AsyncSession, protocol: AgentCore, request_id: str
) -> HostedLaunch:
    """Register the launch's agent identity, unless it already has one.

    Core mints the agent id and records it on the launch before registering,
    so the launch's name reservation admits only this identity. A launch that
    has an id but no agent, left by an interrupted registration, registers
    that id again. Registration runs under the machine and launch locks, so
    only one caller registers. A failure leaves the launch in `error` with
    `identity_failed`, which `retry` registers again. Raises 422 when another
    agent holds the name.
    """
    machines = HostedMachineStore()
    launch, machine = await machines.locked_launch(session, request_id)
    assert launch is not None and machine is not None
    if launch.agent_id is None and launch.desired_state != "deleted":
        launch.agent_id = str(uuid4())
        launch.updated_at = datetime.now(UTC)
        await session.commit()
        launch, machine = await machines.locked_launch(session, request_id)
        assert launch is not None and machine is not None
    agent_id = launch.agent_id
    if (
        agent_id is None
        or launch.desired_state == "deleted"
        or await session.get(Agent, agent_id) is not None
    ):
        await session.commit()
        return launch
    try:
        await _register(protocol, launch, agent_id)
    except AgentExistsError:
        await _identity_failed(
            session, protocol, request_id, agent_id, "An agent already uses this name."
        )
        raise HTTPException(422, "An agent already uses this name.") from None
    except Exception:
        logger.error(
            "Cloud launch %s: registering its agent identity failed",
            request_id,
            exc_info=True,
        )
        return await _identity_failed(
            session, protocol, request_id, agent_id, IDENTITY_FAILED
        )
    agent = await session.get(Agent, agent_id, populate_existing=True)
    if agent is None:
        logger.error(
            "Cloud launch %s: agent %s is missing after registration",
            request_id,
            agent_id,
        )
        return await _identity_failed(
            session, protocol, request_id, agent_id, IDENTITY_FAILED
        )
    if launch.spec["addressing_policy"] is not None:
        agent.addressing_policy = launch.spec["addressing_policy"]
    launch.updated_at = datetime.now(UTC)
    machines.bump_agents(machine)
    await session.commit()
    await protocol.hosted_machine_changed(machine.id)
    return launch


class LifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["stop", "start", "restart", "remove", "retry"]
    revision: int = Field(ge=1)


def ring_mailbox_cancel(
    protocol: AgentCore, agent_id: str, entries: list[tuple[str, str]]
) -> None:
    protocol.connections.ring_worker(
        agent_id,
        "mailbox_cancel",
        {
            "entries": [
                {"room_id": room_id, "message_id": message_id}
                for room_id, message_id in entries
            ]
        },
    )


@router.post("/{request_id}/lifecycle", response_model=None)
async def lifecycle(
    request_id: UUID,
    body: LifecycleRequest,
    config: Annotated[SwitchConfig, Depends(get_config)],
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict | JSONResponse:
    launch, machine = await locked_owned(session, str(request_id), user.id)
    if launch.revision != body.revision:
        raise HTTPException(
            409, "The worker changed. Refresh its status before trying again."
        )
    resuming_remove = body.action == "remove" and launch.state == "deleting"
    if launch.desired_state == "deleted" and not resuming_remove:
        raise HTTPException(409, "This worker has been removed.")
    if body.action == "restart" and launch.state != "ready":
        raise HTTPException(409, "Only a ready worker can be restarted.")
    if body.action == "retry" and launch.state != "error":
        raise HTTPException(409, "Only a worker in error can be retried.")
    if body.action in ("start", "restart", "retry") and machine.state == "error":
        return coded_conflict("machine_error", machine_error_detail(machine))
    if body.action in ("restart", "retry") and owner_stopped(machine):
        return coded_conflict("machine_stopped", MACHINE_STOPPED)
    if body.action == "remove":
        return await remove(session, protocol, config, launch, machine)
    machines = HostedMachineStore()
    now = datetime.now(UTC)
    split = None
    if body.action == "stop":
        stopped = (
            launch.state == "stopped"
            or launch.agent_id is None
            or machine.desired_state == "stopped"
        )
        launch.desired_state = "stopped"
        launch.state = "stopped" if stopped else "stopping"
        split = await HostedMailboxStore().stop(session, launch.id)
    else:
        launch.desired_state = "running"
        launch.state = "queued"
        if machine.desired_state == "stopped":
            machines.start(machine, now)
    if body.action == "retry":
        launch.process_restarts = 0
        launch.process_oom_kills = 0
    launch.error = None
    launch.error_code = None
    launch.revision += 1
    launch.updated_at = now
    await HostedLaunchStore().fail_stale_operations(session, launch.id, launch.revision)
    await queue_revocation(session, (GitHubIssuedToken.launch_id == launch.id,))
    machines.bump_agents(machine)
    await session.commit()
    if launch.agent_id:
        if split is not None and split.cancel_requested:
            ring_mailbox_cancel(protocol, launch.agent_id, split.cancel_requested)
        protocol.connections.supersede(launch.agent_id, launch.revision)
    if split is not None:
        await post_mailbox_notices(protocol, split.cancelled)
    remaining = await revoke_pending(
        session, config, (GitHubIssuedToken.launch_id == launch.id,)
    )
    if launch.desired_state == "running":
        launch = await register_identity(session, protocol, launch.id)
    else:
        await protocol.hosted_machine_changed(machine.id)
    response = await launch_summary(session, launch)
    return {**response, "access_warning": ACCESS_WARNING if remaining else None}


async def post_removed_notices(
    protocol: AgentCore, agent: Agent, notices: list[MailboxNotice]
) -> None:
    """Tell each room its queued messages will not run, while the agent can still post."""
    for notice in one_per_room(notices):
        try:
            await post_room_notice(
                protocol,
                agent,
                notice.room_id,
                notice.message_id,
                notice.thread_id,
                "removed",
            )
        except Exception:
            logger.warning(
                "Cloud agent %s: removed notice for room %s was not posted",
                agent.id,
                notice.room_id,
                exc_info=True,
            )


async def remove(
    session: AsyncSession,
    protocol: AgentCore,
    config: SwitchConfig,
    launch: HostedLaunch,
    machine: HostedMachine,
) -> dict:
    """Remove a launch and its agent identity, synchronously, in any state.

    Two commits under the machine and launch locks: the first records the
    removal and what to clean up, and drops the queued mail; the second
    deletes the identity and retains the disk when no agent is left. A crash
    between them leaves the launch `deleting`; `remove` on it again, or the
    controller sweep, finishes the cleanup.
    """
    machines = HostedMachineStore()
    now = datetime.now(UTC)
    cancelled: list[MailboxNotice] = []
    cancel_requested: list[tuple[str, str]] = []
    if launch.desired_state != "deleted":
        launch.desired_state = "deleted"
        launch.revision += 1
        await HostedLaunchStore().fail_stale_operations(
            session, launch.id, launch.revision
        )
        await queue_revocation(session, (GitHubIssuedToken.launch_id == launch.id,))
        mailbox = HostedMailboxStore()
        split = await mailbox.stop(session, launch.id)
        cancelled, cancel_requested = split.cancelled, split.cancel_requested
        await mailbox.delete_launch(session, launch.id)
    await AgentStore().lock_name(session, launch.name)
    agent = await session.get(Agent, launch.agent_id) if launch.agent_id else None
    if agent is not None:
        if (
            agent.owner_id != launch.owner_id
            or (agent.metadata_ or {}).get("hosted_launch_id") != launch.id
        ):
            raise HTTPException(
                409, "The removed worker identity belongs to another agent."
            )
        launch.deletion_cleanup = {
            "client_id": agent.client_id,
            "key_id": agent.api_key_id,
        }
    launch.state = "deleting"
    launch.error = None
    launch.error_code = None
    launch.updated_at = now
    machines.bump_agents(machine)
    await session.commit()

    if launch.agent_id:
        if cancel_requested:
            ring_mailbox_cancel(protocol, launch.agent_id, cancel_requested)
        protocol.connections.supersede(launch.agent_id, launch.revision)
    if agent is not None:
        await post_removed_notices(protocol, agent, cancelled)

    launch, machine = await locked_owned(session, launch.id, launch.owner_id)
    await finish_removal(session, protocol, config, launch, machine, now)
    await session.commit()
    await protocol.hosted_machine_changed(machine.id)
    remaining = await revoke_pending(
        session, config, (GitHubIssuedToken.launch_id == launch.id,)
    )
    response = summary(launch, machine)
    return {**response, "access_warning": ACCESS_WARNING if remaining else None}


async def finish_removal(
    session: AsyncSession,
    protocol: AgentCore,
    config: SwitchConfig,
    launch: HostedLaunch,
    machine: HostedMachine,
    now: datetime,
) -> None:
    """Delete a `deleting` launch's identity and mark it `deleted`.

    The caller holds the machine and launch locks and commits. Safe to run
    again after an interruption.
    """
    machines = HostedMachineStore()
    await AgentStore().lock_name(session, launch.name)
    if launch.agent_id and await session.get(Agent, launch.agent_id) is not None:
        await protocol.delete_agent(agent_id=launch.agent_id)
    if launch.deletion_cleanup:
        client_id = launch.deletion_cleanup["client_id"]
        await protocol.client_lifecycle.stop(client_id)
        await protocol.client_lifecycle.delete_record(session, client_id)
        if launch.agent_id:
            protocol.api_key_cache.invalidate_agent(launch.agent_id)
        await session.execute(
            delete(ApiKey).where(
                ApiKey.tenant_id == require_tenant_id(),
                ApiKey.id == launch.deletion_cleanup["key_id"],
            )
        )
        launch.deletion_cleanup = None
    launch.state = "deleted"
    launch.name = "removed:" + launch.id
    launch.updated_at = now
    machines.bump_agents(machine)
    await machines.retain_if_empty(
        session, machine, retention_days=config.hosted_disk_retention_days, now=now
    )


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


OPERATION_RERING_SECONDS = 5
OPERATION_RERINGS = 6
_doorbells: set[asyncio.Task[None]] = set()


async def ring_operation(
    protocol: AgentCore, tenant_id: str, agent_id: str, operation_id: str
) -> None:
    """Ring the worker for a queued operation until it is claimed or the rings run out."""
    protocol.connections.ring_worker(agent_id, "operation", {"id": operation_id})
    for _ in range(OPERATION_RERINGS):
        await asyncio.sleep(OPERATION_RERING_SECONDS)
        async with tenant_session(protocol.session_factory, tenant_id) as session:
            operation = await session.get(HostedOperation, (tenant_id, operation_id))
            if operation is None or operation.state != "queued":
                return
        protocol.connections.ring_worker(agent_id, "operation", {"id": operation_id})


@router.post("/{request_id}/sessions", status_code=202, response_model=None)
async def session_operation(
    request_id: UUID,
    body: SessionOperationRequest,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict | JSONResponse:
    launch, machine = await locked_owned(session, str(request_id), user.id)
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
    if machine.state == "error":
        return coded_conflict("machine_error", machine_error_detail(machine))
    if owner_stopped(machine):
        return coded_conflict("machine_stopped", MACHINE_STOPPED)
    if (
        idle_sleeping(machine)
        and launch.desired_state == "running"
        and launch.state != "error"
    ):
        now = datetime.now(UTC)
        HostedMachineStore().start(machine, now)
        launch.active_at = now
        await session.commit()
        return coded_conflict("worker_waking", WORKER_WAKING)
    if machine_starting(machine):
        return coded_conflict("worker_waking", WORKER_WAKING)
    if (
        launch.state not in ("ready", "running")
        or launch.desired_state != "running"
        or launch.agent_id is None
    ):
        raise HTTPException(409, "Start the cloud worker and wait until it is ready.")
    pending = await session.scalar(
        select(HostedOperation.id).where(
            HostedOperation.tenant_id == require_tenant_id(),
            HostedOperation.launch_id == launch.id,
            HostedOperation.session_id == str(body.session_id),
            HostedOperation.state.in_(["queued", "claimed"]),
        )
    )
    if pending is not None:
        raise HTTPException(409, "This session already has a pending operation.")
    operation = HostedOperation(
        id=str(body.id),
        launch_id=launch.id,
        launch_revision=launch.revision,
        session_id=str(body.session_id),
        action=body.action,
    )
    session.add(operation)
    await session.commit()
    task = asyncio.create_task(
        ring_operation(protocol, require_tenant_id(), launch.agent_id, operation.id)
    )
    _doorbells.add(task)
    task.add_done_callback(_doorbells.discard)
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
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict:
    if not launch_enabled(config, settings):
        raise HTTPException(503, LAUNCH_DISABLED)
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
        if existing.state != "error" and existing.desired_state != "deleted":
            existing = await register_identity(session, protocol, existing.id)
        return await launch_summary(session, existing)
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
    if not repository_writable(repository):
        raise HTTPException(
            422,
            "Your GitHub account needs write access to this repository to run a cloud agent.",
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
            slots=list(settings.machine_slots),
            repository=repository["name"],
            now=datetime.now(UTC),
        )
    except (HostedLaunchConflict, HostedMachineConflict) as error:
        raise HTTPException(409, str(error)) from None
    await session.commit()
    launch = await register_identity(session, protocol, launch.id)
    return await launch_summary(session, launch)
