"""Automated box removal: Core's half.

When Core deletes a person's box machine (`box_deleted`), it writes a durable
`hosted.box_to_remove` entry; a revival withdraws it
(`hosted.box_to_remove_cancelled`). A v1-to-v2 move rolled back past its flip
writes one too (`flip_back`), naming the box's namespace: the row is the
person's `vm` again, and the box, which holds the copied files, is removed
the same way (`rolled_back_box`). From there, on the cluster:

1. the box provisioner claims the removal here (`claim_removal`, its bearer),
   for a lease, and adds the namespace to the add-only `box-removals` list;
2. the remover asks here, on its own bearer (never the reaper's), before
   deleting a listed namespace (`removal_verdict`): only a claimed, uncancelled removal
   of a deleted box (or a rolled-back move's), under the namespace Core recorded, is
   `removable`;
3. the provisioner, once the namespace and its volumes are gone, confirms
   (`record_removal_gone`) and Core writes `hosted.box_removed`.

The remover also reports every `box-removals` entry it reads
(`unjustified_entries`): any Core doesn't back raises an alert. Once a removal
is claimed, the machine is never revived (`hosted_machine_store`), and its
person-keyed name is never issued again (`box_provision`).

Every function takes the caller's session and opens none; the callers own
the transactions. Ids and namespaces only: never a person's name or email.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import and_, func, literal_column, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import CloudMachine, HostedMigration, ServerAuditEvent
from switch_core.db.stores.hosted_machine_store import lock_machine
from switch_core.visibility.dependencies import process_keyed_id_key
from switch_core.visibility.keyed_id import KeyedIdKind

logger = logging.getLogger(__name__)

CLAIMED = ServerAuditAction.HOSTED_BOX_REMOVAL_CLAIMED.value
REMOVED = ServerAuditAction.HOSTED_BOX_REMOVED.value
TO_REMOVE = ServerAuditAction.HOSTED_BOX_TO_REMOVE.value
CANCELLED = ServerAuditAction.HOSTED_BOX_TO_REMOVE_CANCELLED.value
# A removal can outlive a short lease (the namespace delete is asynchronous,
# and its volumes go after it): no other claim for this long.
LEASE = timedelta(minutes=15)
# A removal named this long ago and not confirmed gone alerts.
STUCK_AFTER = timedelta(hours=24)

# The entry's machine id as one SQL expression with the key written inline, so
# a GROUP BY and its SELECT are the same expression (a bound key wouldn't be).
_MACHINE = ServerAuditEvent.details.op("->>")(literal_column("'machine_id'"))

RemovalState = Literal["none", "pending", "claimed", "cancelled", "gone"]


class RemovalRefused(Exception):
    """A removal call Core won't take; the message is a fixed phrase."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ClaimedRemoval:
    machine_id: str
    namespace: str
    box_keyed_id: str
    lease_seconds: int
    # Sent back with the confirmation; only its hash is kept.
    claim_token: str


@dataclass(frozen=True)
class Verdict:
    removable: bool
    state: RemovalState


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _lock(session: AsyncSession, key: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": key},
    )


ALL = (TO_REMOVE, CANCELLED, CLAIMED, REMOVED)


async def _entries_of(
    session: AsyncSession, machine_ids: Collection[str]
) -> dict[str, list[ServerAuditEvent]]:
    """Every removal entry of each machine, oldest first, in one query on the
    removal index (`ix_server_audit_events_box_removal`)."""
    found: dict[str, list[ServerAuditEvent]] = {mid: [] for mid in machine_ids}
    if not found:
        return found
    rows = await session.scalars(
        select(ServerAuditEvent)
        .where(ServerAuditEvent.action.in_(ALL), _MACHINE.in_(list(found)))
        .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
    )
    for row in rows.all():
        machine_id = (row.details or {}).get("machine_id")
        if machine_id in found:
            found[machine_id].append(row)
    return found


async def _entries(session: AsyncSession, machine_id: str) -> list[ServerAuditEvent]:
    return (await _entries_of(session, [machine_id]))[machine_id]


async def _machines(
    session: AsyncSession, machine_ids: Collection[str]
) -> dict[str, CloudMachine]:
    if not machine_ids:
        return {}
    rows = await session.scalars(
        select(CloudMachine)
        .where(CloudMachine.id.in_(list(machine_ids)))
        .execution_options(populate_existing=True)
    )
    return {machine.id: machine for machine in rows.all()}


def _named_and_not_cancelled(entries: list[ServerAuditEvent]) -> bool:
    """Whether the latest of `box_to_remove` and its cancel is the naming."""
    marks = [e for e in entries if e.action in (TO_REMOVE, CANCELLED)]
    return bool(marks) and marks[-1].action == TO_REMOVE


def _claims(entries: list[ServerAuditEvent]) -> list[ServerAuditEvent]:
    return [e for e in entries if e.action == CLAIMED]


def _removed(entries: list[ServerAuditEvent]) -> bool:
    return any(e.action == REMOVED for e in entries)


def _state(entries: list[ServerAuditEvent]) -> RemovalState:
    if _removed(entries):
        return "gone"
    if not any(e.action in (TO_REMOVE, CANCELLED) for e in entries):
        return "none"
    if not _named_and_not_cancelled(entries):
        return "cancelled"
    return "claimed" if _claims(entries) else "pending"


def _named_namespace(entries: list[ServerAuditEvent]) -> str | None:
    """The namespace the newest naming recorded, when it recorded one (a
    migration rollback's does; `box_deleted`'s doesn't)."""
    marks = [e for e in entries if e.action == TO_REMOVE]
    found = (marks[-1].details or {}).get("namespace") if marks else None
    return found if isinstance(found, str) and found else None


def _row_removable(machine: CloudMachine | None, rolled_back: bool) -> bool:
    """Whether the machine row stands for a box Core no longer runs: a deleted
    box, or the box of a move rolled back, whose row is the person's `vm`
    again (`rolled_back_box`)."""
    if machine is None:
        return False
    if machine.state == "deleted" and machine.backend == "box":
        return True
    return machine.backend == "vm" and rolled_back


async def rolled_back_box(session: AsyncSession, machine: CloudMachine) -> bool:
    """Whether the machine is a `vm` again because its move was rolled back
    past the flip: its owner's migration record is for this machine and
    `rolled_back`. Its box, under the namespace the rollback recorded, is
    Core's to remove."""
    if machine.backend != "vm":
        return False
    record = await session.get(
        HostedMigration, machine.owner_id, populate_existing=True
    )
    return (
        record is not None
        and record.machine_id == machine.id
        and record.step == "rolled_back"
    )


def _verdict(
    machine: CloudMachine | None,
    entries: list[ServerAuditEvent],
    namespace: str,
    rolled_back: bool,
) -> Verdict:
    state = _state(entries)
    named = _named_namespace(entries)
    removable = (
        _row_removable(machine, rolled_back)
        and state == "claimed"
        and (named is None or named == namespace)
        and any(
            (c.details or {}).get("namespace") == namespace for c in _claims(entries)
        )
    )
    return Verdict(removable=removable, state=state)


async def removal_namespace(session: AsyncSession, machine: CloudMachine) -> str | None:
    """The namespace the machine's box lives under: the one its provisions
    recorded, or for a box made before names were recorded, the person-keyed
    one. None with no keyed-id key (no name can be derived)."""
    from switch_core.visibility.box_provision import (
        _recorded_namespace,
        namespace_for,
    )

    recorded = await _recorded_namespace(session, machine.id)
    if recorded is not None:
        return recorded
    key = process_keyed_id_key()
    if key is None:
        return None
    return namespace_for(key.keyed_id(KeyedIdKind.USER, machine.owner_id))


async def removal_state(session: AsyncSession, machine_id: str) -> RemovalState:
    """Where the machine's removal stands, for logs and the remover's check."""
    return _state(await _entries(session, machine_id))


async def claim_removal(session: AsyncSession, now: datetime) -> ClaimedRemoval | None:
    """The oldest box named for removal whose lease is free, claimed for
    `LEASE`: a machine still `deleted`, named and not cancelled, not yet
    confirmed gone. No machine is claimed again while a lease on it is live.
    One claim at a time under its own lock; the claim records the namespace
    (a re-claim after a lease lapsed keeps it), so the remover's check and
    every later reader agree on it. The caller commits."""
    await _lock(session, "box-removal-claims")
    key = process_keyed_id_key()
    if key is None:
        return None
    named = (
        select(
            _MACHINE.label("machine_id"),
            func.min(ServerAuditEvent.occurred_at).label("at"),
        )
        .where(ServerAuditEvent.action == TO_REMOVE)
        .group_by(_MACHINE)
        .subquery()
    )
    removed = (
        select(ServerAuditEvent.id)
        .where(ServerAuditEvent.action == REMOVED, _MACHINE == CloudMachine.id)
        .exists()
    )
    rolled_back = (
        select(HostedMigration.owner_id)
        .where(
            HostedMigration.machine_id == CloudMachine.id,
            HostedMigration.owner_id == CloudMachine.owner_id,
            HostedMigration.step == "rolled_back",
        )
        .exists()
    )
    candidates = list(
        (
            await session.scalars(
                select(CloudMachine.id)
                .join(named, named.c.machine_id == CloudMachine.id)
                .where(
                    or_(
                        and_(
                            CloudMachine.state == "deleted",
                            CloudMachine.backend == "box",
                        ),
                        and_(CloudMachine.backend == "vm", rolled_back),
                    ),
                    ~removed,
                )
                .order_by(named.c.at, CloudMachine.id)
            )
        ).all()
    )
    entries_of = await _entries_of(session, candidates)
    for machine_id in candidates:
        entries = entries_of[machine_id]
        if not _named_and_not_cancelled(entries) or _leased(entries, now):
            continue
        await _lock(session, f"box-removal:{machine_id}")
        # The machine's own lock, as a revival takes it: a claim and a revival
        # can't cross, and a revived machine is never claimed. Read again
        # under both locks.
        await lock_machine(session, machine_id)
        machine = await session.get(CloudMachine, machine_id, populate_existing=True)
        if machine is None or not _row_removable(
            machine, await rolled_back_box(session, machine)
        ):
            continue
        entries = await _entries(session, machine_id)
        if (
            not _named_and_not_cancelled(entries)
            or _removed(entries)
            or _leased(entries, now)
        ):
            continue
        claims = _claims(entries)
        recorded = _named_namespace(entries)
        if claims:
            namespace = str((claims[-1].details or {}).get("namespace"))
        elif recorded is not None:
            namespace = recorded
        else:
            found = await removal_namespace(session, machine)
            if found is None:
                continue
            namespace = found
        token = secrets.token_urlsafe(24)
        box_keyed = key.keyed_id(KeyedIdKind.BOX, machine.id)
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_REMOVAL_CLAIMED,
            target_type="box",
            target_id=box_keyed,
            details={
                "machine_id": machine.id,
                "namespace": namespace,
                "user": key.keyed_id(KeyedIdKind.USER, machine.owner_id),
                "lease_until": (now + LEASE).isoformat(),
                "claim": _token_hash(token),
            },
        )
        return ClaimedRemoval(
            machine_id=machine.id,
            namespace=namespace,
            box_keyed_id=box_keyed,
            lease_seconds=int(LEASE.total_seconds()),
            claim_token=token,
        )
    return None


def _leased(entries: list[ServerAuditEvent], now: datetime) -> bool:
    """Whether the newest claim's lease is still live."""
    claims = _claims(entries)
    if not claims:
        return False
    until = (claims[-1].details or {}).get("lease_until")
    return bool(until) and datetime.fromisoformat(str(until)) > now


async def record_removal_gone(
    session: AsyncSession, machine_id: str, claim_token: str, now: datetime
) -> bool:
    """The provisioner's confirmation that the machine's namespace and its
    volumes are gone. Accepted for the newest claim's token, even after its
    lease lapsed, as long as nobody has claimed it since (a slow but live
    holder is never refused), for a machine still `deleted` and named for
    removal; then `hosted.box_removed`, once (a
    repeat with the same token is accepted and writes nothing). Returns
    whether it wrote the entry. Raises `RemovalRefused` (409) otherwise: the
    caller raises the alert after rolling back. The caller commits."""
    await _lock(session, f"box-removal:{machine_id}")
    machine = await session.get(CloudMachine, machine_id, populate_existing=True)
    entries = await _entries(session, machine_id)
    claims = _claims(entries)
    current = (claims[-1].details or {}) if claims else {}
    if not claims or not hmac.compare_digest(
        str(current.get("claim")), _token_hash(claim_token)
    ):
        raise RemovalRefused(409, "This isn't the removal's current claim.")
    if _removed(entries):
        return False
    rolled_back = machine is not None and await rolled_back_box(session, machine)
    if not _row_removable(machine, rolled_back) or not _named_and_not_cancelled(
        entries
    ):
        raise RemovalRefused(409, "This box isn't Core's to remove.")
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_BOX_REMOVED,
        target_type="box",
        target_id=claims[-1].target_id,
        details={
            "machine_id": machine_id,
            "namespace": current.get("namespace"),
            "user": current.get("user"),
            "by": "provisioner",
            "confirmed_at": now.isoformat(),
        },
    )
    return True


async def removal_verdict(
    session: AsyncSession, machine_id: str, namespace: str
) -> Verdict:
    """The remover's check before deleting a listed namespace: `removable` only
    when the machine is `deleted`, its removal is named, claimed and not
    cancelled, and `namespace` is the one the claim recorded. Already gone is
    not removable (nothing to delete)."""
    machine = await session.get(CloudMachine, machine_id, populate_existing=True)
    rolled_back = machine is not None and await rolled_back_box(session, machine)
    return _verdict(
        machine, await _entries(session, machine_id), namespace, rolled_back
    )


async def unjustified_entries(
    session: AsyncSession, entries: Collection[tuple[str, str]]
) -> list[tuple[str, str]]:
    """The reported `box-removals` entries (namespace, machine id) Core
    doesn't back: no claim for that machine under that namespace, or a
    removal cancelled since, or a machine not `deleted`. A confirmed-gone
    entry is backed. Two queries for the whole report."""
    ids = {machine_id for _, machine_id in entries}
    entries_of = await _entries_of(session, ids)
    machines = await _machines(session, ids)
    unbacked = []
    for namespace, machine_id in entries:
        found = entries_of[machine_id]
        if _state(found) == "gone":
            if any(
                (c.details or {}).get("namespace") == namespace for c in _claims(found)
            ):
                continue
            unbacked.append((namespace, machine_id))
            continue
        machine = machines.get(machine_id)
        rolled_back = machine is not None and await rolled_back_box(session, machine)
        if not _verdict(machine, found, namespace, rolled_back).removable:
            unbacked.append((namespace, machine_id))
    return unbacked


async def person_name_retired(session: AsyncSession, namespace: str) -> bool:
    """Whether a namespace has a removal claimed or confirmed: it's in (or
    about to be in) `box-removals`, so it's never issued to a box again."""
    found = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action.in_([CLAIMED, REMOVED]),
            ServerAuditEvent.details["namespace"].astext == namespace,
        )
    )
    return bool(found)


async def removal_claimed(session: AsyncSession, machine_id: str) -> bool:
    """Whether any removal of this machine was ever claimed: then it's never
    revived (its namespace may already be listed, or deleted)."""
    found = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == CLAIMED,
            _MACHINE == machine_id,
        )
    )
    return bool(found)


async def stuck_removals(session: AsyncSession, now: datetime) -> list[str]:
    """Machines named for removal over `STUCK_AFTER` ago, still not cancelled
    or confirmed gone. Two queries."""
    named = await session.scalars(
        select(_MACHINE)
        .where(ServerAuditEvent.action == TO_REMOVE)
        .group_by(_MACHINE)
        .having(func.max(ServerAuditEvent.occurred_at) < now - STUCK_AFTER)
    )
    ids = [machine_id for machine_id in named.all() if isinstance(machine_id, str)]
    entries_of = await _entries_of(session, ids)
    return [mid for mid in ids if _state(entries_of[mid]) in ("pending", "claimed")]


async def confirmed_gone_among(
    session: AsyncSession, entries: Collection[tuple[str, str]]
) -> list[str]:
    """The namespaces among the reported `box-removals` entries (namespace,
    machine id) whose removal Core has confirmed gone (`hosted.box_removed`)
    under that namespace: the only pairs the admin compaction runbook may
    take out of the lists. One query."""
    entries_of = await _entries_of(session, {mid for _, mid in entries})
    return [
        namespace
        for namespace, machine_id in entries
        if any(
            e.action == REMOVED and (e.details or {}).get("namespace") == namespace
            for e in entries_of[machine_id]
        )
    ]
