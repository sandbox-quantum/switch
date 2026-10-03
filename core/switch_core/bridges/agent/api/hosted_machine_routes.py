"""The machine supervisor's routes: its agent list and its heartbeat.

Authenticated by the machine capability rather than an agent key, so the
Bearer middleware lets these paths through and the dependency below does the
check.
"""

import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import AwareDatetime, BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.dependencies import (
    get_config,
    get_protocol,
    get_session_factory,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.config import SwitchConfig
from switch_core.connections.loader import CATALOG, SKILL_PROVIDERS, deployment_skills
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    HostedLaunch,
    HostedMachine,
    ProviderConnection,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import HostedMachineStore, lock_launch
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hosted/machines")

HEARTBEAT_EVERY_S = 15
DISK_FULL_BELOW_BYTES = 1 << 30
RETIRED_STATES = {"retained", "deleting", "deleted"}
WORKER_ATTACH_TIMEOUT = timedelta(minutes=10)
IDENTITY_REGISTRATION_GRACE = timedelta(minutes=1)


@dataclass(frozen=True)
class MachineRequest:
    session: AsyncSession
    machine: HostedMachine
    settings: HostedControllerSettings


def _settings(config: SwitchConfig) -> HostedControllerSettings:
    if not config.hosted_controller_config_path:
        raise HTTPException(503, "Cloud machines are not enabled on this server.")
    return HostedControllerSettings.model_validate_json(
        Path(config.hosted_controller_config_path).read_text()
    )


def _capability_valid(machine: HostedMachine | None, capability: str) -> bool:
    return (
        bool(capability)
        and machine is not None
        and HostedMachineStore.capability_matches(machine, capability)
    )


async def machine_request(
    machine_id: str,
    request: Request,
    config: Annotated[SwitchConfig, Depends(get_config)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
) -> AsyncIterator[MachineRequest]:
    """The supervisor's machine, locked, once its capability checks out."""
    settings = _settings(config)
    supplied = request.headers.get("authorization", "")
    capability = supplied[7:] if supplied.startswith("Bearer ") else ""
    with tenant_scope(settings.tenant_id):
        async with factory() as session:
            machine = await HostedMachineStore().get(session, machine_id)
            if not _capability_valid(machine, capability):
                raise HTTPException(401, "invalid machine capability")
            if not request.headers.get(
                "x-switch-host-boot-id"
            ) or not request.headers.get("x-switch-host-instance-id"):
                raise HTTPException(
                    400,
                    "X-Switch-Host-Boot-Id and X-Switch-Host-Instance-Id are required.",
                )
            machine = await HostedMachineStore().locked(session, machine_id)
            if machine is None or not _capability_valid(machine, capability):
                raise HTTPException(401, "invalid machine capability")
            if (
                machine.state in RETIRED_STATES
                or machine.desired_state in RETIRED_STATES
            ):
                raise HTTPException(410, "machine retired")
            yield MachineRequest(session, machine, settings)


async def _machine_launch(
    session: AsyncSession, machine: HostedMachine, launch_id: str
) -> HostedLaunch | None:
    await lock_launch(session, launch_id)
    launch = await session.get(
        HostedLaunch, (require_tenant_id(), launch_id), populate_existing=True
    )
    if launch is None or launch.machine_id != machine.id:
        return None
    return launch


UNAVAILABLE_ERRORS = {
    "agent_key_missing": (
        "Switch lost this cloud agent's credential, so its machine cannot run it. "
        "Remove the agent and create it again."
    ),
    "agent_identity_missing": (
        "Switch lost this cloud agent's identity, so its machine cannot run it. "
        "Retry it in Switch Console."
    ),
}


def _unavailable_entry(
    launch: HostedLaunch,
    code: Literal["agent_key_missing", "agent_identity_missing"],
    now: datetime,
) -> dict:
    """List a launch the machine cannot run, and put it in error.

    A queued launch whose identity is missing is left alone for
    `IDENTITY_REGISTRATION_GRACE`: launch creation commits `agent_id` before
    it registers the agent. Past the grace it goes to error like any other
    state, and retry registers the reserved id again.
    """
    logger.error(
        "Cloud launch %s: agent %s is unavailable (%s); the machine cannot run it.",
        launch.id,
        launch.agent_id,
        code,
    )
    exempt = (
        code == "agent_identity_missing"
        and launch.state == "queued"
        and now - launch.updated_at < IDENTITY_REGISTRATION_GRACE
    )
    already = launch.state == "error" and launch.error_code == code
    if not exempt and not already:
        launch.state = "error"
        launch.error_code = code
        launch.error = UNAVAILABLE_ERRORS[code]
        launch.updated_at = now
    return {
        "launch_id": launch.id,
        "agent_id": launch.agent_id,
        "name": launch.name,
        "revision": launch.revision,
        "desired_state": launch.desired_state,
        "unavailable": code,
    }


async def _agent_entry(
    session: AsyncSession,
    launch: HostedLaunch,
    key: ApiKey,
    settings: HostedControllerSettings,
    config: SwitchConfig,
) -> dict:
    assert launch.agent_id is not None
    provider = launch.spec.get("provider", "claude")
    connection = await session.get(
        ProviderConnection, (require_tenant_id(), launch.owner_id, provider)
    )
    if connection is None:
        logger.warning(
            "Cloud launch %s: the owner's %s connection is gone; listing it without a credential kind.",
            launch.id,
            provider,
        )
    if provider not in SKILL_PROVIDERS:
        logger.warning(
            "Cloud launch %s: %s has no skills directory; granted connection skills are not installed.",
            launch.id,
            provider,
        )
    return {
        "launch_id": launch.id,
        "agent_id": launch.agent_id,
        "name": launch.name,
        "revision": launch.revision,
        "desired_state": launch.desired_state,
        "provider": provider,
        "provider_credential_kind": None if connection is None else connection.kind,
        "worker_capability": HostedLaunchStore().issue_worker_capability(
            launch, config.jwt_secret_key
        ),
        "switch_credentials": {
            "env": {
                "SWITCH_API_ENDPOINT": settings.agent_api_endpoint,
                "SWITCH_API_TOKEN": decrypt_token(
                    key.encrypted_key, config.jwt_secret_key
                ),
                "SWITCH_AGENT_ID": launch.agent_id,
            }
        },
        "repository": launch.repository,
        "spec": launch.spec,
        "skills": deployment_skills(CATALOG, ["github"])
        if provider in SKILL_PROVIDERS
        else [],
    }


@router.get("/{machine_id}/agents")
async def agents(
    response: Response,
    current: Annotated[MachineRequest, Depends(machine_request)],
    config: Annotated[SwitchConfig, Depends(get_config)],
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    session, machine = current.session, current.machine
    now = datetime.now(UTC)
    entries = []
    for candidate in await HostedMachineStore().launches(session, machine.id):
        launch = await _machine_launch(session, machine, candidate.id)
        if (
            launch is None
            or launch.state in {"deleting", "deleted"}
            or launch.desired_state == "deleted"
            or launch.agent_id is None
        ):
            continue
        agent = await session.get(Agent, launch.agent_id)
        if agent is None:
            entries.append(_unavailable_entry(launch, "agent_identity_missing", now))
            continue
        key = await session.get(ApiKey, agent.api_key_id)
        if key is None or not key.encrypted_key:
            entries.append(_unavailable_entry(launch, "agent_key_missing", now))
            continue
        entries.append(
            await _agent_entry(session, launch, key, current.settings, config)
        )
        if launch.state == "queued":
            launch.state = "provisioning"
            launch.updated_at = now
    result = {
        "machine_id": machine.id,
        "revision": machine.revision,
        "desired_state": machine.desired_state,
        "agents_version": machine.agents_version,
        "agents": entries,
    }
    await session.commit()
    return result


class DiskReport(BaseModel):
    path: str = Field(max_length=4096)
    total_bytes: int = Field(ge=0)
    used_bytes: int = Field(ge=0)
    available_bytes: int = Field(ge=0)


class MemoryReport(BaseModel):
    total_bytes: int = Field(ge=0)
    available_bytes: int = Field(ge=0)


class ProcessExit(BaseModel):
    code: int | None
    signal: int | None
    result: str | None = Field(max_length=128)


class AgentReport(BaseModel):
    launch_id: str = Field(max_length=128)
    agent_id: str = Field(max_length=128)
    revision: int = Field(ge=1)
    process_state: Literal[
        "pending",
        "starting",
        "running",
        "stopping",
        "stopped",
        "restarting",
        "crashed",
        "failed",
    ]
    restarts: int = Field(ge=0)
    oom_kills: int = Field(ge=0)
    exit: ProcessExit | None
    since: AwareDatetime


class Heartbeat(BaseModel):
    boot_id: str = Field(max_length=128)
    instance_id: str = Field(max_length=128)
    supervisor_version: str = Field(max_length=128)
    runtime_fingerprint: str = Field(max_length=256)
    disk: DiskReport
    memory: MemoryReport
    agents: list[AgentReport] = Field(max_length=100)


CRASHED_ERROR = "The agent crashed 5 times in 10 minutes. Retry it in Switch Console."
FAILED_ERROR = (
    "The agent stopped with an error and was not restarted. Retry it in Switch Console."
)
ATTACH_TIMEOUT_ERROR = (
    "The agent started but did not connect to Switch within 10 minutes. "
    "Retry it in Switch Console, or check its provider login."
)


def _apply_process_state(
    launch: HostedLaunch,
    report: AgentReport,
    protocol: AgentCore,
    now: datetime,
) -> None:
    """Move the launch on the process state its supervisor reported."""
    previous = launch.state
    if report.process_state == "running":
        worker = (
            protocol.connections.attached_worker(launch.agent_id)
            if launch.agent_id
            else None
        )
        listening = (
            worker is not None
            and worker.worker is not None
            and worker.worker.launch_id == launch.id
            and worker.worker.launch_revision == launch.revision
            and (worker.spawn_capable or not launch.spec["auto_session"])
        )
        if (
            listening
            and launch.desired_state == "running"
            and launch.state not in {"ready", "error"}
        ):
            launch.state = "ready"
            launch.error = None
            launch.error_code = None
            launch.active_at = now
        elif (
            not listening
            and launch.desired_state == "running"
            and launch.state == "provisioning"
            and now - max(report.since, launch.updated_at) > WORKER_ATTACH_TIMEOUT
        ):
            launch.state = "error"
            launch.error_code = "worker_attach_timeout"
            launch.error = ATTACH_TIMEOUT_ERROR
    elif (
        report.process_state in {"crashed", "failed"}
        and launch.desired_state == "running"
    ):
        crashed = report.process_state == "crashed"
        launch.state = "error"
        launch.error_code = "agent_crashed" if crashed else "agent_failed"
        launch.error = CRASHED_ERROR if crashed else FAILED_ERROR
    elif (
        report.process_state in {"stopped", "crashed", "failed"}
        and launch.desired_state == "stopped"
    ):
        launch.state = "stopped"
        launch.error = None
        launch.error_code = None
    if launch.state != previous:
        launch.updated_at = now


@router.post("/{machine_id}/heartbeat")
async def heartbeat(
    body: Heartbeat,
    current: Annotated[MachineRequest, Depends(machine_request)],
    protocol: Annotated[AgentCore, Depends(get_protocol)],
) -> dict:
    session, machine = current.session, current.machine
    now = datetime.now(UTC)
    machine.heartbeat = body.model_dump(mode="json")
    machine.heartbeat_at = now
    if (
        machine.state == "provisioning"
        and machine.running_observed_at is not None
        and now > machine.running_observed_at
    ):
        machine.state = "ready"
        machine.error = None
        machine.error_code = None
        machine.updated_at = now
    if body.disk.available_bytes < DISK_FULL_BELOW_BYTES:
        if machine.error_code is None:
            machine.error_code = "disk_full"
    elif machine.error_code == "disk_full":
        machine.error_code = None
    for report in body.agents:
        launch = await _machine_launch(session, machine, report.launch_id)
        if (
            launch is None
            or launch.agent_id != report.agent_id
            or launch.revision != report.revision
        ):
            continue
        launch.process_state = report.process_state
        launch.process_restarts = report.restarts
        launch.process_oom_kills = report.oom_kills
        launch.process_exit = (
            None if report.exit is None else report.exit.model_dump(mode="json")
        )
        launch.process_reported_at = now
        if launch.desired_state != "deleted":
            _apply_process_state(launch, report, protocol, now)
    result = {
        "agents_version": machine.agents_version,
        "machine_desired_state": machine.desired_state,
        "heartbeat_every_s": HEARTBEAT_EVERY_S,
    }
    await session.commit()
    return result
