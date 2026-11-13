"""`switch-hosted-migration`: an operator moves one person from their v1
machine to a v2 box (`visibility/hosted_migration.py`).

Run inside the cluster, in a Core pod, from an operator's own cluster login:
the cluster's exec audit shows who ran it, and `--operator` (checked against
the operators list) is the actor of every audit entry. It adds no web route.

- `switch-hosted-migration plan PERSON`: what a run would do. Changes nothing.
- `switch-hosted-migration run PERSON --operator ID [--execute]
  [--snapshot-id snap-…] [--copy-report FILE | --copy-failed]`: the next
  step of the move.
- `switch-hosted-migration manifest PERSON`: the agents the copy job copies,
  as JSON, named from Core's own record.
- `switch-hosted-migration rollback PERSON --operator ID [--execute]`.
- `switch-hosted-migration clean-up PERSON --operator ID [--execute]`: after
  the rollback window, say which v1 resources may go, and record it.

Every command is a dry run unless `--execute` is given. PERSON is the person's
user id. Hosted agents v2 must be on (`HOSTED_BOX_PROVISIONING`).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import CloudMachine
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.hosted_v2 import set_process_hosted_v2
from switch_core.management.service import revoke_controller_rows
from switch_core.providers.hosted import load_hosted_settings
from switch_core.visibility.box_provision import box_allowed
from switch_core.visibility.dependencies import load_keyed_id_key
from switch_core.visibility.hosted_migration import (
    CopyReport,
    HostedMigrations,
    MigrationRefused,
    Plan,
)
from switch_core.visibility.operators import OperatorList

#: The largest copy report read: a few counts, never a file list.
MAX_REPORT_BYTES = 4096


class CommandError(Exception):
    """Refused before anything ran; the message is for the operator."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="switch-hosted-migration")
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("person")
    manifest = commands.add_parser("manifest")
    manifest.add_argument("person")
    for name in ("run", "rollback", "clean-up"):
        command = commands.add_parser(name)
        command.add_argument("person")
        command.add_argument("--operator", required=True)
        command.add_argument("--execute", action="store_true")
        if name == "run":
            command.add_argument("--snapshot-id")
            command.add_argument("--copy-report", type=Path)
            command.add_argument(
                "--copy-failed",
                action="store_true",
                help="record that the copy job failed; the box stays held",
            )
    return parser


def read_copy_report(path: Path) -> CopyReport:
    """The copy job's report: `{"machine_id", "workspaces", "files", "bytes",
    "symlinks_skipped", "refused", "checksum_mismatches", "source_volume_id",
    "seconds"}` and nothing else."""
    raw = path.read_bytes()
    if len(raw) > MAX_REPORT_BYTES:
        raise CommandError("The copy report is too large to be a report.")
    try:
        body = json.loads(raw)
    except ValueError:
        raise CommandError("The copy report isn't JSON.") from None
    expected = {
        "machine_id",
        "workspaces",
        "files",
        "bytes",
        "symlinks_skipped",
        "refused",
        "checksum_mismatches",
        "source_volume_id",
        "seconds",
    }
    if not isinstance(body, dict) or set(body) != expected:
        raise CommandError(f"The copy report must have exactly {sorted(expected)}.")
    if not isinstance(body["machine_id"], str):
        raise CommandError("The copy report's machine_id isn't text.")
    if not isinstance(body["workspaces"], list) or len(body["workspaces"]) > 64:
        raise CommandError("The copy report's workspaces aren't a short list.")
    return CopyReport(
        machine_id=body["machine_id"],
        workspaces=tuple(body["workspaces"]),
        files=body["files"],
        bytes=body["bytes"],
        symlinks_skipped=body["symlinks_skipped"],
        refused=body["refused"],
        checksum_mismatches=body["checksum_mismatches"],
        source_volume_id=body["source_volume_id"],
        seconds=body["seconds"],
    )


def _print_plan(plan: Plan) -> None:
    print(f"person: {plan.person}  box: {plan.box}  step: {plan.step or 'not started'}")
    for workspace in plan.workspaces:
        moves = "moves" if workspace.still_member else "doesn't move (person left)"
        print(f"  workspace {workspace.workspace}: {moves}")
        for agent_id, name in workspace.agents:
            print(f"    agent {agent_id}  {name}")
        if workspace.providers:
            print(f"    AI logins to give again: {', '.join(workspace.providers)}")
    if plan.disk_total_bytes is not None:
        print(
            f"  v1 disk: {plan.disk_used_bytes} of {plan.disk_total_bytes} bytes used, "
            f"as last reported at {plan.reported_at} (may be stale)"
        )
    print(f"  boxes made: {plan.boxes_made} of {plan.box_ceiling}")
    print(f"next: {plan.next}")


def _require_operator(config: SwitchConfig, operator_id: str) -> None:
    if not OperatorList(config.visibility_operators_path).is_operator(operator_id):
        raise CommandError("--operator isn't on the operators list.")


def _migrations(
    config: SwitchConfig, factory: async_sessionmaker[AsyncSession]
) -> HostedMigrations:
    settings = load_hosted_settings(config.hosted_controller_config_path)
    if settings is None:
        raise CommandError("Hosted agents aren't set up here (no controller config).")
    controllers = AgentControllerStore()
    api_keys = ApiKeyStore()
    operations = AgentControllerOperationStore()

    async def revoke(session: AsyncSession, tenant_id: str, controller_id: str) -> None:
        await revoke_controller_rows(
            session,
            tenant_id,
            controller_id,
            now=datetime.now(UTC),
            controllers=controllers,
            api_keys=api_keys,
            operations=operations,
        )

    async def allowed(machine: CloudMachine) -> bool:
        return await box_allowed(factory, config, settings, machine)

    return HostedMigrations(
        factory,
        config,
        revoke=revoke,
        box_allowed=allowed,
        key=load_keyed_id_key(config),
    )


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    if not set_process_hosted_v2(config):
        raise CommandError("Hosted agents v2 is off here (HOSTED_BOX_PROVISIONING).")
    operator: str | None = getattr(arguments, "operator", None)
    if operator is not None:
        _require_operator(config, operator)
    copied = (
        read_copy_report(arguments.copy_report)
        if getattr(arguments, "copy_report", None) is not None
        else None
    )
    engine = create_engine_from_config(config)
    try:
        migrations = _migrations(config, create_session_factory(engine))
        person = arguments.person
        if arguments.command == "plan":
            _print_plan(await migrations.plan(person))
            return 0
        if arguments.command == "manifest":
            manifest = await migrations.copy_manifest(person)
            body: dict[str, Any] = {
                "machine_id": manifest.machine_id,
                "person": manifest.person,
                "namespace": manifest.namespace,
                "snapshot_id": manifest.snapshot_id,
                "workspaces": [
                    {"tenant_id": tenant, "agent_ids": agents}
                    for tenant, agents in manifest.workspaces
                ],
            }
            print(json.dumps(body, indent=2))
            return 0
        execute = bool(arguments.execute)
        if operator is None:
            raise CommandError("--operator is required.")
        if arguments.command == "run":
            outcome = await migrations.run(
                person,
                operator_id=operator,
                execute=execute,
                snapshot_id=arguments.snapshot_id,
                copied=copied,
                copy_failed=bool(arguments.copy_failed),
            )
        elif arguments.command == "rollback":
            outcome = await migrations.rollback(
                person, operator_id=operator, execute=execute
            )
        else:
            outcome, v1 = await migrations.clean_up(
                person, operator_id=operator, execute=execute
            )
            print("v1 resources to destroy: " + json.dumps(v1))
        print(
            f"{'done' if outcome.executed else 'dry run (pass --execute)'}: "
            f"{outcome.step_before or 'not started'} -> {outcome.step_after}. {outcome.note}"
        )
        return 0
    finally:
        await engine.dispose()


def main() -> None:
    arguments = _parser().parse_args()
    try:
        code = asyncio.run(_run(SwitchConfig(), arguments))
    except MigrationRefused as refused:
        print(f"refused ({refused.code}): {refused}", file=sys.stderr)
        code = 2
    except CommandError as error:
        print(f"refused: {error}", file=sys.stderr)
        code = 2
    raise SystemExit(code)
