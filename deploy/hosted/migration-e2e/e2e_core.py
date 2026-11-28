"""The test Core's side of the migration end-to-end run.

`switch-hosted-migration` works on Core's database alone, so the "test Core"
is a throwaway Postgres with Core's real schema (`switch-migrate`) and real
CLI. What the v1 machine, the box and their controllers would report is
written to the rows here, the way their observation and enrolment write it
(as the service tests' `World` does):

    e2e_core.py seed PERSON_NAME --agents N      # a person on a running v1 machine
    e2e_core.py operator NAME                    # a user to act as the operator
    e2e_core.py machine-state MACHINE_ID STATE   # the v1 machine or box reports
    e2e_core.py box-enrols MACHINE_ID            # a box controller enrols
    e2e_core.py disk-spec PERSON_ID              # the seats for the fake disk

Run with Core's virtualenv, from `core/`, with the same database settings as
the CLI (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD). It refuses any
database not named `e2e_core` on a local host, so it can never write to a
real one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from sqlalchemy import select, update

from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import (
    Agent,
    AgentController,
    AgentDefinition,
    CloudMachine,
    TenantMember,
    User,
)
from switch_core.db.stores.hosted_machine_store import workspace_on
from switch_core.tenant_context import no_tenant, tenant_scope
from tests.switch_core.hosted_machine_helpers import (
    add_tenant,
    add_workspace,
    link_controller,
    place_managed_agent,
    seed_machine,
)
from tests.switch_core.management.harness import TENANT_ZERO_ID

E2E_DATABASE = "e2e_core"
LOCAL_HOSTS = {"127.0.0.1", "localhost"}
#: Made-up v1 resource ids, in the formats Core checks.
INSTANCE = "i-0e2e0e2e0e2e0e2e0"
VOLUME = "vol-0e2e0e2e0e2e0e2e0"


class _Config:
    """Just the database settings `create_engine_from_config` reads."""

    def __init__(self) -> None:
        host = os.environ.get("DB_HOST", "")
        name = os.environ.get("DB_NAME", "")
        if host not in LOCAL_HOSTS or name != E2E_DATABASE:
            raise SystemExit(
                f"refused: only the local database {E2E_DATABASE!r} (DB_HOST {sorted(LOCAL_HOSTS)})"
            )
        from switch_core.config import SwitchConfig

        self._config = SwitchConfig()

    def __getattr__(self, name: str) -> object:
        return getattr(self._config, name)


#: The second workspace's tenant, for a person on two workspaces (two seats).
SECOND_TENANT = "e2e-second-workspace"


async def seed(person: str, agents: int, workspaces: int = 1) -> dict:
    """A person, a member of tenant zero, on a running v1 machine with an
    enrolled controller and `agents` managed agents; with `workspaces` 2, also
    a member of a second workspace the machine serves, with its own controller
    and agents (the v1 disk's second seat)."""
    config = _Config()
    engine = create_engine_from_config(config)  # type: ignore[arg-type]
    factory = create_session_factory(engine)
    try:
        with tenant_scope(TENANT_ZERO_ID):
            async with factory() as session:
                user = User(name=person, email=f"{person}@example.invalid", role="user")
                session.add(user)
                await session.flush()
                session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"))
                machine = await seed_machine(
                    session,
                    owner_id=user.id,
                    state="ready",
                    desired_state="running",
                    stop_reason=None,
                    revision=3,
                )
                machine.backend = "vm"
                machine.instance_id = INSTANCE
                machine.data_volume_id = VOLUME
                machine.instance_type = "m6i.large"
                machine.heartbeat = {
                    "disk": {"total_bytes": 200 * 1024**3, "available_bytes": 194 * 1024**3}
                }
                controller = await link_controller(session, machine)
                for n in range(1, agents + 1):
                    await place_managed_agent(
                        session,
                        owner_id=user.id,
                        controller_id=controller.id,
                        name=f"{person}-agent-{n}",
                    )
                await session.commit()
                user_id, machine_id = user.id, machine.id
        if workspaces == 2:
            with no_tenant():
                async with factory() as session:
                    await add_tenant(session, SECOND_TENANT)
                    await session.commit()
            with tenant_scope(SECOND_TENANT):
                async with factory() as session:
                    session.add(TenantMember(tenant_id=SECOND_TENANT, user_id=user_id, role="member"))
                    machine = await session.get(CloudMachine, machine_id)
                    assert machine is not None
                    await add_workspace(session, machine, created_at=machine.created_at)
                    controller = await link_controller(session, machine)
                    for n in range(1, agents + 1):
                        await place_managed_agent(
                            session,
                            owner_id=user_id,
                            controller_id=controller.id,
                            name=f"{person}-second-{n}",
                        )
                    await session.commit()
        return {"person_id": user_id, "machine_id": machine_id}
    finally:
        await engine.dispose()


async def operator(name: str) -> dict:
    """A plain user for `--operator` (the audit's actor); the run lists it."""
    config = _Config()
    engine = create_engine_from_config(config)  # type: ignore[arg-type]
    factory = create_session_factory(engine)
    try:
        with tenant_scope(TENANT_ZERO_ID):
            async with factory() as session:
                user = User(name=name, email=f"{name}@example.invalid", role="user")
                session.add(user)
                await session.commit()
                return {"operator_id": user.id}
    finally:
        await engine.dispose()


async def machine_state(machine_id: str, state: str) -> dict:
    config = _Config()
    engine = create_engine_from_config(config)  # type: ignore[arg-type]
    factory = create_session_factory(engine)
    try:
        with no_tenant():
            async with factory() as session:
                machine = await session.get(CloudMachine, machine_id)
                if machine is None:
                    raise SystemExit("no such machine")
                machine.state = state
                await session.commit()
                return {"machine_id": machine_id, "state": state, "backend": machine.backend}
    finally:
        await engine.dispose()


async def box_enrols(machine_id: str) -> dict:
    """The box's controllers enrol, one per workspace the machine serves, as
    the enrolment writes it: each replaces its workspace's controller, and
    takes the agents unless the move holds them."""
    config = _Config()
    engine = create_engine_from_config(config)  # type: ignore[arg-type]
    factory = create_session_factory(engine)
    enrolled = []
    try:
        for tenant in (TENANT_ZERO_ID, SECOND_TENANT):
            with tenant_scope(tenant):
                async with factory() as session:
                    workspace = await workspace_on(session, machine_id)
                    if workspace is None:
                        continue
                    controller = AgentController(
                        owner_id=workspace.owner_id, name="Switch box", kind="daemon"
                    )
                    session.add(controller)
                    await session.flush()
                    controller.status = {"agents": []}
                    replaced = workspace.controller_id
                    if replaced is not None and replaced != workspace.moving_from_controller_id:
                        await session.execute(
                            update(AgentDefinition)
                            .where(
                                AgentDefinition.tenant_id == workspace.tenant_id,
                                AgentDefinition.controller_id == replaced,
                            )
                            .values(controller_id=controller.id)
                        )
                    workspace.controller_id = controller.id
                    await session.commit()
                    enrolled.append(controller.id)
        if not enrolled:
            raise SystemExit("no workspace on that machine")
        return {"controller_ids": enrolled}
    finally:
        await engine.dispose()


async def disk_spec(person_id: str) -> list[dict]:
    """The fake v1 disk's seats, from Core's own rows, one per workspace the
    machine serves: the workspace row id is the seat key, with its v1
    controller and that controller's agents (ids and names). Read before the
    flip, while the v1 controllers are still the workspaces'."""
    config = _Config()
    engine = create_engine_from_config(config)  # type: ignore[arg-type]
    factory = create_session_factory(engine)
    seats = []
    try:
        for tenant in (TENANT_ZERO_ID, SECOND_TENANT):
            with tenant_scope(tenant):
                async with factory() as session:
                    machine = await session.scalar(
                        select(CloudMachine).where(CloudMachine.owner_id == person_id)
                    )
                    if machine is None:
                        raise SystemExit("that person has no machine")
                    workspace = await workspace_on(session, machine.id)
                    if workspace is None or workspace.controller_id is None:
                        continue
                    rows = (
                        await session.execute(
                            select(Agent.id, Agent.name)
                            .join(AgentDefinition, AgentDefinition.agent_id == Agent.id)
                            .where(AgentDefinition.controller_id == workspace.controller_id)
                            .order_by(Agent.name)
                        )
                    ).all()
                    seats.append(
                        {
                            "seat_key": workspace.id,
                            "v1_controller_id": workspace.controller_id,
                            "tenant_id": workspace.tenant_id,
                            "agents": [{"id": i, "name": n} for i, n in rows],
                        }
                    )
        return seats
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="e2e_core.py")
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("seed")
    p.add_argument("person")
    p.add_argument("--agents", type=int, default=2)
    p.add_argument("--workspaces", type=int, choices=(1, 2), default=1)
    p = commands.add_parser("operator")
    p.add_argument("name")
    p = commands.add_parser("machine-state")
    p.add_argument("machine_id")
    p.add_argument("state", choices=["queued", "starting", "ready", "stopping", "stopped"])
    p = commands.add_parser("box-enrols")
    p.add_argument("machine_id")
    p = commands.add_parser("disk-spec")
    p.add_argument("person_id")
    args = parser.parse_args(argv)
    if args.command == "seed":
        result: object = asyncio.run(seed(args.person, args.agents, args.workspaces))
    elif args.command == "operator":
        result = asyncio.run(operator(args.name))
    elif args.command == "machine-state":
        result = asyncio.run(machine_state(args.machine_id, args.state))
    elif args.command == "box-enrols":
        result = asyncio.run(box_enrols(args.machine_id))
    else:
        result = asyncio.run(disk_spec(args.person_id))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
