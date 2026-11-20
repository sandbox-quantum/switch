"""The visibility audit log, on Core's existing audit tables.

Two tables, each read by one audience, so no read path has to filter rows the
reader mustn't see:

- `server_audit_events` is the **operators'** log. Every operator action, every
  name reveal, every operator grant and removal, and a server-wide copy of each
  workspace admin change land here, with users, workspaces and boxes as keyed
  ids only.
- `audit_events` is each **workspace's** log, read by its admins through the
  existing route and its row-level security. An admin change lands here, and
  so does a copy of each operator action on that workspace's people, with no
  actor id and `actor_kind: "operator"`, so it reads as "Switch operator".

Both tables are append-only for the runtime role. A result is never written
over its request: it is a second entry whose `details.linked_to` names the
first. The request is committed before the action starts, so an action that
crashes partway still has its record, and the result says how far it got.

The typed reason is kept exactly as written, up to 500 characters. It is
refused, not cut, when longer, so what's stored is always what was typed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import (
    AuditAction,
    ServerAuditAction,
    record_audit_event,
    record_server_audit_event,
)
from switch_core.db.models import AuditEvent, ServerAuditEvent
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.tenant_context import no_tenant
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind, is_keyed_id

REASON_MAX = 500

Result = Literal["done", "failed"]
TargetType = Literal["user", "box", "machine", "workspace"]

# Keys the writer sets itself; a caller's extra details can't replace them.
_RESERVED = frozenset(
    {
        "phase",
        "reason",
        "result",
        "step",
        "linked_to",
        "workspace",
        "workspaces",
        "box",
        "actor_kind",
        "action",
        "server_event_id",
        "has_reason",
    }
)
_EXTRA_MAX_KEYS = 10
# A user's box serves at most a handful of workspaces; this only bounds input.
MAX_WORKSPACE_COPIES = 50
_EXTRA_MAX_STR = 200


class AuditInputError(ValueError):
    """A reason, id or detail the log won't take."""


@dataclass(frozen=True)
class OperatorActionRecord:
    """What `record_operator_request` wrote, to link the result to it."""

    event_id: str
    actor_user_id: str
    action: ServerAuditAction
    target_type: TargetType
    target_keyed_id: str
    workspace_id: str | None
    workspace_keyed_id: str | None
    box_keyed_id: str | None
    workspace_event_id: str | None
    # One (workspace id, its keyed id, the copy's event id) per workspace that
    # got a copy. `workspace_*` above are the first of these, kept for callers
    # that name one workspace.
    workspace_copies: tuple[tuple[str, str, str], ...] = ()


def check_reason(reason: str) -> str:
    if not isinstance(reason, str) or not reason.strip():
        raise AuditInputError("a reason is required")
    if len(reason) > REASON_MAX:
        raise AuditInputError(f"the reason is longer than {REASON_MAX} characters")
    return reason


def _check_keyed(label: str, value: str | None, *, required: bool) -> None:
    if value is None:
        if required:
            raise AuditInputError(f"{label} is required")
        return
    if not is_keyed_id(value):
        raise AuditInputError(f"{label} must be a keyed id, never a raw id or name")


def _check_extra(extra: Mapping[str, Any] | None) -> dict[str, Any]:
    """Small, flat, and only numbers, flags, keyed ids and short codes."""
    if not extra:
        return {}
    if len(extra) > _EXTRA_MAX_KEYS:
        raise AuditInputError("too many details")
    out: dict[str, Any] = {}
    for key, value in extra.items():
        if key in _RESERVED:
            raise AuditInputError(f"{key!r} is set by the audit writer")
        if isinstance(value, bool | int | float) or value is None:
            out[key] = value
        elif isinstance(value, str) and len(value) <= _EXTRA_MAX_STR:
            out[key] = value
        else:
            raise AuditInputError(f"detail {key!r} must be a short value")
    return out


def _workspace_targets(
    workspace_id: str | None,
    workspace_keyed_id: str | None,
    workspaces: Sequence[tuple[str, str]],
) -> list[tuple[str, str]]:
    _check_keyed(
        "workspace_keyed_id", workspace_keyed_id, required=workspace_id is not None
    )
    targets = list(workspaces)
    if workspace_id is not None:
        assert workspace_keyed_id is not None
        targets.insert(0, (workspace_id, workspace_keyed_id))
    if len(targets) > MAX_WORKSPACE_COPIES:
        raise AuditInputError("too many workspaces")
    seen: set[str] = set()
    for raw, keyed in targets:
        if not raw:
            raise AuditInputError("a workspace id is required")
        _check_keyed("workspace keyed id", keyed, required=True)
        if raw in seen:
            raise AuditInputError("a workspace is named twice")
        seen.add(raw)
    return targets


def _workspace_details(targets: Sequence[tuple[str, str]]) -> dict[str, Any]:
    if not targets:
        return {}
    if len(targets) == 1:
        return {"workspace": targets[0][1]}
    return {"workspaces": [keyed for _, keyed in targets]}


async def record_operator_request(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    actor_user_id: str,
    action: ServerAuditAction,
    target_type: TargetType,
    target_keyed_id: str,
    reason: str,
    workspace_id: str | None = None,
    workspace_keyed_id: str | None = None,
    workspaces: Sequence[tuple[str, str]] = (),
    box_keyed_id: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> OperatorActionRecord:
    """Record an operator action before it runs, and commit it.

    Each affected workspace gets its own copy for its admins: name one with
    `workspace_id` and `workspace_keyed_id`, or several with `workspaces` as
    `(workspace id, keyed id)` pairs, for an action on a person who is in more
    than one (a pause is user-wide). Each copy is written in its own
    transaction, bound to that workspace, after the operator's entry commits.
    """
    check_reason(reason)
    _check_keyed("target_keyed_id", target_keyed_id, required=True)
    _check_keyed("box_keyed_id", box_keyed_id, required=False)
    targets = _workspace_targets(workspace_id, workspace_keyed_id, workspaces)
    details = {
        "phase": "requested",
        "reason": reason,
        **_workspace_details(targets),
        **({"box": box_keyed_id} if box_keyed_id else {}),
        **_check_extra(extra),
    }
    with no_tenant():
        async with session_factory() as session:
            event = await record_server_audit_event(
                session,
                actor_user_id=actor_user_id,
                action=action,
                target_type=target_type,
                target_id=target_keyed_id,
                details=details,
            )
            event_id = event.id
            await session.commit()
    copies: list[tuple[str, str, str]] = []
    for raw, keyed in targets:
        copy_id = await _workspace_copy(
            session_factory,
            workspace_id=raw,
            action=action,
            target_type=target_type,
            target_keyed_id=target_keyed_id,
            # The operator's reason stays in the operators' log. The workspace
            # sees "Switch operator" and the action, never the reason.
            details={"phase": "requested", "has_reason": True},
            server_event_id=event_id,
        )
        copies.append((raw, keyed, copy_id))
    first = copies[0] if copies else None
    return OperatorActionRecord(
        event_id=event_id,
        actor_user_id=actor_user_id,
        action=action,
        target_type=target_type,
        target_keyed_id=target_keyed_id,
        workspace_id=first[0] if first else None,
        workspace_keyed_id=first[1] if first else None,
        box_keyed_id=box_keyed_id,
        workspace_event_id=first[2] if first else None,
        workspace_copies=tuple(copies),
    )


def _copies(request: OperatorActionRecord) -> tuple[tuple[str, str, str], ...]:
    """The request's workspace copies, including a record built by hand with
    only the single-workspace fields."""
    if request.workspace_copies:
        return request.workspace_copies
    if (
        request.workspace_id is not None
        and request.workspace_keyed_id is not None
        and request.workspace_event_id is not None
    ):
        return (
            (
                request.workspace_id,
                request.workspace_keyed_id,
                request.workspace_event_id,
            ),
        )
    return ()


async def record_operator_result(
    session_factory: async_sessionmaker[AsyncSession],
    request: OperatorActionRecord,
    *,
    result: Result,
    step: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> str:
    """Record how an operator action ended, as a second entry linked to its
    request. `step` says how far a failed action got."""
    if result not in ("done", "failed"):
        raise AuditInputError("result must be done or failed")
    if step is not None and (not step or len(step) > _EXTRA_MAX_STR):
        raise AuditInputError("step must be a short code")
    details = {
        "phase": "result",
        "result": result,
        "linked_to": request.event_id,
        **({"step": step} if step else {}),
        **_workspace_details([(raw, keyed) for raw, keyed, _ in _copies(request)]),
        **({"box": request.box_keyed_id} if request.box_keyed_id else {}),
        **_check_extra(extra),
    }
    with no_tenant():
        async with session_factory() as session:
            event = await record_server_audit_event(
                session,
                actor_user_id=request.actor_user_id,
                action=request.action,
                target_type=request.target_type,
                target_id=request.target_keyed_id,
                details=details,
            )
            event_id = event.id
            await session.commit()
    for raw, _keyed, copy_id in _copies(request):
        await _workspace_copy(
            session_factory,
            workspace_id=raw,
            action=request.action,
            target_type=request.target_type,
            target_keyed_id=request.target_keyed_id,
            details={
                "phase": "result",
                "result": result,
                "linked_to": copy_id,
                **({"step": step} if step else {}),
            },
            server_event_id=event_id,
        )
    return event_id


async def load_operator_request(
    session_factory: async_sessionmaker[AsyncSession],
    event_id: str,
    key: KeyedIdKey,
) -> OperatorActionRecord | None:
    """Rebuild the record of a request already in the log, so a result can be
    written for it later (the start-up sweep ends half-done actions).

    The operators' entry names its workspaces by keyed id only, so each is
    matched back to a workspace by hashing every workspace's id with `key`,
    and that workspace's copy is found by its `server_event_id`. A workspace
    that no longer exists, or whose id was hashed under an older key, is left
    out: the result still reaches the operators' log. None when `event_id` is
    not a request.
    """
    with no_tenant():
        async with session_factory() as session:
            event = await session.get(ServerAuditEvent, event_id)
            await session.commit()
    if event is None or (event.details or {}).get("phase") != "requested":
        return None
    details = event.details or {}
    keyed: list[str] = (
        [details["workspace"]]
        if isinstance(details.get("workspace"), str)
        else [w for w in details.get("workspaces") or [] if isinstance(w, str)]
    )
    copies: list[tuple[str, str, str]] = []
    if keyed:
        by_keyed = {
            key.keyed_id(KeyedIdKind.WORKSPACE, tenant_id): tenant_id
            for tenant_id in await all_tenant_ids(session_factory)
        }
        for workspace_keyed in keyed:
            tenant_id = by_keyed.get(workspace_keyed)
            if tenant_id is None:
                continue
            async with tenant_session(session_factory, tenant_id) as session:
                copy_id = (
                    await session.execute(
                        select(AuditEvent.id)
                        .where(
                            AuditEvent.tenant_id == tenant_id,
                            AuditEvent.details["server_event_id"].astext == event_id,
                            AuditEvent.details["phase"].astext == "requested",
                        )
                        .limit(1)
                    )
                ).scalar_one_or_none()
                await session.commit()
            if copy_id is not None:
                copies.append((tenant_id, workspace_keyed, copy_id))
    first = copies[0] if copies else None
    return OperatorActionRecord(
        event_id=event.id,
        actor_user_id=event.actor_user_id or "",
        action=ServerAuditAction(event.action),
        target_type=event.target_type,  # type: ignore[arg-type]
        target_keyed_id=event.target_id or "",
        workspace_id=first[0] if first else None,
        workspace_keyed_id=first[1] if first else None,
        box_keyed_id=details.get("box")
        if isinstance(details.get("box"), str)
        else None,
        workspace_event_id=first[2] if first else None,
        workspace_copies=tuple(copies),
    )


async def record_operator_progress(
    session_factory: async_sessionmaker[AsyncSession],
    request: OperatorActionRecord,
    *,
    step: str,
    extra: Mapping[str, Any] | None = None,
) -> str:
    """Record that a multi-step operator action (restart, drain) reached
    `step`, as its own entry linked to the request, committed at once.

    The operators' log only: a workspace's admins see the request and the
    result, not each step. After a crash, `last_recorded_step` says where to
    resume, or the result is written as failed at that step; never done.
    """
    if not step or len(step) > _EXTRA_MAX_STR:
        raise AuditInputError("step must be a short code")
    details = {
        "phase": "progress",
        "step": step,
        "linked_to": request.event_id,
        **({"box": request.box_keyed_id} if request.box_keyed_id else {}),
        **_check_extra(extra),
    }
    with no_tenant():
        async with session_factory() as session:
            event = await record_server_audit_event(
                session,
                actor_user_id=request.actor_user_id,
                action=request.action,
                target_type=request.target_type,
                target_id=request.target_keyed_id,
                details=details,
            )
            event_id = event.id
            await session.commit()
    return event_id


async def last_recorded_step(
    session: AsyncSession, request_event_id: str
) -> tuple[str, str | None] | None:
    """The latest entry linked to a request, as (phase, step): `("result",
    step)` if the action has ended, `("progress", step)` if it was part-way,
    or None if nothing follows the request yet."""
    row = (
        await session.execute(
            select(ServerAuditEvent.details)
            .where(ServerAuditEvent.details["linked_to"].astext == request_event_id)
            .order_by(ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    return str(row.get("phase")), row.get("step")


async def _workspace_copy(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    workspace_id: str,
    action: ServerAuditAction,
    target_type: TargetType,
    target_keyed_id: str,
    details: dict[str, Any],
    server_event_id: str,
) -> str:
    async with tenant_session(session_factory, workspace_id) as session:
        event = await record_audit_event(
            session,
            tenant_id=workspace_id,
            actor_user_id=None,
            action=AuditAction.HOSTED_OPERATOR_ACTION,
            target_type=target_type,
            target_id=target_keyed_id,
            details={
                **details,
                "actor_kind": "operator",
                "action": action.value,
                "server_event_id": server_event_id,
            },
        )
        event_id = event.id
        await session.commit()
    return event_id


async def record_admin_change(
    session: AsyncSession,
    *,
    workspace_id: str,
    workspace_keyed_id: str,
    actor_user_id: str,
    actor_keyed_id: str,
    action: AuditAction,
    target_keyed_id: str,
    result: Result,
    linked_to: str | None = None,
    reason: str | None = None,
    extra: Mapping[str, Any] | None = None,
) -> str:
    """Record a workspace admin's change (A2) in the caller's transaction, so
    it commits or rolls back with the change, and add the operators' copy.

    The caller's session must be bound to `workspace_id`. The operators' copy
    has no tenant, so it lands in the same transaction: both tables accept a
    write from a session bound to a workspace (the server table has no policy).

    `reason`, when given, is kept as typed in the **workspace's entry only**.
    An admin's reason may name the person, and operators see ids only, so the
    operators' copy records just `has_reason: true`.
    """
    _check_keyed("workspace_keyed_id", workspace_keyed_id, required=True)
    _check_keyed("actor_keyed_id", actor_keyed_id, required=True)
    _check_keyed("target_keyed_id", target_keyed_id, required=True)
    if result not in ("done", "failed"):
        raise AuditInputError("result must be done or failed")
    if reason is not None:
        check_reason(reason)
    details = {
        "result": result,
        **({"linked_to": linked_to} if linked_to else {}),
        **_check_extra(extra),
    }
    event = await record_audit_event(
        session,
        tenant_id=workspace_id,
        actor_user_id=actor_user_id,
        action=action,
        target_type="user",
        target_id=target_keyed_id,
        details={**details, **({"reason": reason} if reason is not None else {})},
    )
    await record_server_audit_event(
        session,
        actor_user_id=actor_keyed_id,
        action=ServerAuditAction.HOSTED_ADMIN_CHANGE,
        target_type="user",
        target_id=target_keyed_id,
        details={
            **details,
            "action": action.value,
            "workspace": workspace_keyed_id,
            "actor_kind": "workspace_admin",
            **({"has_reason": True} if reason is not None else {}),
        },
    )
    return event.id


async def recorded_operators(session: AsyncSession) -> frozenset[str]:
    """The operator list as the log last recorded it: grants minus removals,
    in order."""
    rows = await session.execute(
        select(ServerAuditEvent.action, ServerAuditEvent.target_id)
        .where(
            ServerAuditEvent.action.in_(
                [ServerAuditAction.OPERATOR_GRANTED, ServerAuditAction.OPERATOR_REMOVED]
            )
        )
        .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
    )
    ids: set[str] = set()
    for action, target_id in rows.all():
        if target_id is None:
            continue
        if action == ServerAuditAction.OPERATOR_GRANTED:
            ids.add(target_id)
        else:
            ids.discard(target_id)
    return frozenset(ids)


async def record_operator_list(
    session_factory: async_sessionmaker[AsyncSession], current: frozenset[str]
) -> tuple[frozenset[str], frozenset[str]]:
    """Log each grant and removal since the list was last recorded.

    The list is a file, so no signed-in person made the change: entries carry
    no actor and `details.source = "config_file"`. Operators are
    named by user id here, because who holds the role is what this entry is
    for, and only operators read this log. Returns (granted, removed).
    """
    with no_tenant():
        async with session_factory() as session:
            before = await recorded_operators(session)
            granted = current - before
            removed = before - current
            for user_id, action in [
                *((u, ServerAuditAction.OPERATOR_GRANTED) for u in sorted(granted)),
                *((u, ServerAuditAction.OPERATOR_REMOVED) for u in sorted(removed)),
            ]:
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=action,
                    target_type="operator",
                    target_id=user_id,
                    details={"source": "config_file"},
                )
            await session.commit()
    return granted, removed
