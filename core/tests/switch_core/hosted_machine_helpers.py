"""Rows for cloud-machine tests, written straight to the session (flushed, not committed)."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    AgentController,
    AgentDefinition,
    ApiKey,
    Client,
    CloudMachine,
    MachineWorkspace,
    Tenant,
)
from switch_core.db.stores.hosted_machine_store import workspace_on


async def add_tenant(session: AsyncSession, tenant_id: str) -> None:
    """Another workspace on the server."""
    session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
    await session.flush()


async def seed_machine(
    session: AsyncSession,
    *,
    owner_id: str,
    state: str,
    desired_state: str,
    stop_reason: str | None,
    revision: int,
) -> CloudMachine:
    now = datetime.now(UTC)
    machine = CloudMachine(
        id=str(uuid4()),
        owner_id=owner_id,
        state=state,
        desired_state=desired_state,
        stop_reason=stop_reason,
        revision=revision,
        active_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(machine)
    await session.flush()
    await add_workspace(session, machine, created_at=now)
    return machine


async def add_workspace(
    session: AsyncSession, machine: CloudMachine, *, created_at: datetime
) -> MachineWorkspace:
    """The bound workspace's row on `machine`: the machine serves it."""
    workspace = MachineWorkspace(
        id=str(uuid4()),
        machine_id=machine.id,
        owner_id=machine.owner_id,
        created_at=created_at,
    )
    session.add(workspace)
    await session.flush()
    return workspace


async def link_controller(
    session: AsyncSession, machine: CloudMachine
) -> AgentController:
    """The cloud controller the machine enrolled as in the bound workspace,
    linked to the workspace's row on it."""
    workspace = await workspace_on(session, machine.id)
    assert workspace is not None
    controller = AgentController(
        owner_id=machine.owner_id, name="Switch cloud", kind="ec2"
    )
    session.add(controller)
    await session.flush()
    workspace.controller_id = controller.id
    await session.flush()
    return controller


async def place_managed_agent(
    session: AsyncSession, *, owner_id: str, controller_id: str, name: str
) -> AgentDefinition:
    """A managed agent of `owner_id`, placed on `controller_id`."""
    client = Client(type="agent", transport_user_id=f"@{name}:test", display_name=name)
    session.add(client)
    await session.flush()
    api_key = ApiKey(
        type="agent",
        key_hash=f"hash-{uuid4()}",
        encrypted_key=f"enc-{name}",
        label=name,
        user_id=owner_id,
    )
    session.add(api_key)
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="session_passive",
        connector_type="external",
        integration_profile={"connection_model": "session_passive"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    definition = AgentDefinition(
        agent_id=agent.id,
        owner_id=owner_id,
        controller_id=controller_id,
        revision=1,
        desired_state="running",
        definition={"provider": "claude"},
    )
    session.add(definition)
    await session.flush()
    return definition
