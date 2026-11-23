"""The hosted read views: the operator's overview and the admin's People data.

Operators get the Machines and Boxes tabs and "Show name"; a workspace admin
gets the People tab. Everything here is read-only apart from the audit entry a
name reveal writes.

What these routes never return (spec rules 2 and 3): a prompt, reply, message,
file, tool output, log text or secret, and, to an operator, a name or email
outside a reveal. Users and workspaces reach an operator as keyed ids only, and
every text field here is a fixed state or a pattern-checked id.
"""

from __future__ import annotations

import re
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import ServerAuditAction
from switch_core.db.models import (
    AgentController,
    AgentDefinition,
    CloudMachine,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import CloudMachineStore, workspace_on
from switch_core.db.tenant_lookup import tenants_of_cloud_machine
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_machines import (
    hosted_settings,
    machines_enabled,
    your_cloud,
)
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.tenant_context import current_tenant_id, no_tenant
from switch_core.visibility.alerts import overview_alerts
from switch_core.visibility.audit_log import (
    check_reason,
    record_operator_result,
)
from switch_core.visibility.box_provision import box_provisioning_on, boxes_made
from switch_core.visibility.cluster_report import latest_cluster_report
from switch_core.visibility.dependencies import get_keyed_id_key
from switch_core.visibility.guards import require_operator, require_workspace_admin
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from switch_core.visibility.operator_limits import (
    RATE_LIMITED,
    RETRY_AFTER_S,
    LimitBusy,
    Limits,
    limited_request,
    live_bulk_figures,
)
from switch_core.visibility.shared_cloud_agents import (
    overview_bucket,
    shared_cloud_agent,
)

operator_router = APIRouter()
admin_router = APIRouter()

# The report is from the last 30 s when the operator is healthy; past this the
# screen says how old it is.
REPORT_STALE_AFTER = timedelta(minutes=2)
# A1's memory band, of the box's own memory limit.
BAND_MEDIUM_FROM = 50.0
BAND_HIGH_ABOVE = 80.0
NODE_NAME = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")

BoxState = Literal[
    "running",
    "resting",
    "stopped",
    "paused",
    "starting",
    "stopping",
    "error",
    "retired",
]
MemoryBand = Literal["low", "medium", "high"]


def box_state(machine: CloudMachine) -> BoxState:
    """A box's state as the screens name it, from its lifecycle columns only."""
    if machine.state == "ready":
        return "running"
    if machine.state in ("queued", "provisioning"):
        return "starting"
    if machine.state == "stopping":
        return "stopping"
    if machine.state == "stopped":
        if machine.stop_reason == "idle":
            return "resting"
        # `stop_reason` can also be `paused` (an operator's pause).
        return "paused" if machine.stop_reason == "paused" else "stopped"
    if machine.state == "error":
        return "error"
    return "retired"


def memory_used_bytes(machine: CloudMachine) -> int | None:
    reading = (machine.heartbeat or {}).get("memory")
    if not isinstance(reading, dict):
        return None
    total, available = reading.get("total_bytes"), reading.get("available_bytes")
    if not isinstance(total, int) or not isinstance(available, int) or total <= 0:
        return None
    return max(0, min(total, total - available))


def memory_band(machine: CloudMachine) -> MemoryBand | None:
    """Low under 50% of the box's memory limit, medium 50-80%, high over 80%.
    None when the box isn't running or hasn't reported: shown as a dash."""
    if box_state(machine) != "running":
        return None
    used = memory_used_bytes(machine)
    if used is None:
        return None
    # memory_used_bytes has checked the reading's shape and its total.
    total = (machine.heartbeat or {})["memory"]["total_bytes"]
    pct = used * 100 / total
    if pct < BAND_MEDIUM_FROM:
        return "low"
    if pct > BAND_HIGH_ABOVE:
        return "high"
    return "medium"


def box_facts(machine: CloudMachine) -> dict:
    """The operator's facts about a box, under the one heartbeat key the views
    and the alerts share (`heartbeat["box"]`, written by the observation route)."""
    facts = (machine.heartbeat or {}).get("box")
    return facts if isinstance(facts, dict) else {}


def box_node(machine: CloudMachine) -> str | None:
    """The node the operator last saw the box on, when it reported one."""
    node = box_facts(machine).get("node")
    return node if isinstance(node, str) and NODE_NAME.match(node) else None


def restarts_today(machine: CloudMachine, now: datetime) -> int | None:
    """Restarts counted for today (UTC), from the operator's observations, as
    the observation route keeps them (`heartbeat["box"]`: `day` and
    `restarts_today`). None until the operator reports any."""
    facts = box_facts(machine)
    if "restarts_today" not in facts:
        return None
    if facts.get("day") != now.astimezone(UTC).date().isoformat():
        return 0
    count = facts.get("restarts_today")
    if isinstance(count, bool) or not isinstance(count, int):
        return None
    return count if 0 <= count <= 1_000_000 else None


async def _paused_users(factory: async_sessionmaker[AsyncSession]) -> set[str]:
    """Every user an operator has paused (the mark on the user), box or not."""
    with no_tenant():
        async with factory() as session:
            return set(
                await session.scalars(
                    select(User.id).where(User.hosted_paused_at.is_not(None))
                )
            )


async def _alerts(
    factory: async_sessionmaker[AsyncSession],
    now: datetime,
    key: KeyedIdKey,
    limits: Limits,
) -> list[dict]:
    """The overview's Alerts tab: open alerts and those cleared in the last
    day. Fixed titles and details from the alert templates, keyed ids and
    numbers only. A raised A11 shows its operator's current count."""
    with no_tenant():
        async with factory() as session:
            live = await live_bulk_figures(session, key, limits, now)
            return await overview_alerts(session, now, live_figures=live)


async def _live_boxes(factory: async_sessionmaker[AsyncSession]) -> list[CloudMachine]:
    with no_tenant():
        async with factory() as session:
            return list(
                await session.scalars(
                    select(CloudMachine)
                    .where(CloudMachine.state != "deleted")
                    .order_by(CloudMachine.created_at)
                )
            )


# --- the operator's overview: Console's existing `/shared-cloud/overview` contract --------------

# The per-person monthly cost range the overview shows beside its estimate,
# as the proposal costed it. Config-free on purpose: it's a
# label for the screen, not a bill.
COST_TARGET_LOW_USD = 12.0
COST_TARGET_HIGH_USD = 20.0
FAILED_PROCESSES = frozenset({"crashed", "failed"})


def agent_bucket(agent: dict, box: CloudMachine, *, owner_paused: bool = False) -> str:
    """One agent's state for the overview's counts. One mapping for the
    operators' overview and the person's own Console: the
    `shared_cloud_agent` card, counted by `overview_bucket`, so the two can
    never disagree. A paused owner's agents can't reply, whatever the box says:
    the pause lives on the user (`users.hosted_paused_at`), not the box."""
    if owner_paused:
        return "unavailable"
    card = shared_cloud_agent(
        str(agent.get("agent_id", "")), "running", agent, box, None
    )
    return overview_bucket(card)


class AgentCounts(BaseModel):
    working: int = 0
    idle: int = 0
    resting: int = 0
    unavailable: int = 0


class OverviewPerson(BaseModel):
    # To an operator: the user's keyed id, and no name (rule 3).
    user_id: str
    name: str | None
    agents: AgentCounts
    memory_bytes: int | None
    cost_month_usd: float | None
    kept_apart: Literal["pass", "fail", "unknown"]
    # Paused by an operator (the mark on the user, not the box's state).
    paused: bool = False


class OverviewCost(BaseModel):
    per_person_month_usd: float | None
    target_low_usd: float
    target_high_usd: float
    estimate: bool


class OverviewIsolation(BaseModel):
    result: Literal["pass", "fail", "unknown"]
    blocked: int
    total: int
    checked_at: str | None
    attempts: list[dict]


class OverviewMachine(BaseModel):
    """A node, as the existing contract names a machine, with the overview's fields."""

    name: str
    # The node's keyed id: what the Drain button sends. Operators only,
    # as the name is.
    machine: str
    instance_type: str
    kind: Literal["shared", "burst"]
    zone: str
    memory_used_pct: float | None
    memory_booked_pct: float | None
    gate: Literal["passed", "held", "failed"]
    held_minutes: int | None
    boxes: int
    # The existing contract's byte figures: the cluster report doesn't carry
    # them, so they're null rather than a made-up 0.
    memory_total_bytes: int | None = None
    memory_working_bytes: int | None = None
    memory_resting_bytes: int | None = None
    memory_system_bytes: int | None = None
    people: int
    room_for_people: int | None = None


class OverviewService(BaseModel):
    name: str
    ready: int
    wanted: int


class OverviewNodes(BaseModel):
    machines: list[OverviewMachine]
    services: list[OverviewService]
    report_at: str | None
    report_stale: bool


class AwakeCount(BaseModel):
    running: int
    max: int


class DiskUsage(BaseModel):
    total_bytes: int
    available_bytes: int
    # "workspace" (the agents' volume) or "unknown"; absent from older boxes.
    # The apps show a disk figure only for "workspace".
    scope: Literal["workspace", "unknown"] | None = None


class BoxCeiling(BaseModel):
    """Boxes made against the ceiling the provisioner refuses at (operators
    only): two integers, the same count as the ceiling check."""

    made: int
    ceiling: int


class OverviewBox(BaseModel):
    box: str
    user: str
    workspaces: list[str]
    state: BoxState
    node: str | None
    memory_used_bytes: int | None
    restarts_today: int | None
    # Capacity and times for the operator's Boxes page (read only, operators
    # only, as the rest of the overview). Each is null when the box hasn't said.
    memory_total_bytes: int | None = None
    # Sessions awake out of the box's limit, from its controllers' last reports.
    awake: AwakeCount | None = None
    # When the box last did work, last reported, and was last seen come up.
    active_at: str | None = None
    heartbeat_at: str | None = None
    running_observed_at: str | None = None
    # For a put-away box: when it goes for good. Null when not set.
    retain_until: str | None = None
    # The disk the box last reported, with which disk it is. Null when not
    # reported, out of shape, or 0 of 0 (a box that couldn't measure it).
    disk: DiskUsage | None = None


def _byte_count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def box_disk(machine: CloudMachine) -> DiskUsage | None:
    """The box's disk reading from its heartbeat, as the owner's panel reads
    it (`hosted_machines._usage`), but never raising on a reading out of shape."""
    reading = (machine.heartbeat or {}).get("disk")
    if not isinstance(reading, dict):
        return None
    total = _byte_count(reading.get("total_bytes"))
    available = _byte_count(reading.get("available_bytes"))
    if total is None or available is None or total == 0 or available > total:
        return None
    scope = reading.get("scope")
    return DiskUsage(
        total_bytes=total,
        available_bytes=available,
        scope=scope if scope in ("workspace", "unknown") else None,
    )


def memory_total_bytes(machine: CloudMachine) -> int | None:
    """The box's memory, from the same heartbeat reading as the used figure."""
    if memory_used_bytes(machine) is None:
        return None
    reading = (machine.heartbeat or {}).get("memory")
    total = reading.get("total_bytes") if isinstance(reading, dict) else None
    # Never a bool (a subclass of int) or a missing figure: null, not a 500.
    if isinstance(total, bool) or not isinstance(total, int) or total <= 0:
        return None
    return total


def box_awake(reports: list[dict], now: datetime) -> AwakeCount | None:
    """Sessions awake on the box out of its limit, from each workspace
    controller's last report (as the owner's Your cloud reads it): running
    added up, the limit the box's own. Null when no controller reports both."""
    counts = [
        figures
        for figures in (your_cloud(report, now)["awake"] for report in reports)
        if figures is not None
    ]
    if not counts:
        return None
    return AwakeCount(
        running=sum(c["running"] for c in counts), max=max(c["max"] for c in counts)
    )


async def _box_ceiling(
    factory: async_sessionmaker[AsyncSession], config: SwitchConfig
) -> BoxCeiling | None:
    """Boxes made against `hosted_box_ceiling`, or None while box provisioning
    is off and nothing enforces it."""
    ceiling = getattr(config, "hosted_box_ceiling", None)
    if not box_provisioning_on(config):
        return None
    if isinstance(ceiling, bool) or not isinstance(ceiling, int) or ceiling < 1:
        return None
    with no_tenant():
        async with factory() as session:
            return BoxCeiling(made=await boxes_made(session), ceiling=ceiling)


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


class Overview(BaseModel):
    viewer: Literal["operator"]
    # Null when box provisioning is off, since no ceiling is enforced then.
    box_ceiling: BoxCeiling | None = None
    people: list[OverviewPerson]
    room: Literal["plenty", "limited", "full", "unknown"]
    cost: OverviewCost
    isolation: OverviewIsolation
    alerts: list[dict]
    nodes: OverviewNodes
    boxes: list[OverviewBox]


async def _box_reports(
    factory: async_sessionmaker[AsyncSession], box: CloudMachine, tenants: list[str]
) -> list[dict]:
    """Each workspace controller's last report on the box, read with that
    workspace bound, since the box belongs to none of them."""
    found: list[dict] = []
    for tenant_id in tenants:
        async with tenant_session(factory, tenant_id) as session:
            here = await workspace_on(session, box.id)
            if here is None or here.controller_id is None:
                continue
            controller = await session.scalar(
                select(AgentController).where(AgentController.id == here.controller_id)
            )
            report = None if controller is None else controller.status
            if isinstance(report, dict):
                found.append(report)
    return found


def _report_agents(reports: list[dict]) -> list[dict]:
    """The agents the reports list, from every workspace controller on the box."""
    found: list[dict] = []
    for report in reports:
        agents = report.get("agents")
        if isinstance(agents, list):
            found.extend(a for a in agents if isinstance(a, dict))
    return found


@operator_router.get("/shared-cloud/overview")
async def shared_cloud_overview(
    _operator: Annotated[User, Depends(require_operator)],
    key: Annotated[KeyedIdKey, Depends(get_keyed_id_key)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    response: Response,
) -> Overview:
    """Console's Shared machines page, for Switch operators only.

    The existing contract, with users as keyed ids and no names (rule 3), the
    cluster report's nodes with used and booked memory, and every box. The
    contract's workspace-admin view stays parked: admins get 403, as Console
    already expects.
    """
    response.headers["Cache-Control"] = "no-store"
    now = datetime.now(UTC)
    boxes = await _live_boxes(factory)
    paused = await _paused_users(factory)
    people: list[OverviewPerson] = []
    box_rows: list[OverviewBox] = []
    for box in boxes:
        tenants = await tenants_of_cloud_machine(factory, box.id)
        counts = AgentCounts()
        owner_paused = box.owner_id in paused
        reports = await _box_reports(factory, box, tenants)
        for agent in _report_agents(reports):
            bucket = agent_bucket(agent, box, owner_paused=owner_paused)
            setattr(counts, bucket, getattr(counts, bucket) + 1)
        user_keyed = key.keyed_id(KeyedIdKind.USER, box.owner_id)
        people.append(
            OverviewPerson(
                user_id=user_keyed,
                name=None,
                agents=counts,
                memory_bytes=memory_used_bytes(box),
                cost_month_usd=None,
                kept_apart="unknown",
                paused=owner_paused,
            )
        )
        box_rows.append(
            OverviewBox(
                box=key.keyed_id(KeyedIdKind.BOX, box.id),
                user=user_keyed,
                workspaces=[key.keyed_id(KeyedIdKind.WORKSPACE, t) for t in tenants],
                state=box_state(box),
                node=box_node(box),
                memory_used_bytes=memory_used_bytes(box),
                restarts_today=restarts_today(box, now),
                memory_total_bytes=memory_total_bytes(box),
                awake=box_awake(reports, now),
                active_at=_iso(box.active_at),
                heartbeat_at=_iso(box.heartbeat_at),
                running_observed_at=_iso(box.running_observed_at),
                retain_until=_iso(box.retain_until),
                disk=box_disk(box),
            )
        )
    # A paused user may have no box at all: they're still listed, as paused.
    with_box = {box.owner_id for box in boxes}
    for user_id in sorted(paused - with_box):
        people.append(
            OverviewPerson(
                user_id=key.keyed_id(KeyedIdKind.USER, user_id),
                name=None,
                agents=AgentCounts(),
                memory_bytes=None,
                cost_month_usd=None,
                kept_apart="unknown",
                paused=True,
            )
        )
    held = latest_cluster_report()
    per_node = Counter(row.node for row in box_rows if row.node)
    nodes = OverviewNodes(
        machines=[]
        if held is None
        else [
            OverviewMachine(
                name=node.name,
                machine=key.keyed_id(KeyedIdKind.MACHINE, node.name),
                instance_type="",
                kind="shared",
                zone=node.zone,
                memory_used_pct=node.memory_used_pct,
                memory_booked_pct=node.memory_booked_pct,
                gate=node.gate,
                held_minutes=node.held_minutes,
                boxes=per_node.get(node.name, 0),
                people=per_node.get(node.name, 0),
            )
            for node in held.report.nodes
        ],
        services=[]
        if held is None
        else [
            OverviewService(name=s.name, ready=s.ready, wanted=s.wanted)
            for s in held.report.services
        ],
        report_at=None if held is None else held.received_at.isoformat(),
        report_stale=held is not None and now - held.received_at > REPORT_STALE_AFTER,
    )
    return Overview(
        viewer="operator",
        box_ceiling=await _box_ceiling(factory, config),
        people=people,
        room="unknown",
        cost=OverviewCost(
            per_person_month_usd=None,
            target_low_usd=COST_TARGET_LOW_USD,
            target_high_usd=COST_TARGET_HIGH_USD,
            estimate=True,
        ),
        isolation=OverviewIsolation(
            result="unknown", blocked=0, total=0, checked_at=None, attempts=[]
        ),
        alerts=await _alerts(factory, now, key, Limits.from_config(config)),
        nodes=nodes,
        boxes=box_rows,
    )


# --- "Show name" --------------------------------------------------------------------------------


# At most this many reveals per operator per
# hour, counted from the audit log itself so a restart can't reset it. The
# setting `visibility_operator_reveals_per_hour` holds it now, counted by the
# shared operator limits (`operator_limits`); this is its default.
REVEALS_PER_HOUR = 30
KEYED_ID_PATTERN = r"^k[0-9]{1,3}-[0-9a-f]{16}$"


class RevealRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["user", "workspace"]
    # A keyed id's shape only: anything else is a bad request (422), not a probe.
    keyed_id: str = Field(pattern=KEYED_ID_PATTERN)
    reason: str = Field(min_length=1, max_length=500)


class RevealAnswer(BaseModel):
    name: str
    email: str | None


async def _reveal_answer(
    factory: async_sessionmaker[AsyncSession], kind: KeyedIdKind, raw: str
) -> RevealAnswer | None:
    """The name behind one raw id, for "Show name".

    `users` holds no tenant and has no policy, so a person is read with nothing
    bound. `tenants` is compared on its own id, so a workspace is read with
    that workspace bound: with nothing bound, the runtime role reads no row.
    """
    if kind is KeyedIdKind.USER:
        with no_tenant():
            async with factory() as session:
                user = await session.get(User, raw)
                return (
                    None
                    if user is None
                    else RevealAnswer(name=user.name, email=user.email)
                )
    async with tenant_session(factory, raw) as session:
        tenant = await session.get(Tenant, raw)
        return None if tenant is None else RevealAnswer(name=tenant.name, email=None)


@operator_router.post("/shared-cloud/reveal")
async def operator_reveal(
    body: RevealRequest,
    operator: Annotated[User, Depends(require_operator)],
    key: Annotated[KeyedIdKey, Depends(get_keyed_id_key)],
    factory: Annotated[async_sessionmaker[AsyncSession], Depends(get_session_factory)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    response: Response,
) -> RevealAnswer:
    """A user's or workspace's name, for this one view, with a typed reason.

    Every call is audited before anything is looked up: a request entry, then
    its result, which is `done`, or `failed` with the step `not_found` or
    `rate_limited`. So probing for ids and bursts both show in the log. The
    answer is never cached. The keyed id is matched by recomputing keyed ids
    over the users and workspaces that have a box, never by reversing one; an
    id that matches none is a plain 404. Past the hourly limit an operator gets
    429 until the hour rolls on. The count and the request entry sit under one
    per-operator lock, so two reveals at once can't both take the last slot.
    """
    response.headers["Cache-Control"] = "no-store"
    try:
        check_reason(body.reason)
    except ValueError as exc:
        raise HTTPException(422, "A reason is required, up to 500 characters.") from exc
    now = datetime.now(UTC)
    limits = Limits.from_config(config)
    try:
        record, over_limit = await limited_request(
            factory,
            operator_id=operator.id,
            kind="reveal",
            limits=limits,
            now=now,
            action=ServerAuditAction.OPERATOR_NAME_REVEALED,
            target_type=body.kind,
            target_keyed_id=body.keyed_id,
            reason=body.reason,
        )
    except LimitBusy:
        raise HTTPException(
            503,
            "Too many requests at once. Try again in a minute.",
            headers={"Retry-After": "60"},
        ) from None
    if over_limit:
        await record_operator_result(
            factory, record, result="failed", step=RATE_LIMITED
        )
        raise HTTPException(
            429,
            f"At most {limits.reveals_per_hour} names an hour. Try again later.",
            headers={"Retry-After": str(RETRY_AFTER_S)},
        )
    kind = KeyedIdKind.USER if body.kind == "user" else KeyedIdKind.WORKSPACE
    boxes = await _live_boxes(factory)
    candidates: set[str] = set()
    if kind is KeyedIdKind.USER:
        candidates = {box.owner_id for box in boxes}
    else:
        for box in boxes:
            candidates.update(await tenants_of_cloud_machine(factory, box.id))
    raw = next((c for c in candidates if key.keyed_id(kind, c) == body.keyed_id), None)
    answer = None if raw is None else await _reveal_answer(factory, kind, raw)
    if answer is None:
        await record_operator_result(factory, record, result="failed", step="not_found")
        raise HTTPException(404, "Not found")
    await record_operator_result(factory, record, result="done")
    return answer


# --- the workspace admin's People tab -----------------------------------------------------------


class PersonRow(BaseModel):
    user_id: str
    name: str
    hosted: Literal["on", "off"]
    agents: int
    box_state: BoxState | None
    memory_band: MemoryBand | None
    last_active_at: str | None
    # An operator's pause wins over the admin's switch, read from
    # the mark on the user (`users.hosted_paused_at`), box or not.
    paused_by_switch: bool = False
    # Whether the admin's switch can do anything for this person: false when
    # the server's own allow-list doesn't admit them, so Console shows "Not
    # enabled by Switch" instead of a switch that changes nothing.
    switchable: bool = True


class PeopleView(BaseModel):
    people: list[PersonRow]
    # Whether the admin's per-person switch can be used:
    # `PUT /tenants/{t}/hosted-people/{user}` is served beside this read.
    switchable: bool = True


@admin_router.get("/tenants/{tenant_id}/hosted-people")
async def workspace_hosted_people(
    tenant_id: str,
    _admin: Annotated[User, Depends(require_workspace_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
    config: Annotated[SwitchConfig, Depends(get_config)],
    settings: Annotated[HostedControllerSettings | None, Depends(hosted_settings)],
    response: Response,
) -> PeopleView:
    """Who in this workspace has hosted agents: on or off, how many agents,
    their box's state, memory as a band and when it was last active. This
    workspace's people only, and counts and states only."""
    if current_tenant_id() != tenant_id:
        raise HTTPException(403, "Not authorized for this tenant")
    response.headers["Cache-Control"] = "no-store"
    members = list(
        await session.execute(
            select(User, TenantMember)
            .join(TenantMember, TenantMember.user_id == User.id)
            .where(TenantMember.tenant_id == tenant_id)
            .order_by(User.name)
        )
    )
    machines = CloudMachineStore()
    rows = []
    for user, membership in members:
        allowed = settings is not None and machines_enabled(config, settings, user.id)
        box = await machines.live_for_owner(session, user.id)
        here = None if box is None else await workspace_on(session, box.id)
        if not allowed and here is None:
            continue
        agents = 0
        if here is not None and here.controller_id is not None:
            agents = (
                await session.scalar(
                    select(func.count())
                    .select_from(AgentDefinition)
                    .where(
                        AgentDefinition.tenant_id == tenant_id,
                        AgentDefinition.owner_id == user.id,
                        AgentDefinition.controller_id == here.controller_id,
                    )
                )
            ) or 0
        shown = box if here is not None else None
        rows.append(
            PersonRow(
                user_id=user.id,
                name=user.name,
                # On only while the server allows it and the admin hasn't
                # turned this person off here (`hosted_enabled`).
                hosted="on" if allowed and membership.hosted_enabled else "off",
                agents=agents,
                box_state=None if shown is None else box_state(shown),
                memory_band=None if shown is None else memory_band(shown),
                last_active_at=None if shown is None else shown.active_at.isoformat(),
                paused_by_switch=user.hosted_paused_at is not None,
                switchable=allowed,
            )
        )
    return PeopleView(people=rows)
