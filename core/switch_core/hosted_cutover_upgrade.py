"""Upgrade a database that ran hosted agents on the old server-side session tables.

`b9e4d2a71c05` drops those tables, and what they hold for a hosted agent is
only safe to drop once every retained worker volume has been checked and its
manifest merged with Core's capture. So the upgrade runs in steps, each
refusing until the one before it is done:

- `prepare`: with every hosted launch stopped, run the cutover-manifest
  revision, which captures the tables and makes a volume row per launch.
- `record <launch-id> <check.json>`: apply what `hosted-bootstrap.mjs
  --preflight-check` answered for that launch's stopped volume: a manifest
  decides every item and keeps each import's attachment through the drop, a
  blocked check marks the volume blocked with its reason.
- `status`: what is still missing.
- `upgrade` (the default): check everything the drop depends on, upgrade to
  head, then queue each volume's imports into the wake mailbox.

A database without those tables upgrades exactly as `switch-migrate` would.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from pydantic import BaseModel, ConfigDict, TypeAdapter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.hosted_cutover import (
    CutoverManifest,
    apply_manifest,
    queue_imports,
    record_blocked,
)
from switch_core.config import SwitchConfig
from switch_core.db.boot_lock import boot_lock
from switch_core.db.engine import create_session_factory
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_launch_store import lock_launch
from switch_core.logging_config import configure_logging
from switch_core.main import _migrate_and_grant
from switch_core.version import switch_core_version

logger = logging.getLogger(__name__)

MANIFEST_REVISION = "a3c9e5f71d28"

_HOSTED_AGENTS = """
    SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
    FROM hosted_launches
    WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
    ORDER BY tenant_id, agent_id, created_at DESC
"""

_RETAINED = """
    JOIN hosted_launches l ON l.tenant_id = {alias}.tenant_id AND l.id = {alias}.launch_id
      AND l.state NOT IN ('deleting', 'deleted')
"""

_IMPORT_BLOBS = f"""
    SELECT i.tenant_id, i.launch_id, a->>'mxc' AS uri
    FROM hosted_cutover_items i
    {_RETAINED.format(alias="i")}
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) a
    WHERE i.disposition = 'import'
"""

_GATE: list[tuple[str, str]] = [
    (
        f"""
        SELECT h.launch_id FROM ({_HOSTED_AGENTS}) h
        WHERE NOT EXISTS (SELECT 1 FROM hosted_cutover_volumes v
            WHERE v.tenant_id = h.tenant_id AND v.launch_id = h.launch_id)
        ORDER BY 1
        """,
        "launch {} has no cutover volume; it was created after `prepare`, so "
        "downgrade to 95fc38e451b6 and run `prepare` again",
    ),
    (
        f"""
        SELECT v.launch_id FROM hosted_cutover_volumes v {_RETAINED.format(alias="v")}
        WHERE v.preflight_state = 'pending' ORDER BY 1
        """,
        "the volume of launch {} has no recorded preflight check; run "
        "`--preflight-check` on it and `record` the result",
    ),
    (
        f"""
        SELECT v.launch_id || ': ' || COALESCE(v.blocked_reason, '')
        FROM hosted_cutover_volumes v {_RETAINED.format(alias="v")}
        WHERE v.preflight_state = 'blocked' ORDER BY 1
        """,
        "the preflight check blocked on the volume of launch {}; repair the file "
        "it names, check the volume again and `record` the result",
    ),
    (
        f"""
        SELECT DISTINCT i.launch_id FROM hosted_cutover_items i {_RETAINED.format(alias="i")}
        WHERE i.disposition IS NULL ORDER BY 1
        """,
        "launch {} has cutover items no manifest decided; `record` its volume",
    ),
    (
        f"""
        SELECT i.launch_id || ' ' || i.room_id || ' ' || i.message_id
        FROM hosted_cutover_items i {_RETAINED.format(alias="i")}
        WHERE i.disposition = 'import' AND i.payload IS NULL ORDER BY 1
        """,
        "the import {} has no event to queue",
    ),
    (
        f"""
        SELECT b.launch_id || ' ' || b.uri FROM ({_IMPORT_BLOBS}) b
        WHERE NOT EXISTS (SELECT 1 FROM media_blobs m
            WHERE m.tenant_id = b.tenant_id AND m.uri = b.uri)
        ORDER BY 1
        """,
        "the attachment of an import for launch {} is gone",
    ),
    (
        f"""
        SELECT b.launch_id || ' ' || b.uri FROM ({_IMPORT_BLOBS}) b
        WHERE EXISTS (SELECT 1 FROM media_blobs m
            WHERE m.tenant_id = b.tenant_id AND m.uri = b.uri
              AND m.sdk_session_id IS NOT NULL)
        ORDER BY 1
        """,
        "the attachment of an import for launch {} would be dropped with its "
        "session; `record` the volume again to keep it",
    ),
    (
        f"""
        SELECT latest.command_id FROM (
            SELECT DISTINCT ON (c.tenant_id, s.agent_id, c.command->'origin'->>'roomId',
                                c.command->'origin'->>'messageId')
                c.tenant_id, s.agent_id, c.command_id, c.status->>'status' AS status,
                c.command->'origin'->>'roomId' AS room_id,
                c.command->'origin'->>'messageId' AS message_id
            FROM sdk_session_commands c
            JOIN sdk_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
            JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
            WHERE c.command->'body'->>'type' = 'message.send'
              AND c.command->'origin'->>'roomId' IS NOT NULL
              AND c.command->'origin'->>'messageId' IS NOT NULL
            ORDER BY c.tenant_id, s.agent_id, c.command->'origin'->>'roomId',
                     c.command->'origin'->>'messageId', c.accepted_sequence DESC, c.command_id DESC
        ) latest
        WHERE NOT EXISTS (SELECT 1 FROM hosted_cutover_items i
            WHERE i.tenant_id = latest.tenant_id AND i.agent_id = latest.agent_id
              AND i.kind = 'room_message' AND i.room_id = latest.room_id
              AND i.message_id = latest.message_id
              AND i.evidence->'core'->>'command_id' = latest.command_id
              AND i.evidence->'core'->>'status' IS NOT DISTINCT FROM latest.status)
        UNION ALL
        SELECT c.command_id FROM sdk_session_commands c
        JOIN sdk_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE c.command->'origin'->>'surface' = 'console'
          AND c.command->'origin'->>'roomId' IS NULL
          AND c.status->>'status' = 'accepted'
          AND NOT EXISTS (SELECT 1 FROM hosted_cutover_items i
            WHERE i.tenant_id = c.tenant_id AND i.agent_id = s.agent_id
              AND i.kind = 'console_command'
              AND i.evidence->'core'->>'command_id' = c.command_id)
        UNION ALL
        SELECT p.request_id FROM session_request_posts p
        JOIN sdk_sessions s ON s.tenant_id = p.tenant_id AND s.id = p.session_id
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE p.removed_at IS NULL AND p.room_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM hosted_cutover_items i
            WHERE i.tenant_id = p.tenant_id AND i.agent_id = s.agent_id
              AND i.kind = 'request_open'
              AND i.evidence->'core'->>'request_id' = p.request_id)
        ORDER BY 1
        """,
        "{} changed in the old session tables after `prepare` captured them, so "
        "the old Core ran again; downgrade to 95fc38e451b6 and run `prepare` again",
    ),
]

_PIN_IMPORT_BLOBS = """
    UPDATE media_blobs m SET sdk_session_id = NULL
    FROM hosted_cutover_items i
    CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(i.payload->'payload'->'attachments', '[]'::jsonb)) a
    WHERE i.tenant_id = :tenant AND i.launch_id = :launch AND i.disposition = 'import'
      AND m.tenant_id = i.tenant_id AND m.uri = a->>'mxc'
      AND m.sdk_session_id IS NOT NULL
"""


class CutoverRefused(RuntimeError):
    """A step of the cutover cannot run yet; the message says what is missing."""


class PreflightBlocked(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step: str
    file: str
    line: int | None
    error: str


class ManifestCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manifest: CutoverManifest


class BlockedCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    blocked: PreflightBlocked


#: What `hosted-bootstrap.mjs --preflight-check` printed: a manifest, or why not.
PreflightCheck = ManifestCheck | BlockedCheck
PREFLIGHT_CHECK: TypeAdapter[PreflightCheck] = TypeAdapter(PreflightCheck)


def _owner_engine(config: SwitchConfig) -> AsyncEngine:
    return create_async_engine(
        config.owner_database_url or config.database_url, poolclass=NullPool
    )


def _alembic_config() -> AlembicConfig:
    return AlembicConfig(str(Path(__file__).resolve().parent.parent / "alembic.ini"))


async def _session_tables_present(conn: AsyncConnection) -> bool:
    return bool(
        await conn.scalar(
            text(
                "SELECT to_regclass('sdk_sessions') IS NOT NULL "
                "AND to_regclass('hosted_launches') IS NOT NULL"
            )
        )
    )


async def _versions(conn: AsyncConnection) -> list[str]:
    return list(await conn.scalars(text("SELECT version_num FROM alembic_version")))


async def running_launches(config: SwitchConfig) -> list[str] | None:
    """Launches not yet stopped for good; None when the old session tables are gone."""
    engine = _owner_engine(config)
    try:
        async with engine.connect() as conn:
            if not await _session_tables_present(conn):
                return None
            rows = await conn.scalars(
                text(
                    "SELECT id FROM hosted_launches "
                    "WHERE state NOT IN ('deleting', 'deleted') "
                    "AND NOT (state = 'stopped' AND desired_state = 'stopped' "
                    "AND sleeping = false) ORDER BY id"
                )
            )
            return list(rows)
    finally:
        await engine.dispose()


def _refuse_running(running: list[str]) -> None:
    if running:
        raise CutoverRefused(
            f"{len(running)} hosted launch(es) are not stopped: {', '.join(running)}. "
            "Stop each one with an explicit Stop (desired state stopped, not "
            "sleeping), wait for state stopped, then run this again."
        )


async def _unprepared(conn: AsyncConnection) -> str | None:
    """Why the database is not at the point where volumes are recorded, if it is not."""
    if not await _session_tables_present(conn):
        return (
            "the old session tables are gone; the cutover is past the point where "
            "a volume can be recorded"
        )
    versions = await _versions(conn)
    if versions != [MANIFEST_REVISION]:
        return (
            f"the database is at {', '.join(versions) or 'no revision'}, not "
            f"{MANIFEST_REVISION}; run `hosted-cutover-upgrade prepare` first"
        )
    return None


async def prepare(config: SwitchConfig) -> None:
    """Capture the old session tables at the cutover-manifest revision, launches stopped."""
    running = await running_launches(config)
    if running is None:
        raise CutoverRefused(
            "This database has no old session tables to capture; run "
            "`hosted-cutover-upgrade` to upgrade it."
        )
    _refuse_running(running)
    async with boot_lock(config):
        await asyncio.to_thread(
            alembic_command.upgrade, _alembic_config(), MANIFEST_REVISION
        )
    logger.warning(
        "Captured the old session tables at %s; check and record every volume next",
        MANIFEST_REVISION,
    )


async def record(config: SwitchConfig, launch_id: str, check: PreflightCheck) -> None:
    """Apply one volume's preflight check before the drop."""
    engine = _owner_engine(config)
    try:
        async with engine.connect() as conn:
            unprepared = await _unprepared(conn)
            if unprepared is not None:
                raise CutoverRefused(f"Cannot record launch {launch_id}: {unprepared}.")
            _refuse_running(await running_launches(config) or [])
            row = (
                await conn.execute(
                    text(
                        "SELECT tenant_id, agent_id FROM hosted_launches "
                        "WHERE id = :launch AND agent_id IS NOT NULL"
                    ),
                    {"launch": launch_id},
                )
            ).one_or_none()
        if row is None:
            raise CutoverRefused(
                f"There is no hosted launch {launch_id} with an agent."
            )
        tenant_id, agent_id = row
        async with tenant_session(create_session_factory(engine), tenant_id) as session:
            if isinstance(check, BlockedCheck):
                blocked = check.blocked
                where = (
                    blocked.file
                    if blocked.line is None
                    else f"{blocked.file}:{blocked.line}"
                )
                await record_blocked(
                    session, launch_id, f"{blocked.step} at {where}: {blocked.error}"
                )
            else:
                await apply_manifest(
                    session,
                    agent_id=agent_id,
                    launch_id=launch_id,
                    manifest=check.manifest,
                )
                await session.execute(
                    text(_PIN_IMPORT_BLOBS), {"tenant": tenant_id, "launch": launch_id}
                )
            await session.commit()
    finally:
        await engine.dispose()


async def cutover_problems(config: SwitchConfig) -> list[str]:
    """Everything that still stops the drop, each naming its launch or item."""
    running = await running_launches(config)
    if running is None:
        return []
    engine = _owner_engine(config)
    try:
        async with engine.connect() as conn:
            problems = [f"launch {launch_id} is not stopped" for launch_id in running]
            unprepared = await _unprepared(conn)
            if unprepared is not None:
                return [*problems, unprepared]
            for query, message in _GATE:
                problems += [
                    message.format(row) for row in await conn.scalars(text(query))
                ]
            return problems
    finally:
        await engine.dispose()


async def status(config: SwitchConfig) -> list[dict[str, Any]]:
    engine = _owner_engine(config)
    try:
        async with engine.connect() as conn:
            if not await conn.scalar(
                text("SELECT to_regclass('hosted_cutover_volumes') IS NOT NULL")
            ):
                return []
            rows = await conn.execute(
                text(
                    "SELECT v.launch_id, l.state, v.preflight_state, v.manifest_sha256, "
                    "v.blocked_reason, v.imports_queued_at, "
                    "(SELECT count(*) FROM hosted_cutover_items i "
                    " WHERE i.tenant_id = v.tenant_id AND i.launch_id = v.launch_id "
                    " AND i.disposition IS NULL) AS undecided "
                    "FROM hosted_cutover_volumes v JOIN hosted_launches l "
                    "ON l.tenant_id = v.tenant_id AND l.id = v.launch_id "
                    "ORDER BY v.launch_id"
                )
            )
            return [dict(row._mapping) for row in rows]
    finally:
        await engine.dispose()


async def queue_all_imports(config: SwitchConfig) -> None:
    """Queue the imports of every recorded volume not yet queued, once the mailbox exists."""
    engine = _owner_engine(config)
    try:
        async with engine.connect() as conn:
            volumes = (
                await conn.execute(
                    text(
                        "SELECT v.tenant_id, v.launch_id FROM hosted_cutover_volumes v "
                        + _RETAINED.format(alias="v")
                        + "WHERE v.preflight_state = 'complete' "
                        "AND v.imports_queued_at IS NULL ORDER BY v.launch_id"
                    )
                )
            ).all()
        factory = create_session_factory(engine)
        for tenant_id, launch_id in volumes:
            async with tenant_session(factory, tenant_id) as session:
                await lock_launch(session, launch_id)
                queued = await queue_imports(session, launch_id)
                await session.commit()
            logger.warning(
                "Queued %d cutover import(s) for launch %s", queued, launch_id
            )
    finally:
        await engine.dispose()


async def upgrade(config: SwitchConfig) -> None:
    problems = await cutover_problems(config)
    if problems:
        raise CutoverRefused(
            "Refusing to drop the old session tables:\n- " + "\n- ".join(problems)
        )
    await _migrate_and_grant(config)
    await queue_all_imports(config)


def main() -> None:
    parser = argparse.ArgumentParser(prog="switch-hosted-cutover-upgrade")
    steps = parser.add_subparsers(dest="step")
    steps.add_parser("prepare")
    recording = steps.add_parser("record")
    recording.add_argument("launch_id")
    recording.add_argument("check", type=Path)
    steps.add_parser("status")
    steps.add_parser("upgrade")
    args = parser.parse_args()

    config = SwitchConfig()
    configure_logging(config, switch_core_version())
    if args.step == "prepare":
        asyncio.run(prepare(config))
    elif args.step == "record":
        check = PREFLIGHT_CHECK.validate_json(args.check.read_bytes())
        asyncio.run(record(config, args.launch_id, check))
    elif args.step == "status":
        for volume in asyncio.run(status(config)):
            print(json.dumps(volume, default=str))
        problems = asyncio.run(cutover_problems(config))
        for problem in problems:
            print(f"blocking: {problem}", file=sys.stderr)
    else:
        asyncio.run(upgrade(config))


if __name__ == "__main__":
    main()
