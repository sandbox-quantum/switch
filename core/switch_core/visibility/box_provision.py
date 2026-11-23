"""A new user's box, made on Core's request.

Core never touches the cluster. When an allowed user's machine needs a box,
Core writes a run-once **provision request** to the operators' audit log
(`server_audit_events`), and the provisioner, a separate pod on its
own account, claims it on its own credential (`hosted_provisioner.py`), makes
the box and reports the result. The request is the record: claims and results
are further entries linked to it, and nothing is ever updated.

- **Who needs a box:** a machine that isn't deleted, never had a controller
  enrol (so it has never run a box), and has no open or successful provision.
  A box made by hand before box provisioning has had a controller, so it's never asked for.
  A machine revived after clean-up (same id, `hosted.box_revived`) needs one
  again: only provisions asked for since the revival count.
- **Gates:** the caller has already passed `ensure_machine`'s (allow-lists,
  flag, capacity) and the pause and turn-off checks. The sweep's retries check the
  pause and the lists again before asking.
- **Caps:** at most `hosted_provisions_per_minute` requests a minute and
  `hosted_box_ceiling` boxes made, counted under the claims lock, so two
  processes can't both slip under. Over a cap nothing is written: the machine
  waits, and the next ensure or sweep asks again.
- **What crosses to the provisioner:** the machine id (Core's own opaque id),
  the user's keyed id (the namespace is `agents-user-<keyed id>`) and the size,
  which is always null for now (the provisioner's default applies).
  No name, email, reason or free text.
- **Clocks:** while a provision is open, the machine's start clocks are held
  (the sweep skips them), and a successful result restarts them from then.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import CloudMachine, ServerAuditEvent, require_tenant_id
from switch_core.db.stores.hosted_machine_store import (
    PoolPick,
    _advisory_lock,
    bump_revision,
    ever_hosted,
    lock_claims,
    lock_machine,
    workspaces_on,
)
from switch_core.observability.hosted import record_machine_event
from switch_core.providers.hosted import (
    HostedControllerSettings,
    machines_tenant_allowed,
    machines_user_allowed,
    v2_of,
)
from switch_core.tenant_context import no_tenant
from switch_core.visibility.alerts import Condition, Verdict, apply_alert
from switch_core.visibility.dependencies import process_keyed_id_key
from switch_core.visibility.hosted_access import block_reason, block_reason_in
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

logger = logging.getLogger(__name__)

ACTION = ServerAuditAction.HOSTED_BOX_PROVISION.value
TTL = timedelta(minutes=15)
LEASE = timedelta(seconds=120)
NAMESPACE_PREFIX = "agents-user-"
# New boxes, pool and fallback alike, once the operator can make them
# (`box_keyed_names`): named by the box, never the person.
BOX_NAMESPACE_PREFIX = "agents-box-"
# The provisioner's own steps, as it names where a failure stopped.
FAILED_AT = frozenset(
    {
        "name_refused",
        "policy_refused",
        "object_refused",
        "box_map_failed",
        "ceiling_reached",
    }
)
# A bind's own failures (warm pool), only for a `bind` action. The first two
# come before its owner is written (the box is reapable); the third should
# never happen and is an alert.
BIND_FAILED_AT = frozenset({"bind_machine_mismatch", "bind_closed", "bind_owner_taken"})
# What a provision action asks the operator for: `provision`, a person's box
# made and bound at once (today's); `pool`, a box made with no person; `bind`,
# a waiting pool box given to its person.
Kind = Literal["provision", "pool", "bind"]
KINDS: frozenset[str] = frozenset({"provision", "pool", "bind"})
# The operator capability each kind, and box-keyed naming, needs.
NEEDS: dict[str, str] = {"pool": "pool", "bind": "bind"}

Waiting = Literal["rate", "ceiling"]

BOX_NOT_MADE = "box_not_made"
BOX_NOT_MADE_MESSAGE = (
    "Your cloud box couldn't be made. Retry it in Switch Console, or contact "
    "your administrator if it still cannot start."
)


@dataclass(frozen=True)
class ClaimedProvision:
    action_id: str
    machine_id: str
    # None for a `pool` action: a pool box has no person.
    user_keyed_id: str | None
    size: str | None
    lease_seconds: int
    kind: Kind
    # The box's keyed id, Core's alone to compute (the operator never holds
    # the key), and the exact namespace Core expects the result to name.
    box_keyed_id: str
    namespace: str
    # Proves which claim a result belongs to: a stale worker whose lease
    # passed and whose action was claimed again is refused. Only
    # its hash is kept.
    claim_token: str


class ProvisionRefused(Exception):
    """A provisioner call Core won't take; the message is a fixed phrase."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def namespace_for(user_keyed_id: str) -> str:
    return f"{NAMESPACE_PREFIX}{user_keyed_id}"


def box_namespace_for(box_keyed_id: str) -> str:
    return f"{BOX_NAMESPACE_PREFIX}{box_keyed_id}"


def kind_of(request: ServerAuditEvent) -> Kind:
    """A request's kind; one from before kinds is a `provision`."""
    kind = (request.details or {}).get("kind")
    return kind if kind in KINDS else "provision"  # type: ignore[return-value]


async def _recorded_namespace(session: AsyncSession, machine_id: str) -> str | None:
    """The namespace an earlier claim of this machine's provisions fixed, the
    latest one, if any: a namespace, once handed out, never changes."""
    requests = await session.scalars(
        select(ServerAuditEvent.id).where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.details["machine_id"].astext == machine_id,
        )
    )
    ids = list(requests.all())
    if not ids:
        return None
    found = await session.scalar(
        select(ServerAuditEvent.details["namespace"].astext)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["step"].astext == "claimed",
            ServerAuditEvent.details["linked_to"].astext.in_(ids),
            ServerAuditEvent.details["namespace"].astext.is_not(None),
        )
        .order_by(ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc())
        .limit(1)
    )
    return found if isinstance(found, str) else None


async def _had_a_box_before(
    session: AsyncSession, machine_id: str, request_id: str
) -> bool:
    """Whether this machine had a box before this request named one: a
    revival, or an earlier provision that finished. Such a box was made
    before box-keyed names (or its claim would have recorded its name), so it
    keeps the person-keyed one."""
    if await revived_at(session, machine_id) is not None:
        return True
    finished = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "result",
            ServerAuditEvent.details["result"].astext == "done",
            ServerAuditEvent.details["machine_id"].astext == machine_id,
            ServerAuditEvent.details["linked_to"].astext != request_id,
        )
    )
    return bool(finished)


async def _namespace_to_issue(
    session: AsyncSession,
    request: ServerAuditEvent,
    capabilities: frozenset[str],
) -> str:
    """The namespace this action names, decided when it's first handed out:
    the one an earlier claim fixed; for a box from before box-keyed names,
    the person-keyed one; otherwise box-keyed if the claiming operator can
    make it (`box_keyed_names`), else person-keyed, as before."""
    details = request.details or {}
    machine_id = str(details.get("machine_id"))
    recorded = await _recorded_namespace(session, machine_id)
    if recorded is not None:
        return recorded
    kind = kind_of(request)
    if kind in ("pool", "bind"):
        return box_namespace_for(str(request.target_id))
    if "box_keyed_names" in capabilities and not await _had_a_box_before(
        session, machine_id, request.id
    ):
        return box_namespace_for(str(request.target_id))
    return namespace_for(str(details.get("user")))


def _size_of(machine: CloudMachine) -> str | None:
    """There is one box size and no choice per user, so none is sent and the
    provisioner uses its configured default. Not `instance_type`: that's a
    node type an observation reported, never a box size."""
    return None


async def _requests_for(
    session: AsyncSession, box_keyed: str
) -> list[ServerAuditEvent]:
    rows = await session.execute(
        select(ServerAuditEvent).where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.target_id == box_keyed,
            ServerAuditEvent.details["phase"].astext == "requested",
        )
    )
    return list(rows.scalars().all())


async def _linked(session: AsyncSession, request_id: str) -> list[ServerAuditEvent]:
    rows = await session.execute(
        select(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["linked_to"].astext == request_id,
        )
        .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
    )
    return list(rows.scalars().all())


async def provision_times(
    session: AsyncSession, machine_id: str, since: datetime | None
) -> tuple[datetime | None, datetime | None, datetime | None]:
    """When the machine's latest box request (after `since`, a revival, when
    given) was asked for, claimed by the operator, and answered `done`: for
    timing a first start (`switch.hosted.start_seconds`). Nones where a step
    isn't recorded."""
    query = select(ServerAuditEvent).where(
        ServerAuditEvent.action == ACTION,
        ServerAuditEvent.details["phase"].astext == "requested",
        ServerAuditEvent.details["machine_id"].astext == machine_id,
    )
    if since is not None:
        query = query.where(ServerAuditEvent.occurred_at > since)
    request = await session.scalar(
        query.order_by(
            ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc()
        ).limit(1)
    )
    if request is None:
        return None, None, None
    linked = await _linked(session, request.id)
    claimed = next(
        (e.occurred_at for e in linked if (e.details or {}).get("step") == "claimed"),
        None,
    )
    done = next(
        (
            e.occurred_at
            for e in linked
            if (e.details or {}).get("phase") == "result"
            and (e.details or {}).get("result") == "done"
        ),
        None,
    )
    return request.occurred_at, claimed, done


# A made box the box scaler reported missing from the cluster: a further
# result on its `done` request, with the machine's revision.
MISSING = "missing"
BOX_MISSING = "box_missing"
BOX_MISSING_MESSAGE = (
    "Your cloud box is missing from the cluster. Retry it in Switch Console, or "
    "contact your administrator if it still cannot start."
)


async def _latest_by_machine(
    session: AsyncSession,
    machine_ids: Collection[str],
    *conditions: ColumnElement[bool],
) -> dict[str, datetime]:
    """Per machine id, the latest box provision entry matching `conditions`."""
    if not machine_ids:
        return {}
    machine_id = ServerAuditEvent.details["machine_id"].astext
    rows = await session.execute(
        select(machine_id, func.max(ServerAuditEvent.occurred_at))
        .where(
            ServerAuditEvent.action == ACTION,
            machine_id.in_(list(machine_ids)),
            *conditions,
        )
        .group_by(machine_id)
    )
    return {str(found): at for found, at in rows.all()}


def _result_is(result: str) -> list[ColumnElement[bool]]:
    return [
        ServerAuditEvent.details["phase"].astext == "result",
        ServerAuditEvent.details["result"].astext == result,
    ]


async def boxes_expected(
    session: AsyncSession, machines: Collection[CloudMachine]
) -> frozenset[str]:
    """The box machines whose box Core counts as made, so the box scaler may
    report it missing (`box_expected`): a provision result `done` since the
    machine's latest revival, and no `missing` result after it. A box still
    being made, or made by hand before box provisioning, is never expected."""
    ids = [m.id for m in machines if m.backend == "box"]
    if not ids:
        return frozenset()
    done = await _latest_by_machine(session, ids, *_result_is("done"))
    missing = await _latest_by_machine(session, ids, *_result_is(MISSING))
    revived: dict[str, datetime] = {}
    if done:
        machine_id = ServerAuditEvent.details["machine_id"].astext
        rows = await session.execute(
            select(machine_id, func.max(ServerAuditEvent.occurred_at))
            .where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REVIVED.value,
                machine_id.in_(list(done)),
            )
            .group_by(machine_id)
        )
        revived = {str(found): at for found, at in rows.all()}
    return frozenset(
        machine
        for machine, done_at in done.items()
        if (machine not in revived or done_at > revived[machine])
        and (machine not in missing or done_at > missing[machine])
    )


async def last_missing_at(session: AsyncSession, machine_id: str) -> datetime | None:
    """When the machine's box was last reported missing, if ever."""
    return (await _latest_by_machine(session, [machine_id], *_result_is(MISSING))).get(
        machine_id
    )


async def missing_at_revision(
    session: AsyncSession, machine_id: str, revision: int
) -> bool:
    """Whether the machine's box was already reported missing at `revision`."""
    found = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["machine_id"].astext == machine_id,
            *_result_is(MISSING),
            ServerAuditEvent.details["revision"].astext == str(revision),
        )
    )
    return bool(found)


async def record_box_missing(session: AsyncSession, machine: CloudMachine) -> bool:
    """Record the box scaler's finding that the machine's made box is missing:
    a `missing` result on the request whose result was `done`, with the
    machine's revision. False, recording nothing, when Core doesn't count
    its box as made (still being made, already reported missing, or never
    made by a provision): a late or repeated report. The caller holds the
    machine's lock and commits."""
    if machine.id not in await boxes_expected(session, [machine]):
        return False
    done = await session.scalar(
        select(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["machine_id"].astext == machine.id,
            *_result_is("done"),
        )
        .order_by(ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc())
        .limit(1)
    )
    assert done is not None
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_BOX_PROVISION,
        target_type="box",
        target_id=done.target_id,
        details={
            "phase": "result",
            "result": MISSING,
            "linked_to": (done.details or {}).get("linked_to"),
            "machine_id": machine.id,
            "revision": machine.revision,
        },
    )
    return True


async def removal_pending(session: AsyncSession, machine_id: str) -> bool:
    """Whether the machine's box disk is named for removal
    (`hosted.box_to_remove`) and that hasn't been cancelled since."""
    latest = await session.scalar(
        select(ServerAuditEvent.action)
        .where(
            ServerAuditEvent.action.in_(
                [
                    ServerAuditAction.HOSTED_BOX_TO_REMOVE.value,
                    ServerAuditAction.HOSTED_BOX_TO_REMOVE_CANCELLED.value,
                ]
            ),
            ServerAuditEvent.details["machine_id"].astext == machine_id,
        )
        .order_by(ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc())
        .limit(1)
    )
    return latest == ServerAuditAction.HOSTED_BOX_TO_REMOVE.value


async def record_controllers_revoked(
    session_factory: async_sessionmaker[AsyncSession],
    machine: CloudMachine,
    *,
    by: Literal["re_ask", "retry"],
    controllers: int,
) -> None:
    """Write and commit, in a transaction of its own, the
    `hosted.box_controllers_revoked` entry for a missing box whose workspace
    controllers are about to be revoked (`cloud_controllers.forget_missing_box`):
    the machine, the reason, re-ask or Retry, its revision and how many. Called
    before any revoke, so none is ever unrecorded. `server_audit_events`
    carries no tenant, so nothing is bound."""
    with no_tenant():
        async with session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_CONTROLLERS_REVOKED,
                target_type="cloud_machine",
                target_id=machine.id,
                details={
                    "machine_id": machine.id,
                    "reason": BOX_MISSING,
                    "by": by,
                    "revision": machine.revision,
                    "controllers": controllers,
                },
            )
            await session.commit()


def box_missing_error(
    session: AsyncSession, machine: CloudMachine, now: datetime
) -> None:
    """A missing box Core won't ask for again: the machine goes to error,
    counted once as `failed`/`box_missing`. The owner's Retry asks for a new
    box (`request_box_if_needed` counts only provisions since the missing
    report). The caller holds the machine's lock."""
    if machine.state != "error":
        record_machine_event(session, "failed", BOX_MISSING, machine.backend)
    machine.state = "error"
    machine.error_code = BOX_MISSING
    machine.error = BOX_MISSING_MESSAGE
    machine.updated_at = now


def _result_of(linked: list[ServerAuditEvent]) -> str | None:
    for entry in linked:
        if (entry.details or {}).get("phase") == "result":
            return str((entry.details or {}).get("result"))
    return None


def _expires_at(request: ServerAuditEvent) -> datetime:
    return request.occurred_at + TTL


async def revived_at(session: AsyncSession, machine_id: str) -> datetime | None:
    """When the machine's row was last revived after a clean-up, if ever."""
    found: datetime | None = await session.scalar(
        select(func.max(ServerAuditEvent.occurred_at)).where(
            ServerAuditEvent.action == ServerAuditAction.HOSTED_BOX_REVIVED.value,
            ServerAuditEvent.details["machine_id"].astext == machine_id,
        )
    )
    return found


async def _box_state(
    session: AsyncSession,
    box_keyed: str,
    now: datetime,
    since: datetime | None = None,
) -> Literal["none", "open", "done"]:
    """Whether the box has no provision, an open one, or a successful one.
    With `since` (a revival), only provisions asked for after it count: the
    old box is gone."""
    state: Literal["none", "open", "done"] = "none"
    for request in await _requests_for(session, box_keyed):
        if since is not None and request.occurred_at <= since:
            continue
        result = _result_of(await _linked(session, request.id))
        if result == "done":
            return "done"
        if result is None and now < _expires_at(request):
            state = "open"
    return state


async def _requests_in_window(session: AsyncSession, now: datetime) -> int:
    """Provision requests (of every kind, binds included) in the last minute."""
    recent = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.occurred_at > now - timedelta(minutes=1),
        )
    )
    return recent or 0


async def _cap_reached(
    session: AsyncSession, *, now: datetime, per_minute: int, ceiling: int
) -> Waiting | None:
    if await _requests_in_window(session, now) >= per_minute:
        return "rate"
    if await boxes_made(session) >= ceiling:
        return "ceiling"
    return None


async def boxes_made(session: AsyncSession) -> int:
    """The boxes counted against `hosted_box_ceiling`: machines a provision
    made and that aren't deleted. The one count both the ceiling check and the
    operator overview use, so the page never disagrees with a refusal.

    A revived machine still counts from its old box until its new one is
    made: that over-counts by a box at most, never under (the safe side)."""
    made_ids = select(ServerAuditEvent.details["machine_id"].astext).where(
        ServerAuditEvent.action == ACTION,
        ServerAuditEvent.details["phase"].astext == "result",
        ServerAuditEvent.details["result"].astext == "done",
    )
    made = await session.scalar(
        select(func.count())
        .select_from(CloudMachine)
        .where(CloudMachine.state != "deleted", CloudMachine.id.in_(made_ids))
    )
    return made or 0


async def box_allowed(
    factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    settings: HostedControllerSettings,
    machine: CloudMachine,
) -> bool:
    """Whether the machine's owner may still have a box made: on the user
    list, and not paused or turned off in at least one listed workspace the
    machine serves. Checked when the sweep asks again and when the provisioner
    claims, so a gate that closed since Core asked still holds."""
    if machine.state == "deleted" or machine.desired_state == "deleted":
        return False
    # The server's main switch, as `machines_enabled` reads it.
    if not config.hosted_agents_enabled or config.hosted_launch_capacity <= 0:
        return False
    v2 = v2_of(config)
    if not machines_user_allowed(settings, machine.owner_id, v2=v2):
        return False
    for workspace in await workspaces_on(factory, machine.id):
        if not machines_tenant_allowed(settings, workspace.tenant_id, v2=v2):
            continue
        if await block_reason(factory, machine.owner_id, workspace.tenant_id) is None:
            return True
    return False


async def request_box_if_needed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    machine_id: str,
    key: KeyedIdKey,
    now: datetime,
    per_minute: int,
    ceiling: int,
    allowed: Callable[[CloudMachine], Awaitable[bool]],
) -> str | Waiting | None:
    """Ask for the machine's box if it needs one and the caps allow it.

    Returns the request's id, "rate" or "ceiling" when a cap holds it back, or
    None when no box is needed (it has one, one is being made, or it has run).
    Safe to repeat: under the claims lock, a second call finds the first's
    request and writes nothing.
    """
    workspaces = await workspaces_on(session_factory, machine_id)
    with no_tenant():
        async with session_factory() as session:
            await lock_claims(session)
            await lock_machine(session, machine_id)
            machine = await session.get(
                CloudMachine, machine_id, populate_existing=True
            )
            if (
                machine is None
                or machine.state == "deleted"
                or machine.desired_state == "deleted"
                # In error, as after a failed provision: a retry asks again.
                or machine.state == "error"
                # A v1 EC2 machine is `serve`'s, never box provisioning's.
                or machine.backend != "box"
                # Every gate, here as well as in the callers and at claim:
                # the main switch, the lists, pause and turn-off.
                or not await allowed(machine)
            ):
                await session.commit()
                return None
            revived = await revived_at(session, machine.id)
            missing = await last_missing_at(session, machine.id)
            if revived is None and missing is None and ever_hosted(workspaces):
                # Run before, by hand or by an earlier provision, and never cleaned
                # up and revived or reported missing: it has its box.
                await session.commit()
                return None
            # Only provisions since the old box went count: a revival, or the
            # box scaler finding the made box missing.
            since = max(
                (at for at in (revived, missing) if at is not None), default=None
            )
            box_keyed = key.keyed_id(KeyedIdKind.BOX, machine.id)
            if await _box_state(session, box_keyed, now, since) != "none":
                await session.commit()
                return None
            waiting = await _cap_reached(
                session, now=now, per_minute=per_minute, ceiling=ceiling
            )
            if waiting is not None:
                await session.commit()
                logger.warning(
                    "A box wasn't asked for yet: the %s cap is reached", waiting
                )
                return waiting
            request = await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_PROVISION,
                target_type="box",
                target_id=box_keyed,
                details={
                    "phase": "requested",
                    "by": "core",
                    "machine_id": machine.id,
                    "user": key.keyed_id(KeyedIdKind.USER, machine.owner_id),
                    "size": _size_of(machine),
                    "expires_at": (now + TTL).isoformat(),
                },
            )
            request_id = request.id
            await session.commit()
    return request_id


async def open_provision_machines(
    session: AsyncSession, now: datetime
) -> frozenset[str]:
    """Machine ids with an open provision, for the sweep to hold their clocks."""
    rows = await session.execute(
        select(ServerAuditEvent).where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.occurred_at > now - TTL,
        )
    )
    open_ids: set[str] = set()
    for request in rows.scalars().all():
        if _result_of(await _linked(session, request.id)) is None:
            machine_id = (request.details or {}).get("machine_id")
            if isinstance(machine_id, str):
                open_ids.add(machine_id)
    return frozenset(open_ids)


async def claim_provision(
    session: AsyncSession,
    now: datetime,
    is_blocked: Callable[[str], Awaitable[bool]] | None = None,
    capabilities: frozenset[str] = frozenset(),
    pool_blocked: Callable[[str], Awaitable[bool]] | None = None,
    template_revision: str | None = None,
) -> ClaimedProvision | None:
    """The oldest open provision whose lease is free, claimed for `LEASE`,
    among the kinds the claiming operator can carry out (`capabilities`; with
    none, `provision` only, as before).

    One claim at a time under its own lock. An expired request is never
    handed out, and one whose lease has passed with no result can be claimed
    again, since the provisioner's steps are safe to repeat. The namespace is
    decided when an action is first handed out and recorded on its `claimed`
    entry; a later claim of the same action names the same one. A `pool`
    action is checked with `pool_blocked` (no person to gate), the others
    with `is_blocked`. The caller commits.
    """
    await _advisory_lock(session, "box-provision-claims")
    rows = await session.execute(
        select(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.occurred_at > now - TTL,
        )
        .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
    )
    for request in rows.scalars().all():
        kind = kind_of(request)
        if kind in NEEDS and NEEDS[kind] not in capabilities:
            continue  # this operator can't carry it out
        # The action's own lock, as a result takes it, so a claim and a result
        # can't cross: the order is always claims, then action.
        await _advisory_lock(session, f"box-provision:{request.id}")
        linked = await _linked(session, request.id)
        if _result_of(linked) is not None:
            continue
        leases = [
            datetime.fromisoformat(str((e.details or {}).get("lease_until")))
            for e in linked
            if (e.details or {}).get("step") == "claimed"
            and (e.details or {}).get("lease_until")
        ]
        if leases and max(leases) > now:
            continue
        details = request.details or {}
        machine_id = str(details.get("machine_id"))
        check = pool_blocked if kind == "pool" else is_blocked
        if check is not None and await check(machine_id):
            # Paused, turned off or off the lists since Core asked:
            # the box isn't made, and the request ends here.
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_PROVISION,
                target_type="box",
                target_id=request.target_id,
                details={
                    "phase": "result",
                    "result": "failed",
                    "step": "blocked",
                    "linked_to": request.id,
                    "machine_id": machine_id,
                },
            )
            continue
        namespace = await _namespace_to_issue(session, request, capabilities)
        if namespace.startswith(BOX_NAMESPACE_PREFIX) and (
            "box_keyed_names" not in capabilities
        ):
            continue  # fixed box-keyed by an earlier claim: not this operator's
        token = secrets.token_urlsafe(24)
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=request.target_id,
            details={
                "phase": "progress",
                "step": "claimed",
                "linked_to": request.id,
                "lease_until": (now + LEASE).isoformat(),
                "claim": _token_hash(token),
                "namespace": namespace,
                # The claiming operator's template revision: a pool box is
                # recorded as made at it.
                **(
                    {"template_revision": template_revision}
                    if template_revision is not None
                    else {}
                ),
            },
        )
        user = details.get("user")
        return ClaimedProvision(
            action_id=request.id,
            machine_id=machine_id,
            user_keyed_id=user if isinstance(user, str) and kind != "pool" else None,
            size=details.get("size") if isinstance(details.get("size"), str) else None,
            lease_seconds=int(LEASE.total_seconds()),
            claim_token=token,
            kind=kind,
            box_keyed_id=str(request.target_id),
            namespace=namespace,
        )
    return None


async def record_provision_result(
    session: AsyncSession,
    *,
    action_id: str,
    result: str,
    namespace: str,
    failed_at: str | None,
    claim_token: str,
    now: datetime,
) -> None:
    """The provisioner's result for one request, checked strictly. The caller
    commits. Raises `ProvisionRefused` with a fixed phrase otherwise."""
    if result not in ("done", "failed"):
        raise ProvisionRefused(422, "Unknown result.")
    if result == "failed" and failed_at not in FAILED_AT | BIND_FAILED_AT:
        raise ProvisionRefused(422, "Unknown step.")
    if result == "done" and failed_at is not None:
        raise ProvisionRefused(422, "A finished provision names no failed step.")
    await _advisory_lock(session, f"box-provision:{action_id}")
    request = await session.get(ServerAuditEvent, action_id, populate_existing=True)
    if (
        request is None
        or request.action != ACTION
        or (request.details or {}).get("phase") != "requested"
    ):
        raise ProvisionRefused(404, "No such provision.")
    linked = await _linked(session, request.id)
    if _result_of(linked) is not None:
        raise ProvisionRefused(409, "This provision already has its result.")
    claimed = [
        e.details or {} for e in linked if (e.details or {}).get("step") == "claimed"
    ]
    if not claimed or not hmac.compare_digest(
        str(claimed[-1].get("claim")), _token_hash(claim_token)
    ):
        raise ProvisionRefused(409, "This isn't the provision's current claim.")
    if now >= _expires_at(request):
        raise ProvisionRefused(409, "This provision has expired.")
    details = request.details or {}
    kind = kind_of(request)
    if failed_at in BIND_FAILED_AT and kind != "bind":
        raise ProvisionRefused(422, "Unknown step.")
    # The namespace Core issued with the claim; a claim from before issued
    # names was always the person-keyed one.
    issued = claimed[-1].get("namespace") or namespace_for(str(details.get("user")))
    if namespace != issued:
        raise ProvisionRefused(422, "The namespace isn't this provision's.")
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_BOX_PROVISION,
        target_type="box",
        target_id=request.target_id,
        details={
            "phase": "result",
            "result": result,
            "linked_to": request.id,
            "machine_id": details.get("machine_id"),
            **({"step": failed_at} if failed_at else {}),
        },
    )
    machine_id = details.get("machine_id")
    if kind == "bind" and isinstance(machine_id, str) and result == "failed":
        await fail_bind(session, machine_id, linked, now)
        return
    if kind == "pool" and isinstance(machine_id, str):
        # A pool box: made, it's waiting, at the revision its claim recorded;
        # not made, it retires (reapable: no person ever had it).
        from switch_core.db.stores import hosted_pool_store

        if result == "done":
            await hosted_pool_store.mark_waiting(
                session,
                machine_id,
                namespace=namespace,
                template_revision=claimed[-1].get("template_revision"),
                now=now,
            )
        else:
            await hosted_pool_store.retire(session, machine_id, "make_failed", now)
        return
    if isinstance(machine_id, str):
        await lock_machine(session, machine_id)
        machine = await session.get(CloudMachine, machine_id, populate_existing=True)
        if machine is not None and result == "done":
            # The start clocks run from the box's existence, not the claim.
            machine.updated_at = now
        elif machine is not None and machine.state != "deleted":
            _box_not_made(session, machine, now)


# A capable operator must have polled within this for refill to run: a Core
# deployed before the cluster changes makes no pool boxes.
OPERATOR_FRESH = timedelta(minutes=5)


async def refill_pool(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    now: datetime,
) -> list[str]:
    """Ask for pool boxes up to `hosted_pool_size`: `size − (waiting +
    requested)` new `pool` requests, only with box provisioning on, a key to
    name them, and a box operator that said it can make pool boxes within
    `OPERATOR_FRESH`. Under the claims lock, counted against the per-minute
    limit and the ceiling like any request, and never taking the last free
    slot of the per-minute window (a person's fallback comes first). Returns
    the new pool box ids."""
    from switch_core.db.stores import hosted_pool_store

    size = getattr(config, "hosted_pool_size", 0)
    key = process_keyed_id_key()
    if size <= 0 or key is None or not box_provisioning_on(config):
        return []
    made: list[str] = []
    with no_tenant():
        async with session_factory() as session:
            await lock_claims(session)
            operator = await hosted_pool_store.operator(session)
            if (
                operator is None
                or now - operator.seen_at > OPERATOR_FRESH
                or "pool" not in (operator.capabilities or [])
            ):
                await session.commit()
                return []
            counted = await hosted_pool_store.counts(session)
            wanted = size - counted["waiting"] - counted["requested"]
            for _ in range(max(0, wanted)):
                waiting = await _cap_reached(
                    session,
                    now=now,
                    per_minute=max(0, config.hosted_provisions_per_minute - 1),
                    ceiling=config.hosted_box_ceiling,
                )
                if waiting is not None:
                    break
                (box_id,) = await hosted_pool_store.request_boxes(session, 1, now)
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=ServerAuditAction.HOSTED_BOX_PROVISION,
                    target_type="box",
                    target_id=key.keyed_id(KeyedIdKind.BOX, box_id),
                    details={
                        "phase": "requested",
                        "by": "core",
                        "kind": "pool",
                        "machine_id": box_id,
                        "size": None,
                        "expires_at": (now + TTL).isoformat(),
                    },
                )
                made.append(box_id)
            await session.commit()
    return made


def pool_pick_for(
    config: SwitchConfig, settings: HostedControllerSettings | None
) -> PoolPick | None:
    """The warm pool's pick for `CloudMachineStore.claim` (T1), or None when
    this server takes no pool boxes (no pool, box provisioning off, no
    settings): then every new box is made from scratch, as before."""
    if (
        settings is None
        or getattr(config, "hosted_pool_size", 0) <= 0
        or not box_provisioning_on(config)
    ):
        return None
    gate_settings = settings

    async def pick(session: AsyncSession, owner_id: str, now: datetime) -> str | None:
        return await claim_pool_box(
            session, owner_id=owner_id, config=config, settings=gate_settings, now=now
        )

    return pick


async def claim_pool_box(
    session: AsyncSession,
    *,
    owner_id: str,
    config: SwitchConfig,
    settings: HostedControllerSettings,
    now: datetime,
) -> str | None:
    """T1, the claim: inside `CloudMachineStore.claim`, under `lock_claims`,
    on its session (bound to the claiming workspace), only where a brand-new
    box row would be inserted. Takes the oldest current, in-date waiting pool
    box (`FOR UPDATE SKIP LOCKED`), marks it claimed (checked to change one
    row), and writes the `hosted.pool_box_claimed` entry and the `bind`
    request; the caller inserts the machine with the returned id, in the same
    transaction. None, and nothing written, when there's no box to take or
    any gate a made box would meet is shut: then the person gets a box made
    from scratch at once (the fallback), which meets the same gates.

    The gates, as for any box: a keyed-id key, a box operator seen within
    `OPERATOR_FRESH` that can bind and name boxes by box, the user and
    workspace lists, no pause, turn-off or suspension here, and room in the
    per-minute window (a claim counts as a request in it). A pool box is
    counted against the ceiling already, so a claim doesn't count again."""
    from switch_core.db.stores import hosted_pool_store

    key = process_keyed_id_key()
    if key is None:
        return None
    operator = await hosted_pool_store.operator(session)
    if (
        operator is None
        or now - operator.seen_at > OPERATOR_FRESH
        or not {"bind", "box_keyed_names"} <= set(operator.capabilities or [])
    ):
        return None
    tenant_id = require_tenant_id()
    v2 = v2_of(config)
    if not machines_user_allowed(
        settings, owner_id, v2=v2
    ) or not machines_tenant_allowed(settings, tenant_id, v2=v2):
        return None
    if await block_reason_in(session, owner_id, tenant_id) is not None:
        return None
    if await _requests_in_window(session, now) >= config.hosted_provisions_per_minute:
        return None
    box = await hosted_pool_store.pick_waiting(session, operator.template_revision, now)
    if box is None or not await hosted_pool_store.mark_claimed(session, box.id, now):
        return None
    box_keyed = key.keyed_id(KeyedIdKind.BOX, box.id)
    user_keyed = key.keyed_id(KeyedIdKind.USER, owner_id)
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_POOL_BOX_CLAIMED,
        target_type="box",
        target_id=box_keyed,
        details={"machine_id": box.id, "user": user_keyed},
    )
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_BOX_PROVISION,
        target_type="box",
        target_id=box_keyed,
        details={
            "phase": "requested",
            "by": "core",
            "kind": "bind",
            "machine_id": box.id,
            "user": user_keyed,
            "size": None,
            "expires_at": (now + TTL).isoformat(),
        },
    )
    return box.id


async def refill_after_claim(
    session_factory: async_sessionmaker[AsyncSession],
    config: SwitchConfig,
    machine_id: str,
    now: datetime,
) -> list[str]:
    """Refill the pool just after T1 commits, when this machine took a pool
    box within the last minute; the sweep refills too. Returns the new pool
    box ids (none with no pool, or when the machine was made from scratch)."""
    from switch_core.db.stores import hosted_pool_store

    if getattr(config, "hosted_pool_size", 0) <= 0:
        return []
    with no_tenant():
        async with session_factory() as session:
            row = await hosted_pool_store.get(session, machine_id)
            await session.commit()
    if (
        row is None
        or row.state != "claimed"
        or row.claimed_at is None
        or now - row.claimed_at > timedelta(minutes=1)
    ):
        return []
    return await refill_pool(session_factory, config, now)


# A bind that reached this step is the person's: never reaped, never pooled.
OWNER_WRITING = "owner_writing"
# How long Core gives a bind to finish before it fails the claim.
BIND_TIMEOUT = timedelta(seconds=30)
BIND_TIMED_OUT = "bind_timeout"


async def fail_bind(
    session: AsyncSession,
    machine_id: str,
    linked: Collection[ServerAuditEvent],
    now: datetime,
) -> None:
    """A claim whose bind failed, reported by the operator or timed out by
    Core. It never goes back to the pool, and the person's next click gets a
    new machine (the row is deleted at once and never revived, `BIND_FAILED`).

    Before `owner_writing` nothing of the person's reached the box: the pool
    row retires as `failed_before_owner`, which the reaper destroys. From
    `owner_writing` on, the box is the person's: a `hosted.box_to_remove`
    entry names it for the removal step, and the reaper never touches it. The
    caller holds the action's lock (so `owner_writing` can't land meanwhile)
    and commits."""
    from switch_core.db.stores import hosted_pool_store
    from switch_core.db.stores.hosted_machine_store import (
        BIND_FAILED,
        _box_removal_entry,
    )

    await lock_machine(session, machine_id)
    machine = await session.get(CloudMachine, machine_id, populate_existing=True)
    reached = reached_owner(linked)
    if not reached:
        await hosted_pool_store.retire(
            session,
            machine_id,
            "failed_before_owner",
            now,
            from_states=("claimed",),
        )
    if machine is None or machine.state == "deleted":
        return
    if reached:
        await _box_removal_entry(
            session, machine, ServerAuditAction.HOSTED_BOX_TO_REMOVE
        )
    record_machine_event(session, "failed", "launch_refused", machine.backend)
    machine.state = "deleted"
    machine.desired_state = "deleted"
    machine.error_code = BIND_FAILED
    machine.error = None
    bump_revision(machine, now)


async def expire_binds(session: AsyncSession, now: datetime) -> int:
    """Fail each bind still open `BIND_TIMEOUT` after Core asked for it, as
    `failed` at `bind_timeout`, and its claim with it (`fail_bind`). A `done`
    that arrives later is refused (the action has its result); by then Core
    has already treated the box as the person's if its owner was written.
    Returns how many. The caller commits."""
    rows = await session.execute(
        select(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.details["kind"].astext == "bind",
            ServerAuditEvent.occurred_at <= now - BIND_TIMEOUT,
            ServerAuditEvent.occurred_at > now - TTL - timedelta(days=1),
        )
        .order_by(ServerAuditEvent.id)
    )
    failed = 0
    for request in rows.scalars().all():
        await _advisory_lock(session, f"box-provision:{request.id}")
        linked = await _linked(session, request.id)
        if _result_of(linked) is not None:
            continue
        machine_id = (request.details or {}).get("machine_id")
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=request.target_id,
            details={
                "phase": "result",
                "result": "failed",
                "step": BIND_TIMED_OUT,
                "by": "core",
                "linked_to": request.id,
                "machine_id": machine_id,
            },
        )
        failed += 1
        if isinstance(machine_id, str):
            await fail_bind(session, machine_id, linked, now)
    return failed


async def _current_claim(
    session: AsyncSession, action_id: str, claim_token: str, now: datetime
) -> tuple[ServerAuditEvent, list[ServerAuditEvent]] | None:
    """The request and its linked entries, when `claim_token` is its current
    claim's, it has no result, and it hasn't expired; else None. The caller
    holds the action's lock."""
    request = await session.get(ServerAuditEvent, action_id, populate_existing=True)
    if (
        request is None
        or request.action != ACTION
        or (request.details or {}).get("phase") != "requested"
        or now >= _expires_at(request)
    ):
        return None
    linked = await _linked(session, request.id)
    if _result_of(linked) is not None:
        return None
    claims = [
        (e.details or {}).get("claim")
        for e in linked
        if (e.details or {}).get("step") == "claimed"
    ]
    if (
        not claims
        or not claim_token
        or not hmac.compare_digest(str(claims[-1]), _token_hash(claim_token))
    ):
        return None
    return request, linked


async def action_is_open(
    session: AsyncSession, action_id: str, claim_token: str, now: datetime
) -> bool:
    """Whether this claim of the action is still open: current, with no
    result, unexpired. The bind's re-check before its last step (B4)."""
    await _advisory_lock(session, f"box-provision:{action_id}")
    return await _current_claim(session, action_id, claim_token, now) is not None


def reached_owner(linked: Collection[ServerAuditEvent]) -> bool:
    """Whether a bind recorded `owner_writing`: from then on its box is the
    person's, whatever else Core believes about it."""
    return any((e.details or {}).get("step") == OWNER_WRITING for e in linked)


async def record_provision_step(
    session: AsyncSession,
    *,
    action_id: str,
    step: str,
    claim_token: str,
    now: datetime,
) -> None:
    """A bind's write-ahead `owner_writing`, recorded only while the bind is
    open; otherwise `ProvisionRefused` (409), and the operator writes
    nothing. The caller commits."""
    if step != OWNER_WRITING:
        raise ProvisionRefused(422, "Unknown step.")
    await _advisory_lock(session, f"box-provision:{action_id}")
    current = await _current_claim(session, action_id, claim_token, now)
    if current is None:
        raise ProvisionRefused(409, "This bind isn't open.")
    request, linked = current
    if kind_of(request) != "bind":
        raise ProvisionRefused(422, "Only a bind writes an owner.")
    if reached_owner(linked):
        return  # said already: the same answer again
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_BOX_PROVISION,
        target_type="box",
        target_id=request.target_id,
        details={
            "phase": "progress",
            "step": OWNER_WRITING,
            "linked_to": request.id,
        },
    )


async def _bind_reached_owner(session: AsyncSession, pool_box_id: str) -> bool:
    """Whether any bind of this pool box (its machine has the pool box's id)
    recorded `owner_writing`."""
    binds = await session.scalars(
        select(ServerAuditEvent.id).where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.details["kind"].astext == "bind",
            ServerAuditEvent.details["machine_id"].astext == pool_box_id,
        )
    )
    ids = list(binds.all())
    if not ids:
        return False
    found = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["step"].astext == OWNER_WRITING,
            ServerAuditEvent.details["linked_to"].astext.in_(ids),
        )
    )
    return bool(found)


async def record_pool_box_gone(
    session: AsyncSession, pool_box_id: str, now: datetime
) -> None:
    """The reaper's report that it destroyed a pool box: accepted only for a
    `retiring` box with a reapable reason whose bind never reached its owner;
    then `gone`, with a `hosted.pool_box_retired` audit entry. Anything else
    is refused (409) and alerts: the cluster's own policy is the last word on
    the delete, but Core never agrees to one it shouldn't. The caller commits."""
    from switch_core.db.stores import hosted_pool_store

    await _advisory_lock(session, f"hosted-pool:{pool_box_id}")
    row = await hosted_pool_store.get(session, pool_box_id)
    reached = await _bind_reached_owner(session, pool_box_id)
    if (
        row is None
        or row.state != "retiring"
        or row.retire_reason not in hosted_pool_store.REAPABLE
        or reached
    ):
        logger.error(
            "The reaper reported a pool box gone that Core never agreed to reap "
            "(state %s, reason %s, owner written %s).",
            None if row is None else row.state,
            None if row is None else row.retire_reason,
            reached,
        )
        await _pool_alert(session, now)
        raise ProvisionRefused(409, "This pool box isn't Core's to reap.")
    await hosted_pool_store.mark_gone(session, pool_box_id, now)
    await record_server_audit_event(
        session,
        actor_user_id=None,
        action=ServerAuditAction.HOSTED_POOL_BOX_RETIRED,
        target_type="box",
        target_id=_keyed_box_id(pool_box_id),
        details={"reason": row.retire_reason, "pool_box_id": pool_box_id},
    )


def _keyed_box_id(box_id: str) -> str | None:
    key = process_keyed_id_key()
    return None if key is None else key.keyed_id(KeyedIdKind.BOX, box_id)


async def _pool_alert(session: AsyncSession, now: datetime) -> None:
    """Placeholder for the pool's alert (`pool_reap_refused`), wired with the
    pool's alerts; logged at error meanwhile."""
    return None


def _box_not_made(session: AsyncSession, machine: CloudMachine, now: datetime) -> None:
    """A box that couldn't be made, by a failed result or a request that ran
    out: the machine goes to error, which the existing retry and clean-up
    handle, and isn't asked for again on every sweep. A retry asks again. It
    counts as a launch refused, which "launches failing" pages on, once per
    failure. It's no longer wanted running either, so the box scaler is never
    asked to start a box Core has given up on; the owner's Retry wants it
    running again (`CloudMachineStore.retry`). The caller holds the machine's
    lock."""
    # Counted first, under its own fixed word: the one failure is a launch
    # refused, never a `stop_failed` from the stop that follows.
    if machine.state != "error":
        record_machine_event(session, "failed", "launch_refused", machine.backend)
    machine.state = "error"
    machine.error_code = BOX_NOT_MADE
    machine.error = BOX_NOT_MADE_MESSAGE
    if machine.desired_state == "running":
        machine.desired_state = "stopped"
        bump_revision(machine, now)
    machine.updated_at = now


async def expire_provisions(session: AsyncSession, now: datetime) -> int:
    """Write `expired` for requests past their 15 minutes with no result, and
    mark each one's machine as not made if it's still waiting for its box.
    Returns how many. The caller commits."""
    rows = await session.execute(
        select(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.occurred_at <= now - TTL,
            ServerAuditEvent.occurred_at > now - TTL - timedelta(days=1),
        )
        # One order for every caller: Core's loop and the controller's poll
        # can both run this at once, and each takes the requests' advisory
        # locks, then their machines', in this order, so they can't deadlock.
        .order_by(ServerAuditEvent.id)
    )
    expired = 0
    for request in rows.scalars().all():
        await _advisory_lock(session, f"box-provision:{request.id}")
        if _result_of(await _linked(session, request.id)) is not None:
            continue
        machine_id = (request.details or {}).get("machine_id")
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=request.target_id,
            details={
                "phase": "result",
                "result": "expired",
                "linked_to": request.id,
                "machine_id": machine_id,
            },
        )
        expired += 1
        if kind_of(request) == "pool" and isinstance(machine_id, str):
            # A pool box never made in time retires, reapable.
            from switch_core.db.stores import hosted_pool_store

            await hosted_pool_store.retire(session, machine_id, "make_failed", now)
            continue
        # Nothing made the box in time: the machine is marked as not made,
        # as a failed result marks it, so its owner sees an error rather than
        # a start that never ends. Only a machine still waiting for its box:
        # one that has since come up, errored or gone is left as it is.
        if isinstance(machine_id, str):
            await lock_machine(session, machine_id)
            machine = await session.get(
                CloudMachine, machine_id, populate_existing=True
            )
            if machine is not None and machine.state in ("queued", "provisioning"):
                _box_not_made(session, machine, now)
    return expired


def held_clocks(machine_id: str, open_ids: Collection[str]) -> bool:
    return machine_id in open_ids


def box_provisioning_on(config: SwitchConfig) -> bool:
    """Whether box provisioning is on: the v1/v2 switch's one answer
    (`hosted_v2_on`). Read defensively: a hand-built test config, or an older caller, simply
    has it off."""
    from switch_core.hosted_v2 import hosted_v2_on

    return hosted_v2_on(config)


async def ask_for_box(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    machine_id: str,
    config: SwitchConfig,
    settings: HostedControllerSettings | None,
    now: datetime,
) -> str | Waiting | None:
    """`request_box_if_needed` when box provisioning is on for this server, with its caps
    and its gates.
    Off, it asks for nothing. On with no keyed-id key, no box can be named,
    so none is asked for and a box still waiting for one is marked as not
    made at once (`_box_not_made`), rather than waiting for ever."""
    if not box_provisioning_on(config) or settings is None:
        return None
    key = process_keyed_id_key()
    if key is None:
        logger.error(
            "Box provisioning is on, but there's no keyed-id key to name a box"
        )
        await _not_made_without_key(session_factory, machine_id, now)
        return None
    gate_settings = settings

    async def _gate(machine: CloudMachine) -> bool:
        return await box_allowed(session_factory, config, gate_settings, machine)

    asked = await request_box_if_needed(
        session_factory,
        machine_id=machine_id,
        key=key,
        now=now,
        per_minute=config.hosted_provisions_per_minute,
        ceiling=config.hosted_box_ceiling,
        allowed=_gate,
    )
    if asked is not None:
        await _cap_alerts(session_factory, asked, config, now)
    return asked


async def _not_made_without_key(
    session_factory: async_sessionmaker[AsyncSession], machine_id: str, now: datetime
) -> None:
    """With no keyed-id key, a box waiting for one is marked as not made, once:
    only a v2 box still wanted running and still queued or provisioning."""
    with no_tenant():
        async with session_factory() as session:
            await lock_machine(session, machine_id)
            machine = await session.get(
                CloudMachine, machine_id, populate_existing=True
            )
            if (
                machine is not None
                and machine.backend == "box"
                and machine.desired_state == "running"
                and machine.state in ("queued", "provisioning")
            ):
                _box_not_made(session, machine, now)
            await session.commit()


async def _cap_alerts(
    session_factory: async_sessionmaker[AsyncSession],
    asked: str,
    config: SwitchConfig,
    now: datetime,
) -> None:
    """A10: raise `box_cap_reached` for the cap a request waits on, and clear
    both once a request is written under them. After the claims lock is
    released, so a slow alert never holds up a claim; an alert that fails is
    logged and the request stands."""
    caps = {
        "rate": config.hosted_provisions_per_minute,
        "ceiling": config.hosted_box_ceiling,
    }
    if asked in caps:
        verdicts = [Verdict(Condition.BOX_CAP_REACHED, asked, True, caps[asked])]
    else:
        verdicts = [
            Verdict(Condition.BOX_CAP_REACHED, cap, False, number)
            for cap, number in caps.items()
        ]
    for verdict in verdicts:
        try:
            await apply_alert(session_factory, verdict, now)
        except Exception:
            logger.exception("The %s cap alert couldn't be updated", verdict.target_id)
