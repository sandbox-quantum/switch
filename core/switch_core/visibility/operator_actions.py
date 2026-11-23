"""Operator actions the cluster carries out: the action record shared by Core
and the hosted operator (restart; drain uses the same record).


- **The record is the audit log, append-only.** A request is the
  `record_operator_request` entry; each step and the result are further
  entries linked to it (`record_operator_progress`, `record_operator_result`).
  An action is open while it has no result and hasn't expired.
- **The operator sees only ids and codes:** the action id, its kind, the
  Core machine id, its times and the last step. Never a reason, a person or
  free text. It finds the box's namespace in its own box map.
- **One at a time:** creating any operator action takes one shared advisory
  lock, so a second action on a box with one open is refused (409), naming
  when the first started and the operator's keyed id. Each step takes a lock
  per action, so only one `claimed` wins.
- **Expiry:** an action with no result by its `expires_at` gets `failed`
  with step `expired`, written the next time actions are listed or stepped,
  and by the start-up sweep.

Drain: a drain targets one node of the latest cluster report, by its
machine keyed id. Core checks it and records it; the operator does the work.
- **Found in a fresh report only** (Core's own receive time, at most 2
  minutes old), by recomputing every node's keyed id. The node's uid is fixed
  in the request entry, and a node with no uid is refused.
- **Refused under the create lock, writing nothing:** another drain open, a
  restart open on a box on the node, or no boxes on it. A restart on a box
  whose node has a drain open is refused too.
- **Through the limits as kind `drain`:** the hourly limits and A11, plus the
  daily drain cap (`operator_limits`).
- **Listed** with its node and uid, and hidden once the node has left the
  report or the name now has a different uid.
- **Steps** come in order, with `waiting_for_machine` and `moving` repeatable,
  and `counts` checked: `{moved, total}`, whole numbers, `0 <= moved <= total
  <= 200`, `moved` never going down, `total` fixed at the first `moving`, and
  `done` only with `moved == total`.
"""

from __future__ import annotations

import hmac
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import CloudMachine, ServerAuditEvent
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.tenant_context import no_tenant
from switch_core.visibility.audit_log import (
    OperatorActionRecord,
    TargetType,
    last_recorded_step,
    load_operator_request,
    record_operator_progress,
    record_operator_request,
    record_operator_result,
)
from switch_core.visibility.box_provision import open_provision_machines
from switch_core.visibility.cluster_report import ClusterNode, latest_cluster_report
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind, is_keyed_id
from switch_core.visibility.operator_limits import (
    RATE_LIMITED,
    Kind,
    Limits,
    limited_request,
)
from switch_core.visibility.read_views import box_node

#: How long an action may stay open before it's recorded as expired.
TTL = {"restart": timedelta(minutes=10)}
#: The audit action each kind is recorded under.
ACTIONS = {
    "restart": ServerAuditAction.HOSTED_BOX_RESTARTED,
    "drain": ServerAuditAction.HOSTED_MACHINE_DRAINED,
}
KIND_OF = {action.value: kind for kind, action in ACTIONS.items()}
#: Each kind's steps, in order, and its failure codes (codes only, checked
#: strictly). An action finishes with state `done` on its last step.
STEPS = {
    "restart": ("claimed", "pod_deleted", "box_ready"),
    "drain": ("claimed", "waiting_for_machine", "room_ok", "cordoned", "moving"),
}
FAILURES = {
    "restart": ("box_not_found", "delete_refused", "not_ready_in_time"),
    "drain": (
        "no_machine_in_time",
        "evict_refused",
        "box_not_ready",
        "stopped_partway",
        "node_replaced",
        # The drain worker refuses to drain the node it runs on (a condition
        # for running drain on the agents pool): it claims, then
        # reports this at once, with no cluster call between.
        "own_node",
        # The cordon was refused (a 403 or 422: a missing right or a policy
        # mismatch), told apart from a replaced machine.
        "cordon_refused",
    ),
}
#: The kinds whose failures are taken only after `claimed`, so a worker can't
#: end an action it never claimed and the first `claimed` wins. Restart keeps
#: its existing rule.
CLAIM_FIRST = ("drain",)
#: Which of a request's own details the operator also sees, per kind: ids and
#: codes only, never the reason or a person (box provisioning adds its own).
VIEW_EXTRA: dict[str, tuple[str, ...]] = {"restart": (), "drain": ()}
#: Drain's order: the step each one needs first, where that
#: isn't simply the one before it, and the steps that may repeat. A drain
#: never goes back to an earlier step.
NEEDS = {"drain": {"room_ok": "claimed"}}
REPEATS = {"drain": ("waiting_for_machine", "moving")}
#: The steps that must carry `counts`, and drain's limits on them. Drain's
#: other failures may carry them too, so the audit line says how far it got
#: no other step takes them.
COUNTED = {"drain": ("moving", "stopped_partway")}
COUNTS_OPTIONAL = {
    "drain": tuple(f for f in FAILURES["drain"] if f not in COUNTED["drain"])
}
MAX_BOXES = 200
#: A drain's window: room, then each box, capped.
DRAIN_ROOM = timedelta(minutes=15)
DRAIN_PER_BOX = timedelta(minutes=5)
DRAIN_MAX = timedelta(hours=4)
#: The oldest cluster report a drain may start from, by Core's receive time.
REPORT_FRESH = timedelta(minutes=2)
#: One lock over creating any operator action.
CREATE_LOCK = "switch.hosted_operator_actions"


class ActionRefused(Exception):
    """A request or step Core won't take, with the status for the route. With
    a `code`, the route answers `{code, message, **fields}` so the web picks
    its own words by code; `fields` are ids and
    times only."""

    def __init__(
        self,
        status: int,
        detail: str,
        code: str | None = None,
        fields: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code
        self.fields = fields or {}


@dataclass(frozen=True)
class OpenAction:
    action_id: str
    kind: str
    # A restart's box; None for a drain.
    machine_id: str | None
    requested_at: datetime
    expires_at: datetime
    step: str | None
    extra: dict[str, str] = field(default_factory=dict)
    # A drain's node, as the current report names it, and the uid fixed when
    # it was asked for; its latest counts once it's moving.
    node: str | None = None
    node_uid: str | None = None
    counts: tuple[int, int] | None = None


class RateLimited(Exception):
    """An action over an operator limit: `record` is its request entry, already
    marked `rate_limited`, and `code` the limit (`rate_limited`, or
    `drain_daily_cap`). The route records the result with that step and
    answers 429."""

    def __init__(self, record: OperatorActionRecord, code: str = RATE_LIMITED) -> None:
        super().__init__(code)
        self.record = record
        self.code = code


def _started(event: ServerAuditEvent, key: KeyedIdKey) -> dict[str, str]:
    """When an open action started and its operator's keyed id: what a 409
    names, never a person."""
    return {
        "started_at": event.occurred_at.isoformat(),
        "operator": key.keyed_id(KeyedIdKind.USER, event.actor_user_id)
        if event.actor_user_id
        else "unknown",
    }


def drain_window(boxes: int) -> timedelta:
    """15 minutes for room, 5 per box, at most 4 hours."""
    return min(DRAIN_ROOM + DRAIN_PER_BOX * boxes, DRAIN_MAX)


async def _lock(session: AsyncSession, key: str) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key}
    )


@dataclass
class OperatorActions:
    session_factory: async_sessionmaker[AsyncSession]
    key: KeyedIdKey
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))

    # ── Finding the box ──────────────────────────────────────────────────────

    async def _live_machines(self) -> list[CloudMachine]:
        with no_tenant():
            async with self.session_factory() as session:
                rows = (
                    await session.scalars(
                        select(CloudMachine).where(CloudMachine.state != "deleted")
                    )
                ).all()
                await session.commit()
        return list(rows)

    async def resolve_box(self, box_keyed_id: str) -> CloudMachine | None:
        """The live box whose keyed id this is, by recomputing every box's and
        comparing them all, never by reversing one."""
        if not is_keyed_id(box_keyed_id):
            return None
        found = None
        for machine in await self._live_machines():
            if hmac.compare_digest(
                self.key.keyed_id(KeyedIdKind.BOX, machine.id), box_keyed_id
            ):
                found = machine
        return found

    # ── Finding the node ────────────────────────────────────────────────

    def _node_by_keyed_id(
        self, nodes: list[ClusterNode], machine_keyed_id: str
    ) -> ClusterNode | None:
        """The node whose machine keyed id this is, by recomputing every
        node's and comparing them all, never by reversing one."""
        found = None
        for node in nodes:
            if hmac.compare_digest(
                self.key.keyed_id(KeyedIdKind.MACHINE, node.name), machine_keyed_id
            ):
                found = node
        return found

    def fresh_nodes(self) -> list[ClusterNode] | None:
        """The latest report's nodes, or None when there's no report or it's
        older than `REPORT_FRESH` by Core's own receive time, never a time the
        report claims."""
        held = latest_cluster_report()
        if held is None or self.now() - held.received_at > REPORT_FRESH:
            return None
        return list(held.report.nodes)

    def _boxes_on(
        self, machines: list[CloudMachine], node_name: str
    ) -> list[CloudMachine]:
        """The boxes the operator last saw on this node (its box facts)."""
        return [m for m in machines if box_node(m) == node_name]

    # ── The open actions ─────────────────────────────────────────────────────

    async def _requests(
        self, session: AsyncSession, kinds: list[str]
    ) -> list[ServerAuditEvent]:
        actions = [ACTIONS[k].value for k in kinds]
        return list(
            (
                await session.scalars(
                    select(ServerAuditEvent)
                    .where(
                        ServerAuditEvent.action.in_(actions),
                        ServerAuditEvent.details["phase"].astext == "requested",
                    )
                    .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
                )
            ).all()
        )

    async def _open(
        self, kinds: list[str]
    ) -> list[tuple[ServerAuditEvent, str | None, datetime]]:
        """Open requests as (entry, last step, expires at), expiring any past due."""
        now = self.now()
        open_: list[tuple[ServerAuditEvent, str | None, datetime]] = []
        due: list[tuple[str, str | None]] = []
        with no_tenant():
            async with self.session_factory() as session:
                for event in await self._requests(session, kinds):
                    last = await last_recorded_step(session, event.id)
                    if last is not None and last[0] == "result":
                        continue
                    step = last[1] if last is not None else None
                    expires = datetime.fromisoformat(
                        (event.details or {})["expires_at"]
                    )
                    if expires <= now:
                        due.append((event.id, step))
                    else:
                        open_.append((event, step, expires))
                await session.commit()
        for event_id, step in due:
            await self._expire(event_id, step)
        return open_

    async def _expire(self, event_id: str, step: str | None) -> None:
        request = await load_operator_request(self.session_factory, event_id, self.key)
        if request is not None:
            await record_operator_result(
                self.session_factory,
                request,
                result="failed",
                step="expired",
                extra={"reached": step} if step else None,
            )

    async def expire_due(self) -> None:
        """For the start-up sweep: record every action past its expiry."""
        await self._open(list(ACTIONS))

    async def open_actions(self, kind: str) -> list[OpenAction]:
        """What the operator may act on now, oldest first."""
        if kind not in ACTIONS:
            raise ActionRefused(422, "unknown kind")
        if kind == "drain":
            return await self._open_drains()
        by_box = {
            self.key.keyed_id(KeyedIdKind.BOX, m.id): m.id
            for m in await self._live_machines()
        }
        out = []
        for event, step, expires in await self._open([kind]):
            machine_id = by_box.get(event.target_id or "")
            if machine_id is None:
                continue  # the box is gone; the operator would only refuse it
            out.append(
                OpenAction(
                    action_id=event.id,
                    kind=kind,
                    machine_id=machine_id,
                    requested_at=event.occurred_at,
                    expires_at=expires,
                    step=step,
                    extra={
                        k: str(v)
                        for k, v in (event.details or {}).items()
                        if k in VIEW_EXTRA[kind]
                    },
                )
            )
        return out

    async def _open_drains(self) -> list[OpenAction]:
        """Open drains with their node resolved from the current report. One
        whose node has left the report, or whose node name now has a
        different uid, isn't listed, and expires."""
        # The latest report, fresh or not: a drain already asked for keeps
        # going through a late report, and the worker compares the live
        # node's uid before every step anyway, so a stale list can't send it
        # to the wrong machine.
        held = latest_cluster_report()
        nodes = list(held.report.nodes) if held is not None else []
        out = []
        for event, step, expires in await self._open(["drain"]):
            details = event.details or {}
            node = self._node_by_keyed_id(nodes, event.target_id or "")
            uid = details.get("node_uid")
            if node is None or not uid or node.uid != uid:
                continue
            with no_tenant():
                async with self.session_factory() as session:
                    counts = await self._last_counts(session, event.id)
                    await session.commit()
            out.append(
                OpenAction(
                    action_id=event.id,
                    kind="drain",
                    machine_id=None,
                    requested_at=event.occurred_at,
                    expires_at=expires,
                    step=step,
                    node=node.name,
                    node_uid=uid,
                    counts=counts,
                )
            )
        return out

    # ── Writing a request ────────────────────────────────────────────────────

    async def _write(
        self,
        limits: Limits | None,
        *,
        limit_kind: Kind,
        kind: str,
        actor_id: str,
        target_type: TargetType,
        target_keyed_id: str,
        reason: str,
        box_keyed_id: str | None = None,
        workspaces: list[tuple[str, str]] | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> OperatorActionRecord:
        """An action's request entry. With `limits`, through the operator
        limits' one helper (the count and the entry under its lock); over a
        limit that raises `RateLimited` with the entry it wrote and the
        limit's code."""
        if limits is None:
            return await record_operator_request(
                self.session_factory,
                actor_user_id=actor_id,
                action=ACTIONS[kind],
                target_type=target_type,
                target_keyed_id=target_keyed_id,
                reason=reason,
                workspaces=workspaces or [],
                box_keyed_id=box_keyed_id,
                extra=extra,
            )
        record, refusal = await limited_request(
            self.session_factory,
            operator_id=actor_id,
            kind=limit_kind,
            limits=limits,
            now=self.now(),
            action=ACTIONS[kind],
            target_type=target_type,
            target_keyed_id=target_keyed_id,
            reason=reason,
            workspaces=workspaces or [],
            box_keyed_id=box_keyed_id,
            extra=extra,
        )
        if refusal is not None:
            raise RateLimited(record, refusal)
        return record

    # ── Asking for a restart ─────────────────────────────────────────────────

    async def _write_request(
        self,
        limits: Limits | None,
        *,
        actor_id: str,
        box_keyed_id: str,
        reason: str,
        workspaces: list[tuple[str, str]] | None = None,
        extra: dict[str, str] | None = None,
    ) -> OperatorActionRecord:
        """The restart's request entry (see `_write`)."""
        return await self._write(
            limits,
            limit_kind="action",
            kind="restart",
            actor_id=actor_id,
            target_type="box",
            target_keyed_id=box_keyed_id,
            reason=reason,
            box_keyed_id=box_keyed_id,
            workspaces=workspaces,
            extra=extra,
        )

    async def request_restart(
        self,
        *,
        actor_id: str,
        box_keyed_id: str,
        reason: str,
        limits: Limits | None = None,
        resolved: tuple[CloudMachine | None] | None = None,
    ) -> OperatorActionRecord:
        """Record a restart for the operator to carry out. An id matching no
        live box is audited as failed (`not_found`) and refused 404; an open
        action on the box, or a box that isn't running, is refused 409 with
        nothing written.

        With `limits` (the route passes them), the request entry goes through
        the operator limits' helper, which holds the limit's lock for the
        count and the entry only. It's taken last, after the box checks, so a
        409 writes nothing and counts for nothing; over a limit, `RateLimited`
        carries the entry. `resolved` holds the box the caller already found,
        None inside for no box; it's re-read under the create lock anyway."""
        machine = (
            resolved[0]
            if resolved is not None
            else await self.resolve_box(box_keyed_id)
        )
        if machine is None:
            if is_keyed_id(box_keyed_id):
                request = await self._write_request(
                    limits, actor_id=actor_id, box_keyed_id=box_keyed_id, reason=reason
                )
                await record_operator_result(
                    self.session_factory, request, result="failed", step="not_found"
                )
            raise ActionRefused(404, "Not found")
        with no_tenant():
            async with self.session_factory() as session:
                # Held until this transaction ends: the check and the write
                # below are one step for every other creator.
                await _lock(session, CREATE_LOCK)
                open_now = [event for event, _s, _e in await self._open(list(ACTIONS))]
                for event in open_now:
                    if event.target_id == box_keyed_id:
                        actor = (
                            self.key.keyed_id(KeyedIdKind.USER, event.actor_user_id)
                            if event.actor_user_id
                            else "unknown"
                        )
                        raise ActionRefused(
                            409,
                            f"Another action is running on this box: started "
                            f"{event.occurred_at.isoformat()} by operator {actor}.",
                        )
                current = await session.get(
                    CloudMachine, machine.id, populate_existing=True
                )
                # A drain open on the box's node refuses the restart too,
                # matched by the node's keyed id, never a stored name.
                node = box_node(current) if current is not None else None
                if node is not None:
                    node_keyed = self.key.keyed_id(KeyedIdKind.MACHINE, node)
                    for event in open_now:
                        if KIND_OF.get(event.action) == "drain" and hmac.compare_digest(
                            event.target_id or "", node_keyed
                        ):
                            raise ActionRefused(
                                409,
                                "A drain is running on this box's machine.",
                                code="drain_open",
                                fields=_started(event, self.key),
                            )
                if current is None or current.desired_state != "running":
                    raise ActionRefused(
                        409, "This box isn't running, so there's nothing to restart."
                    )
                # A box still being made (queued or provisioning)
                # or in error has no pod to restart yet.
                if current.state != "ready":
                    raise ActionRefused(
                        409, "This box isn't ready yet, so there's nothing to restart."
                    )
                # A provision still open on the box: it's being made or
                # remade, whatever its state reads.
                if current.id in await open_provision_machines(session, self.now()):
                    raise ActionRefused(
                        409,
                        "This box is still being made, so there's nothing to restart.",
                    )
                workspaces = [
                    (tenant, self.key.keyed_id(KeyedIdKind.WORKSPACE, tenant))
                    for tenant in sorted(
                        await tenants_of_cloud_machine(self.session_factory, machine.id)
                    )
                ]
                request = await self._write_request(
                    limits,
                    actor_id=actor_id,
                    box_keyed_id=box_keyed_id,
                    reason=reason,
                    workspaces=workspaces,
                    extra={
                        "kind": "restart",
                        "expires_at": (self.now() + TTL["restart"]).isoformat(),
                    },
                )
                await session.commit()
        return request

    # ── Asking for a drain ──────────────────────────────────────────────

    async def request_drain(
        self,
        *,
        actor_id: str,
        machine_keyed_id: str,
        reason: str,
        limits: Limits | None = None,
    ) -> OperatorActionRecord:
        """Record a drain of one node for the operator to carry out.

        - No report, or one older than 2 minutes by Core's receive time: 409
          `report_stale`, nothing written.
        - An id matching no node in it: the request is written through the
          limits and gets `failed` / `not_found`, then 404, as for restart.
          It counts towards the hourly limits and A11 but not the daily
          drain cap (`not_found` mark), so a mistyped id can't use that up.
        - A node with no uid: 409 `node_uid_missing`, nothing written. Its
          drain could never be pinned to the machine that was chosen.
        - Under the create lock, writing nothing: 409 `drain_open` (any drain
          open), `restart_open` (a restart open on a box on the node), or
          `no_boxes`.
        - Otherwise the request entry, through the limits as kind `drain`,
          with the node's uid, the box count and the window. Over a limit,
          `RateLimited` with its code."""
        nodes = self.fresh_nodes()
        if nodes is None:
            raise ActionRefused(
                409,
                "The machine list isn't current. Try again in a minute.",
                code="report_stale",
            )
        node = self._node_by_keyed_id(nodes, machine_keyed_id)
        if node is None:
            if is_keyed_id(machine_keyed_id):
                request = await self._write(
                    limits,
                    limit_kind="action",
                    kind="drain",
                    actor_id=actor_id,
                    target_type="machine",
                    target_keyed_id=machine_keyed_id,
                    reason=reason,
                    extra={"kind": "drain", "not_found": True},
                )
                await record_operator_result(
                    self.session_factory, request, result="failed", step="not_found"
                )
            raise ActionRefused(404, "Not found")
        if not node.uid:
            raise ActionRefused(
                409,
                "This machine can't be drained until the operator reports its uid.",
                code="node_uid_missing",
            )
        with no_tenant():
            async with self.session_factory() as session:
                # Held until this transaction ends: the checks and the write
                # below are one step for every other creator.
                await _lock(session, CREATE_LOCK)
                machines = await self._live_machines()
                on_node = self._boxes_on(machines, node.name)
                on_node_keyed = {
                    self.key.keyed_id(KeyedIdKind.BOX, m.id) for m in on_node
                }
                for event, _step, _expires in await self._open(list(ACTIONS)):
                    if KIND_OF.get(event.action) == "drain":
                        raise ActionRefused(
                            409,
                            "Another drain is running.",
                            code="drain_open",
                            fields=_started(event, self.key),
                        )
                    if event.target_id in on_node_keyed:
                        raise ActionRefused(
                            409,
                            "A restart is running on a box on this machine.",
                            code="restart_open",
                            fields=_started(event, self.key),
                        )
                if not on_node:
                    raise ActionRefused(
                        409,
                        "There's nothing on this machine to move.",
                        code="no_boxes",
                    )
                # One copy per workspace, from the union over the node's boxes.
                tenants: set[str] = set()
                for machine in on_node:
                    tenants |= set(
                        await tenants_of_cloud_machine(self.session_factory, machine.id)
                    )
                workspaces = [
                    (tenant, self.key.keyed_id(KeyedIdKind.WORKSPACE, tenant))
                    for tenant in sorted(tenants)
                ]
                request = await self._write(
                    limits,
                    limit_kind="drain",
                    kind="drain",
                    actor_id=actor_id,
                    target_type="machine",
                    target_keyed_id=machine_keyed_id,
                    reason=reason,
                    workspaces=workspaces,
                    extra={
                        "kind": "drain",
                        "boxes": len(on_node),
                        "node_uid": node.uid,
                        "expires_at": (
                            self.now() + drain_window(len(on_node))
                        ).isoformat(),
                    },
                )
                await session.commit()
        return request

    # ── The operator's steps ─────────────────────────────────────────────────

    async def step(
        self,
        action_id: str,
        step: str,
        state: str,
        counts: tuple[int, int] | None = None,
    ) -> None:
        """Record a step the operator reports. Codes only; the first `claimed`
        wins; nothing after the result or after expiry. A drain's steps come
        in order and carry `counts` (moved, total) where its design says."""
        if state not in ("running", "done", "failed"):
            raise ActionRefused(422, "unknown state")
        with no_tenant():
            async with self.session_factory() as session:
                await _lock(session, f"switch.hosted_action:{action_id}")
                event = await session.get(ServerAuditEvent, action_id)
                if event is None or (event.details or {}).get("phase") != "requested":
                    raise ActionRefused(404, "Not found")
                kind = KIND_OF.get(event.action)
                if kind is None:
                    raise ActionRefused(404, "Not found")
                steps, failures = STEPS[kind], FAILURES[kind]
                if state == "failed" and step not in steps + failures:
                    raise ActionRefused(422, "unknown step")
                if state != "failed" and step not in steps:
                    raise ActionRefused(422, "unknown step")
                done_steps = await self._steps_of(session, action_id)
                if done_steps.get("result"):
                    raise ActionRefused(409, "This action has ended.")
                expires = datetime.fromisoformat((event.details or {})["expires_at"])
                if expires <= self.now():
                    await session.commit()
                    await self._expire(action_id, done_steps.get("last"))
                    raise ActionRefused(409, "This action has expired.")
                reached = done_steps["seen"]
                if step == "claimed" and "claimed" in reached and state != "failed":
                    raise ActionRefused(409, "This action is already claimed.")
                if step in steps and state != "failed":
                    self._check_order(kind, steps, step, reached)
                if (
                    state == "failed"
                    and kind in CLAIM_FIRST
                    and "claimed" not in reached
                ):
                    raise ActionRefused(409, "This action isn't claimed yet.")
                if state == "done" and step != steps[-1]:
                    raise ActionRefused(
                        409, f"Only {steps[-1]} can finish this action."
                    )
                await self._check_counts(session, kind, action_id, step, state, counts)
                await session.commit()
        request = await load_operator_request(self.session_factory, action_id, self.key)
        if request is None:
            raise ActionRefused(404, "Not found")
        numbers = {"moved": counts[0], "total": counts[1]} if counts else {}
        if state == "running":
            await record_operator_progress(
                self.session_factory, request, step=step, extra=numbers or None
            )
        elif state == "done":
            await record_operator_progress(
                self.session_factory, request, step=step, extra=numbers or None
            )
            await record_operator_result(self.session_factory, request, result="done")
        else:
            # A drain's failure names the step it reached, and its counts
            # where it has them.
            reached_extra: dict[str, str | int] = {}
            if kind == "drain":
                if done_steps.get("last"):
                    reached_extra["reached"] = done_steps["last"]
                reached_extra.update(numbers)
            await record_operator_result(
                self.session_factory,
                request,
                result="failed",
                step=step,
                extra=reached_extra or None,
            )

    @staticmethod
    def _check_order(
        kind: str, steps: tuple[str, ...], step: str, reached: list[str]
    ) -> None:
        position = steps.index(step)
        needs = NEEDS.get(kind, {}).get(
            step, steps[position - 1] if position > 0 else None
        )
        if needs is not None and needs not in reached:
            raise ActionRefused(409, "Steps must come in order.")
        if kind not in REPEATS:
            return
        # A drain never goes back, and repeats only the steps that may.
        if any(steps.index(s) > position for s in reached if s in steps):
            raise ActionRefused(409, "Steps must come in order.")
        if step in reached and step not in REPEATS[kind]:
            raise ActionRefused(409, "This step was already reported.")

    async def _check_counts(
        self,
        session: AsyncSession,
        kind: str,
        action_id: str,
        step: str,
        state: str,
        counts: tuple[int, int] | None,
    ) -> None:
        required = step in COUNTED.get(kind, ())
        optional = state == "failed" and step in COUNTS_OPTIONAL.get(kind, ())
        if counts is None:
            if required:
                raise ActionRefused(422, "counts are required on this step")
            return
        if not (required or optional):
            raise ActionRefused(422, "counts aren't taken on this step")
        moved, total = counts
        if not (0 <= moved <= total <= MAX_BOXES):
            raise ActionRefused(422, "counts are out of range")
        last = await self._last_counts(session, action_id)
        if last is not None:
            if total != last[1]:
                raise ActionRefused(409, "total is fixed at the first moving step")
            if moved < last[0]:
                raise ActionRefused(409, "moved can't go down")
        if state == "done" and moved != total:
            raise ActionRefused(409, "A drain is done only when every box has moved.")

    async def _last_counts(
        self, session: AsyncSession, action_id: str
    ) -> tuple[int, int] | None:
        """The latest (moved, total) a drain reported, if any."""
        rows = (
            await session.scalars(
                select(ServerAuditEvent.details)
                .where(
                    ServerAuditEvent.details["linked_to"].astext == action_id,
                    ServerAuditEvent.details["phase"].astext == "progress",
                    ServerAuditEvent.details.has_key("total"),
                )
                .order_by(
                    ServerAuditEvent.occurred_at.desc(), ServerAuditEvent.id.desc()
                )
                .limit(1)
            )
        ).all()
        if not rows:
            return None
        return int(rows[0]["moved"]), int(rows[0]["total"])

    async def _steps_of(self, session: AsyncSession, action_id: str) -> dict:
        rows = (
            await session.scalars(
                select(ServerAuditEvent.details)
                .where(ServerAuditEvent.details["linked_to"].astext == action_id)
                .order_by(ServerAuditEvent.occurred_at, ServerAuditEvent.id)
            )
        ).all()
        seen = [r.get("step") for r in rows if r.get("phase") == "progress"]
        return {
            "seen": seen,
            "last": seen[-1] if seen else None,
            "result": any(r.get("phase") == "result" for r in rows),
        }
