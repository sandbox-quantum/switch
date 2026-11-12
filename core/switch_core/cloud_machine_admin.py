"""`switch-cloud-machine`: an operator's hold on a person's Switch cloud machine.

`stop` holds the machine stopped so that neither its owner nor Switch can
start it again: Start and Retry in Switch Console are refused, a message to
one of its agents does not wake it, and Switch no longer retains or deletes
its disk. `release` lifts the hold, leaving the machine stopped for its owner
to start. Both are recorded in the server audit log. Run it where switch-core
runs, with the same configuration.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import CloudMachine, User
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineConflict,
    CloudMachineStore,
)
from switch_core.observability.hosted import record_machine_event
from switch_core.tenant_context import no_tenant


class CloudMachineAdminError(Exception):
    """The command cannot be carried out; the message says why."""


def machine_report(machine: CloudMachine) -> dict:
    return {
        "machine_id": machine.id,
        "owner_id": machine.owner_id,
        "state": machine.state,
        "desired_state": machine.desired_state,
        "stop_reason": machine.stop_reason,
        "revision": machine.revision,
        "error_code": machine.error_code,
        "instance_id": machine.instance_id,
        "data_volume_id": machine.data_volume_id,
        "heartbeat_at": None
        if machine.heartbeat_at is None
        else machine.heartbeat_at.isoformat(),
    }


async def find_machines(
    factory: async_sessionmaker[AsyncSession], owner_email: str
) -> list[dict]:
    """The machines, not deleted, of the account with `owner_email`, matched
    without regard to case."""
    with no_tenant():
        async with factory() as session:
            owner = await session.scalar(
                select(User).where(func.lower(User.email) == owner_email.lower())
            )
            if owner is None:
                raise CloudMachineAdminError(f"No account has the email {owner_email}.")
            machines = await session.scalars(
                select(CloudMachine)
                .where(
                    CloudMachine.owner_id == owner.id, CloudMachine.state != "deleted"
                )
                .order_by(CloudMachine.created_at)
            )
            return [machine_report(machine) for machine in machines]


async def machine_status(
    factory: async_sessionmaker[AsyncSession], machine_id: str
) -> dict:
    machine_id = _machine_id(machine_id)
    with no_tenant():
        async with factory() as session:
            machine = await CloudMachineStore().get(session, machine_id)
            if machine is None:
                raise CloudMachineAdminError(f"No cloud machine {machine_id}.")
            return machine_report(machine)


async def stop_machine(
    factory: async_sessionmaker[AsyncSession], machine_id: str, reason: str
) -> dict:
    """Hold the machine stopped, recording `reason` in the server audit log."""
    if not reason.strip():
        raise CloudMachineAdminError("--reason must say why the machine is stopped.")
    machine_id = _machine_id(machine_id)
    store = CloudMachineStore()
    with no_tenant():
        async with factory() as session:
            machine = await store.locked(session, machine_id)
            if machine is None:
                raise CloudMachineAdminError(f"No cloud machine {machine_id}.")
            try:
                store.admin_stop(machine, datetime.now(UTC))
            except CloudMachineConflict as error:
                raise CloudMachineAdminError(str(error)) from None
            # Counted once committed, beside the idle and owner stops.
            record_machine_event(session, "stopped", "admin")
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.CLOUD_MACHINE_ADMIN_STOPPED,
                target_type="cloud_machine",
                target_id=machine.id,
                details={"owner_id": machine.owner_id, "reason": reason},
            )
            await session.commit()
            return machine_report(machine)


async def release_machine(
    factory: async_sessionmaker[AsyncSession], machine_id: str
) -> dict:
    """Lift the hold: the machine stays stopped for its owner to start."""
    machine_id = _machine_id(machine_id)
    store = CloudMachineStore()
    with no_tenant():
        async with factory() as session:
            machine = await store.locked(session, machine_id)
            if machine is None:
                raise CloudMachineAdminError(f"No cloud machine {machine_id}.")
            try:
                store.admin_release(machine, datetime.now(UTC))
            except CloudMachineConflict as error:
                raise CloudMachineAdminError(str(error)) from None
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.CLOUD_MACHINE_ADMIN_RELEASED,
                target_type="cloud_machine",
                target_id=machine.id,
                details={"owner_id": machine.owner_id},
            )
            await session.commit()
            return machine_report(machine)


def _machine_id(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError:
        raise CloudMachineAdminError(
            f"{value!r} is not a cloud machine id (a UUID)."
        ) from None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-cloud-machine",
        description="Hold a person's Switch cloud machine stopped, or release it.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    find = commands.add_parser("find", help="list a person's cloud machines")
    find.add_argument("--owner-email", required=True)
    status = commands.add_parser("status", help="show one cloud machine")
    status.add_argument("machine_id")
    stop = commands.add_parser(
        "stop", help="hold a machine stopped so its owner cannot start it"
    )
    stop.add_argument("machine_id")
    stop.add_argument("--reason", required=True, help="why, for the server audit log")
    release = commands.add_parser(
        "release", help="lift the hold; the machine stays stopped for its owner"
    )
    release.add_argument("machine_id")
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    engine = create_engine_from_config(config)
    try:
        factory = create_session_factory(engine)
        try:
            if arguments.command == "find":
                result: object = await find_machines(factory, arguments.owner_email)
            elif arguments.command == "status":
                result = await machine_status(factory, arguments.machine_id)
            elif arguments.command == "stop":
                result = await stop_machine(
                    factory, arguments.machine_id, arguments.reason
                )
            else:
                result = await release_machine(factory, arguments.machine_id)
        except CloudMachineAdminError as error:
            print(json.dumps({"error": str(error)}), file=sys.stderr)
            return 1
        print(json.dumps(result, sort_keys=True))
        return 0
    finally:
        await engine.dispose()


def main() -> None:
    config = SwitchConfig()
    raise SystemExit(asyncio.run(_run(config, _parser().parse_args())))
