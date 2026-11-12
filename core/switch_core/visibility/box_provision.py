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

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import CloudMachine, ServerAuditEvent
from switch_core.db.stores.hosted_machine_store import (
    _advisory_lock,
    ever_hosted,
    lock_claims,
    lock_machine,
    workspaces_on,
)
from switch_core.providers.hosted import HostedControllerSettings, tenant_allowed
from switch_core.tenant_context import no_tenant
from switch_core.visibility.alerts import Condition, Verdict, apply_alert
from switch_core.visibility.dependencies import process_keyed_id_key
from switch_core.visibility.hosted_access import block_reason
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

logger = logging.getLogger(__name__)

ACTION = ServerAuditAction.HOSTED_BOX_PROVISION.value
TTL = timedelta(minutes=15)
LEASE = timedelta(seconds=120)
NAMESPACE_PREFIX = "agents-user-"
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
    user_keyed_id: str
    size: str | None
    lease_seconds: int
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


def _result_of(linked: list[ServerAuditEvent]) -> str | None:
    for entry in linked:
        if (entry.details or {}).get("phase") == "result":
            return str((entry.details or {}).get("result"))
    return None


def _expires_at(request: ServerAuditEvent) -> datetime:
    return request.occurred_at + TTL


async def _revived_at(session: AsyncSession, machine_id: str) -> datetime | None:
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


async def _cap_reached(
    session: AsyncSession, *, now: datetime, per_minute: int, ceiling: int
) -> Waiting | None:
    recent = await session.scalar(
        select(func.count())
        .select_from(ServerAuditEvent)
        .where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.occurred_at > now - timedelta(minutes=1),
        )
    )
    if (recent or 0) >= per_minute:
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
    if (
        settings.allowed_user_ids is not None
        and machine.owner_id not in settings.allowed_user_ids
    ):
        return False
    for workspace in await workspaces_on(factory, machine.id):
        if not tenant_allowed(settings.allowed_tenant_ids, workspace.tenant_id):
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
            revived = await _revived_at(session, machine.id)
            if revived is None and ever_hosted(workspaces):
                # Run before, by hand or by an earlier provision, and never cleaned
                # up and revived: it has its box.
                await session.commit()
                return None
            box_keyed = key.keyed_id(KeyedIdKind.BOX, machine.id)
            if await _box_state(session, box_keyed, now, revived) != "none":
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
) -> ClaimedProvision | None:
    """The oldest open provision whose lease is free, claimed for `LEASE`.

    One claim at a time under its own lock. An expired request is never
    handed out, and one whose lease has passed with no result can be claimed
    again, since the provisioner's steps are safe to repeat. The caller commits.
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
        if is_blocked is not None and await is_blocked(machine_id):
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
            },
        )
        return ClaimedProvision(
            action_id=request.id,
            machine_id=machine_id,
            user_keyed_id=str(details.get("user")),
            size=details.get("size") if isinstance(details.get("size"), str) else None,
            lease_seconds=int(LEASE.total_seconds()),
            claim_token=token,
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
    if result == "failed" and failed_at not in FAILED_AT:
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
    claims = [
        (e.details or {}).get("claim")
        for e in linked
        if (e.details or {}).get("step") == "claimed"
    ]
    if not claims or not hmac.compare_digest(str(claims[-1]), _token_hash(claim_token)):
        raise ProvisionRefused(409, "This isn't the provision's current claim.")
    if now >= _expires_at(request):
        raise ProvisionRefused(409, "This provision has expired.")
    details = request.details or {}
    if namespace != namespace_for(str(details.get("user"))):
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
    if isinstance(machine_id, str):
        await lock_machine(session, machine_id)
        machine = await session.get(CloudMachine, machine_id, populate_existing=True)
        if machine is not None and result == "done":
            # The start clocks run from the box's existence, not the claim.
            machine.updated_at = now
        elif machine is not None and machine.state != "deleted":
            # A box that couldn't be made isn't asked for again on every sweep:
            # the machine goes to error, which the existing retry
            # and clean-up handle. A retry asks again.
            machine.state = "error"
            machine.error_code = BOX_NOT_MADE
            machine.error = BOX_NOT_MADE_MESSAGE
            machine.updated_at = now


async def expire_provisions(session: AsyncSession, now: datetime) -> int:
    """Write `expired` for requests past their 15 minutes with no result.
    Returns how many. The caller commits."""
    rows = await session.execute(
        select(ServerAuditEvent).where(
            ServerAuditEvent.action == ACTION,
            ServerAuditEvent.details["phase"].astext == "requested",
            ServerAuditEvent.occurred_at <= now - TTL,
            ServerAuditEvent.occurred_at > now - TTL - timedelta(days=1),
        )
    )
    expired = 0
    for request in rows.scalars().all():
        await _advisory_lock(session, f"box-provision:{request.id}")
        if _result_of(await _linked(session, request.id)) is not None:
            continue
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
                "machine_id": (request.details or {}).get("machine_id"),
            },
        )
        expired += 1
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
    Off, or with no keyed-id key, it asks for nothing: boxes are made by hand
    as before, and the user's machine waits as it does today."""
    if not box_provisioning_on(config) or settings is None:
        return None
    key = process_keyed_id_key()
    if key is None:
        logger.error(
            "Box provisioning is on, but there's no keyed-id key to name a box"
        )
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
