"""The operator overview's read views through their routes, on a real database: who may call
each one, that operators never get names, emails or raw ids, that "Show name"
is audited every time, the admin's People tab, and isolation (a second user in the
same workspace sees nothing of the first's box)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import (
    AgentController,
    ServerAuditEvent,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
    get_user_store,
)
from switch_core.gateway.hosted_machines import router as machines_router
from switch_core.tenant_context import no_tenant
from switch_core.visibility import cluster_report
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind, is_keyed_id
from switch_core.visibility.operator_limits import DEFAULTS as LIMIT_DEFAULTS
from switch_core.visibility.operators import OperatorList
from switch_core.visibility.read_views import (
    REVEALS_PER_HOUR,
    admin_router,
    operator_router,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    ControllerApp,
    controller_app,
    enrolled,
    update_machine,
)

KEY = KeyedIdKey(b"k" * 32, "k1")
# A planted marker and a dummy secret: they must never reach an operator or an
# admin through these routes (the method for every "can't see" check).
MARKER = "zebra-marker-7f3c"
DUMMY_SECRET = "sk-ant-api03-DUMMYDUMMYDUMMYDUMMY0123456789"
GIB = 1024**3


@dataclass
class Views:
    client: httpx.AsyncClient
    app: FastAPI
    base: ControllerApp
    users: dict[str, User]

    def as_(self, who: str) -> None:
        self.app.state.current = self.users[who]


async def _user(session, name: str, email: str, role: str = "user") -> User:
    user = User(name=name, email=email, role=role, password_hash="x")
    session.add(user)
    await session.flush()
    return user


@pytest.fixture
async def views(controller_app, tmp_path):  # noqa: F811
    base = controller_app
    async with base.factory() as session:
        owner = await session.get(User, base.owner_id)
        assert owner is not None
        # The box's owner carries the marker in their name: an operator must never see it.
        owner.name = f"Sam {MARKER}"
        second = await _user(session, "Alex Example", "alex@example.com")
        admin = await _user(session, "Robin Admin", "robin@example.com")
        # Operators are Core's list only: the operator here is a
        # plain user on the list, and the deployment admin is role "admin" off the list.
        operator = await _user(session, "Op Erator", "op@example.com")
        deployment_admin = await _user(
            session, "Dee Admin", "dee@example.com", role="admin"
        )
        for user, role in ((second, "member"), (admin, "admin")):
            session.add(
                TenantMember(tenant_id=require_tenant_id(), user_id=user.id, role=role)
            )
        await session.commit()
        users = {
            "owner": owner,
            "second": second,
            "admin": admin,
            "operator": operator,
            "deployment_admin": deployment_admin,
        }
    operators_file = tmp_path / "operators.json"
    operators_file.write_text(json.dumps({"operators": [operator.id]}))
    operators_file.chmod(0o600)
    app = FastAPI()
    app.state.hosted_controller_settings = base.settings
    app.state.keyed_id_key = KEY
    app.state.operator_list = OperatorList(operators_file)
    app.include_router(operator_router)
    app.include_router(admin_router)
    app.include_router(machines_router)

    async def session_dep():
        async with base.factory() as opened:
            yield opened

    async def current_user():
        return app.state.current

    app.dependency_overrides[get_session] = session_dep
    app.dependency_overrides[get_session_factory] = lambda: base.factory
    # The reveal reads the operator limits from config (rate limit v1.1+): give
    # the stand-in their defaults beside the controller app's own settings.
    config = SimpleNamespace(**{**vars(base.config), **LIMIT_DEFAULTS})
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_current_user] = current_user
    # Its own store, so the admin check never reads the shared dependency state
    # another test may have left behind.
    app.dependency_overrides[get_user_store] = UserStore
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        result = Views(client=client, app=app, base=base, users=users)
        result.as_("operator")
        yield result
    cluster_report.forget_cluster_report()


async def _running(
    base: ControllerApp, used_pct: float, node: str | None = "ip-10-0-0-1"
) -> None:
    total = 4 * GIB
    box: dict = {
        "day": datetime.now(UTC).date().isoformat(),
        "restarts_today": 2,
    }
    if node:
        box["node"] = node
    heartbeat = {
        "disk": {"total_bytes": 100, "available_bytes": 50},
        "memory": {
            "total_bytes": total,
            "available_bytes": int(total * (1 - used_pct / 100)),
        },
        "controllers": {},
        "note": f"{MARKER} {DUMMY_SECRET}",  # free text a box could carry: never echoed
        "box": box,
    }
    await update_machine(
        base.factory, base.machine_id, state="ready", heartbeat=heartbeat
    )


async def _report_agents(
    base: ControllerApp, controller_id: str, agents: list[dict]
) -> None:
    """The controller's last status report, as Core keeps it."""
    async with base.factory() as session:
        controller = await session.scalar(
            select(AgentController).where(AgentController.id == controller_id)
        )
        assert controller is not None
        controller.status = {"agents": agents, "note": f"{MARKER} {DUMMY_SECRET}"}
        await session.commit()


def _never_leaks(text: str, *forbidden: str) -> None:
    for value in (MARKER, DUMMY_SECRET, *forbidden):
        assert value not in text, value


OVERVIEW = "/shared-cloud/overview"


# --- roles --------------------------------------------------------------------------------------


@pytest.mark.parametrize("who", ["owner", "second", "admin", "deployment_admin"])
async def test_only_operators_open_the_overview_and_reveal(views, who) -> None:
    views.as_(who)
    assert (await views.client.get(OVERVIEW)).status_code == 403
    reveal = await views.client.post(
        "/shared-cloud/reveal",
        json={"kind": "user", "keyed_id": "k1-0000000000000000", "reason": "x"},
    )
    assert reveal.status_code == 403


async def test_without_a_keyed_id_key_the_overview_answers_503(views) -> None:
    views.app.state.keyed_id_key = None
    assert (await views.client.get(OVERVIEW)).status_code == 503


# --- the overview: people and boxes -------------------------------------------------------------


async def test_the_overview_shows_keyed_ids_with_no_names_emails_or_raw_ids(
    views,
) -> None:
    controller_id, agent_ids = await enrolled(views.base, agents=3)
    await _running(views.base, used_pct=40)
    await _report_agents(
        views.base,
        controller_id,
        [
            {"agent_id": agent_ids[0], "process": "running", "session": "active"},
            {"agent_id": agent_ids[1], "process": "running", "session": "parked"},
            {"agent_id": agent_ids[2], "process": "crashed", "reason": "start_failed"},
        ],
    )
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    assert answer.headers["cache-control"] == "no-store"
    body = answer.json()
    assert body["viewer"] == "operator"
    (person,) = body["people"]
    assert person["user_id"] == KEY.keyed_id(KeyedIdKind.USER, views.base.owner_id)
    assert person["name"] is None
    assert person["agents"] == {"working": 0, "idle": 1, "resting": 1, "unavailable": 1}
    (row,) = body["boxes"]
    assert row["box"] == KEY.keyed_id(KeyedIdKind.BOX, views.base.machine_id)
    assert row["user"] == person["user_id"]
    assert row["workspaces"] == [
        KEY.keyed_id(KeyedIdKind.WORKSPACE, require_tenant_id())
    ]
    assert all(is_keyed_id(v) for v in (row["box"], row["user"], *row["workspaces"]))
    assert (row["state"], row["node"], row["restarts_today"]) == (
        "running",
        "ip-10-0-0-1",
        2,
    )
    owner = views.users["owner"]
    _never_leaks(
        answer.text,
        owner.name,
        owner.email,
        views.base.owner_id,
        views.base.machine_id,
        require_tenant_id(),
        controller_id,
        *agent_ids,
    )


# --- the overview: each box's capacity and times ----------------------------------------------


async def test_the_overview_shows_each_box_s_memory_awake_count_and_times(
    views,
) -> None:
    controller_id, agent_ids = await enrolled(views.base, agents=1)
    await _running(views.base, used_pct=25)
    seen = datetime(2026, 11, 6, 9, 0, tzinfo=UTC)
    await update_machine(
        views.base.factory,
        views.base.machine_id,
        active_at=seen,
        heartbeat_at=seen + timedelta(minutes=5),
        running_observed_at=seen - timedelta(hours=1),
    )
    async with views.base.factory() as session:
        controller = await session.scalar(
            select(AgentController).where(AgentController.id == controller_id)
        )
        assert controller is not None
        controller.status = {
            "agents": [{"agent_id": agent_ids[0], "process": "running"}],
            "machine": {"sessions_running": 3, "sessions_max": 12},
            "note": f"{MARKER} {DUMMY_SECRET}",
        }
        await session.commit()
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    (row,) = answer.json()["boxes"]
    assert row["memory_total_bytes"] == 4 * GIB
    assert row["memory_used_bytes"] == GIB
    assert row["awake"] == {"running": 3, "max": 12}
    assert row["active_at"] == seen.isoformat()
    assert row["heartbeat_at"] == (seen + timedelta(minutes=5)).isoformat()
    assert row["running_observed_at"] == (seen - timedelta(hours=1)).isoformat()
    # `_running`'s heartbeat has a disk reading with no scope: an older box.
    assert row["disk"] == {"total_bytes": 100, "available_bytes": 50, "scope": None}
    _never_leaks(answer.text, controller_id, *agent_ids)


async def test_a_box_that_has_not_reported_shows_no_capacity(views) -> None:
    await enrolled(views.base, agents=0)
    await update_machine(views.base.factory, views.base.machine_id, heartbeat=None)
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    (row,) = answer.json()["boxes"]
    assert (row["memory_used_bytes"], row["memory_total_bytes"], row["awake"]) == (
        None,
        None,
        None,
    )
    assert row["heartbeat_at"] is None


async def test_a_put_away_box_shows_when_it_goes_for_good(views) -> None:
    await enrolled(views.base, agents=0)
    until = datetime(2026, 11, 20, 0, 0, tzinfo=UTC)
    await update_machine(
        views.base.factory,
        views.base.machine_id,
        state="retained",
        desired_state="retained",
        retain_until=until,
    )
    (row,) = (await views.client.get(OVERVIEW)).json()["boxes"]
    assert (row["state"], row["retain_until"]) == ("retired", until.isoformat())


async def test_a_current_box_has_no_kept_until_date(views) -> None:
    await enrolled(views.base, agents=0)
    await _running(views.base, used_pct=25)
    (row,) = (await views.client.get(OVERVIEW)).json()["boxes"]
    assert row["retain_until"] is None


@pytest.mark.parametrize("who", ["owner", "second", "admin", "deployment_admin"])
async def test_members_never_see_a_box_s_capacity(views, who) -> None:
    await enrolled(views.base, agents=0)
    await _running(views.base, used_pct=25)
    views.as_(who)
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 403
    assert "memory_total_bytes" not in answer.text
    assert "awake" not in answer.text


# --- the overview: boxes made against the ceiling ---------------------------------------------


def _config(views):
    return views.app.dependency_overrides[get_config]()


async def _provision_event(views, machine_id: str, **details) -> None:
    with no_tenant():
        async with views.base.factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.HOSTED_BOX_PROVISION,
                target_type="box",
                target_id=KEY.keyed_id(KeyedIdKind.BOX, machine_id),
                details={"machine_id": machine_id, **details},
            )
            await session.commit()


async def test_the_overview_counts_boxes_made_against_the_ceiling(views) -> None:
    """The provisioner's own count: a box made and not deleted. A request that
    hasn't finished, or one that failed, doesn't count."""
    await enrolled(views.base, agents=0)
    config = _config(views)
    config.hosted_box_provisioning = True
    config.hosted_box_ceiling = 20
    await _provision_event(views, views.base.machine_id, phase="requested")
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    assert answer.json()["box_ceiling"] == {"made": 0, "ceiling": 20}
    await _provision_event(
        views, views.base.machine_id, phase="result", result="failed"
    )
    assert (await views.client.get(OVERVIEW)).json()["box_ceiling"] == {
        "made": 0,
        "ceiling": 20,
    }
    await _provision_event(views, views.base.machine_id, phase="result", result="done")
    assert (await views.client.get(OVERVIEW)).json()["box_ceiling"] == {
        "made": 1,
        "ceiling": 20,
    }
    # A deleted box no longer counts, as the provisioner sees it.
    await update_machine(views.base.factory, views.base.machine_id, state="deleted")
    assert (await views.client.get(OVERVIEW)).json()["box_ceiling"] == {
        "made": 0,
        "ceiling": 20,
    }


async def test_with_box_provisioning_off_there_is_no_ceiling(views) -> None:
    await enrolled(views.base, agents=0)
    config = _config(views)
    config.hosted_box_provisioning = False
    config.hosted_box_ceiling = 20
    await _provision_event(views, views.base.machine_id, phase="result", result="done")
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    assert answer.json()["box_ceiling"] is None


@pytest.mark.parametrize("who", ["owner", "second", "admin", "deployment_admin"])
async def test_members_never_see_the_ceiling(views, who) -> None:
    await enrolled(views.base, agents=0)
    config = _config(views)
    config.hosted_box_provisioning = True
    config.hosted_box_ceiling = 20
    views.as_(who)
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 403
    assert "box_ceiling" not in answer.text
    assert "ceiling" not in answer.text


# --- the overview: nodes from the cluster report ------------------------------------------------


async def test_the_overview_says_when_there_is_no_cluster_report_yet(views) -> None:
    cluster_report.forget_cluster_report()
    nodes = (await views.client.get(OVERVIEW)).json()["nodes"]
    assert nodes == {
        "machines": [],
        "services": [],
        "report_at": None,
        "report_stale": False,
    }


async def test_the_overview_shows_used_and_booked_with_boxes_per_node_and_staleness(
    views,
) -> None:
    await _running(views.base, used_pct=40, node="ip-10-0-0-1")
    report = cluster_report.ClusterReport.model_validate(
        {
            "nodes": [
                {
                    "name": "ip-10-0-0-1",
                    "zone": "eu-west-3a",
                    "memory_used_pct": 86.0,
                    "memory_booked_pct": 84.0,
                    "gate": "passed",
                },
                {
                    "name": "ip-10-0-0-2",
                    "zone": "eu-west-3b",
                    "gate": "held",
                    "held_minutes": 12,
                },
            ],
            "services": [{"name": "squid", "ready": 1, "wanted": 1}],
        }
    )
    cluster_report.keep_cluster_report(
        report, now=datetime.now(UTC) - timedelta(minutes=5)
    )
    nodes = (await views.client.get(OVERVIEW)).json()["nodes"]
    assert nodes["report_stale"] is True
    first, second = nodes["machines"]
    assert (first["memory_used_pct"], first["memory_booked_pct"], first["boxes"]) == (
        86.0,
        84.0,
        1,
    )
    assert first["memory_total_bytes"] is None  # not in the report: null, never 0
    # Each node carries its keyed id for the Drain button, never its uid.
    assert first["machine"] == KEY.keyed_id(KeyedIdKind.MACHINE, "ip-10-0-0-1")
    assert "uid" not in first
    assert (
        second["gate"],
        second["held_minutes"],
        second["boxes"],
        second["memory_used_pct"],
    ) == ("held", 12, 0, None)
    cluster_report.keep_cluster_report(report)
    assert (await views.client.get(OVERVIEW)).json()["nodes"]["report_stale"] is False


# --- Show name ----------------------------------------------------------------------------------


async def _audit_rows(base: ControllerApp) -> list[ServerAuditEvent]:
    with no_tenant():
        async with base.factory() as session:
            return list(
                await session.scalars(
                    select(ServerAuditEvent).where(
                        ServerAuditEvent.action == "operator.name_revealed"
                    )
                )
            )


async def test_show_name_needs_a_reason(views) -> None:
    keyed = KEY.keyed_id(KeyedIdKind.USER, views.base.owner_id)
    for reason in ("", "x" * 501):
        answer = await views.client.post(
            "/shared-cloud/reveal",
            json={"kind": "user", "keyed_id": keyed, "reason": reason},
        )
        assert answer.status_code == 422
    assert await _audit_rows(views.base) == []


async def test_a_malformed_id_is_a_bad_request_and_writes_nothing(views) -> None:
    for keyed in ("not-a-keyed-id", "k1-SHORT", ""):
        answer = await views.client.post(
            "/shared-cloud/reveal",
            json={"kind": "user", "keyed_id": keyed, "reason": "check"},
        )
        assert answer.status_code == 422
    assert await _audit_rows(views.base) == []


async def test_an_unknown_id_is_a_plain_404_and_is_audited_as_not_found(views) -> None:
    keyed = "k1-0123456789abcdef"
    answer = await views.client.post(
        "/shared-cloud/reveal",
        json={"kind": "user", "keyed_id": keyed, "reason": "check"},
    )
    assert answer.status_code == 404
    assert answer.json() == {"detail": "Not found"}
    rows = await _audit_rows(views.base)
    phases = sorted((row.details or {}).get("phase") for row in rows)
    assert phases == ["requested", "result"]
    (result,) = [row for row in rows if (row.details or {}).get("phase") == "result"]
    assert (result.details["result"], result.details["step"]) == ("failed", "not_found")
    assert all(row.target_id == keyed for row in rows)


async def test_reveals_are_capped_per_operator_per_hour(views) -> None:
    keyed = KEY.keyed_id(KeyedIdKind.USER, views.base.owner_id)
    body = {"kind": "user", "keyed_id": keyed, "reason": "Matching alerts"}
    for _ in range(REVEALS_PER_HOUR):
        assert (
            await views.client.post("/shared-cloud/reveal", json=body)
        ).status_code == 200
    refused = await views.client.post("/shared-cloud/reveal", json=body)
    assert refused.status_code == 429
    assert "names an hour" in refused.json()["detail"]
    results = [
        row
        for row in await _audit_rows(views.base)
        if (row.details or {}).get("phase") == "result"
    ]
    assert len(results) == REVEALS_PER_HOUR + 1
    assert sum(1 for row in results if row.details.get("step") == "rate_limited") == 1


async def test_each_reveal_is_audited_and_never_cached(views) -> None:
    keyed = KEY.keyed_id(KeyedIdKind.USER, views.base.owner_id)
    for _ in range(2):
        answer = await views.client.post(
            "/shared-cloud/reveal",
            json={
                "kind": "user",
                "keyed_id": keyed,
                "reason": "Matching alert to a person",
            },
        )
        assert answer.status_code == 200, answer.text
        assert answer.headers["cache-control"] == "no-store"
        assert answer.json() == {
            "name": views.users["owner"].name,
            "email": "owner@example.com",
        }
    rows = await _audit_rows(views.base)
    # Two reveals, each a request and its result.
    assert len(rows) == 4
    for row in rows:
        assert row.action == "operator.name_revealed"
        assert row.target_id == keyed
        assert row.actor_user_id == views.users["operator"].id
        assert "owner@example.com" not in str(row.details)
        assert MARKER not in str(row.details)


async def test_a_workspace_name_can_be_revealed_too(views) -> None:
    keyed = KEY.keyed_id(KeyedIdKind.WORKSPACE, require_tenant_id())
    answer = await views.client.post(
        "/shared-cloud/reveal",
        json={"kind": "workspace", "keyed_id": keyed, "reason": "check"},
    )
    assert answer.status_code == 200, answer.text
    assert answer.json()["email"] is None


# --- the admin's People tab ---------------------------------------------------------------------


async def test_the_admin_sees_their_people_with_a_memory_band_and_no_content(
    views,
) -> None:
    await enrolled(views.base, agents=2)
    await _running(views.base, used_pct=85)
    views.as_("admin")
    answer = await views.client.get(f"/tenants/{require_tenant_id()}/hosted-people")
    assert answer.status_code == 200, answer.text
    people = {row["user_id"]: row for row in answer.json()["people"]}
    owner_row = people[views.base.owner_id]
    assert (
        owner_row["hosted"],
        owner_row["agents"],
        owner_row["box_state"],
        owner_row["memory_band"],
    ) == ("on", 2, "running", "high")
    assert "memory_used_bytes" not in owner_row
    _never_leaks(answer.text.replace(views.users["owner"].name, ""))


@pytest.mark.parametrize("who", ["owner", "second"])
async def test_a_plain_member_cant_open_the_people_tab(views, who) -> None:
    views.as_(who)
    answer = await views.client.get(f"/tenants/{require_tenant_id()}/hosted-people")
    assert answer.status_code == 403


async def test_naming_another_workspace_in_the_path_is_refused(views) -> None:
    views.as_("admin")
    answer = await views.client.get("/tenants/some-other-workspace/hosted-people")
    assert answer.status_code == 403


# --- Isolation: a user sees only their own -------------------------------------------------------------


async def test_a_second_user_in_the_same_workspace_sees_nothing_of_the_first_box(
    views,
) -> None:
    await enrolled(views.base, agents=1)
    await _running(views.base, used_pct=40)
    views.as_("second")
    listed = await views.client.get("/hosted-machines")
    assert listed.status_code == 200
    assert listed.json()["machines"] == []
    single = await views.client.get(f"/hosted-machines/{views.base.machine_id}")
    assert single.status_code == 404
    for text in (listed.text, single.text):
        _never_leaks(text, views.base.machine_id, views.users["owner"].email)


async def test_the_new_routes_carry_nothing_from_a_box_free_text(views) -> None:
    """The heartbeat's free text (planted marker and dummy secret) reaches no answer."""
    await enrolled(views.base, agents=1)
    await _running(views.base, used_pct=60)
    for who, route in (
        ("operator", OVERVIEW),
        ("admin", f"/tenants/{require_tenant_id()}/hosted-people"),
    ):
        views.as_(who)
        answer = await views.client.get(route)
        assert answer.status_code == 200, (route, answer.text)
        _never_leaks(
            answer.text.replace(views.users["owner"].name, "")
            if who == "admin"
            else answer.text
        )


# --- Pause marks: the pause lives on the user, the switch on the membership ----------------------


async def _pause(base: ControllerApp, user_id: str) -> None:
    """The operator pause, set straight on the row (its routes have their own tests)."""
    with no_tenant():
        async with base.factory() as session:
            user = await session.get(User, user_id)
            assert user is not None
            user.hosted_paused_at = datetime.now(UTC) - timedelta(minutes=3)
            await session.commit()


async def test_a_paused_owner_s_agents_cant_reply_even_on_a_running_box(views) -> None:
    controller_id, agent_ids = await enrolled(views.base, agents=2)
    await _running(views.base, used_pct=40)
    await _report_agents(
        views.base,
        controller_id,
        [
            {
                "agent_id": agent_ids[0],
                "process": "running",
                "session": "active",
                "busy": True,
            },
            {"agent_id": agent_ids[1], "process": "running", "session": "active"},
        ],
    )
    await _pause(views.base, views.base.owner_id)
    body = (await views.client.get(OVERVIEW)).json()
    (person,) = body["people"]
    assert person["paused"] is True
    assert person["agents"] == {"working": 0, "idle": 0, "resting": 0, "unavailable": 2}
    # The Boxes tab keeps the box's own state, from the box.
    (row,) = body["boxes"]
    assert row["state"] == "running"


async def test_a_paused_user_with_no_box_is_still_listed_as_paused(views) -> None:
    await _pause(views.base, views.users["second"].id)
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    # The box's owner is listed for their queued box, not paused. The paused
    # user with no box is listed too, as paused.
    rows = {row["user_id"]: row for row in answer.json()["people"]}
    owner_keyed = KEY.keyed_id(KeyedIdKind.USER, views.base.owner_id)
    second_keyed = KEY.keyed_id(KeyedIdKind.USER, views.users["second"].id)
    assert set(rows) == {owner_keyed, second_keyed}
    assert rows[owner_keyed]["paused"] is False
    person = rows[second_keyed]
    assert (person["name"], person["paused"], person["memory_bytes"]) == (
        None,
        True,
        None,
    )
    assert person["agents"] == {"working": 0, "idle": 0, "resting": 0, "unavailable": 0}
    _never_leaks(
        answer.text,
        views.users["second"].id,
        views.users["second"].name,
        views.users["second"].email,
    )


async def test_people_shows_the_pause_from_the_user_and_the_switch_from_the_membership(
    views,
) -> None:
    await enrolled(views.base, agents=1)
    await _running(views.base, used_pct=40)
    views.as_("admin")
    route = f"/tenants/{require_tenant_id()}/hosted-people"
    before = (await views.client.get(route)).json()
    assert before["switchable"] is True
    row = {r["user_id"]: r for r in before["people"]}[views.base.owner_id]
    assert (row["hosted"], row["paused_by_switch"]) == ("on", False)

    await _pause(views.base, views.base.owner_id)
    async with views.base.factory() as session:
        membership = await session.scalar(
            select(TenantMember).where(
                TenantMember.tenant_id == require_tenant_id(),
                TenantMember.user_id == views.base.owner_id,
            )
        )
        assert membership is not None
        membership.hosted_enabled = False
        await session.commit()
    after = (await views.client.get(route)).json()
    row = {r["user_id"]: r for r in after["people"]}[views.base.owner_id]
    assert (row["hosted"], row["paused_by_switch"]) == ("off", True)


async def test_a_person_the_server_doesn_t_admit_has_no_switch(views) -> None:
    """Someone off the server's allow-list keeps their row while they have
    a box here, but the admin's switch would change nothing, so it's marked
    not switchable."""
    await enrolled(views.base, agents=1)
    await _running(views.base, used_pct=40)
    views.as_("admin")
    route = f"/tenants/{require_tenant_id()}/hosted-people"
    row = {r["user_id"]: r for r in (await views.client.get(route)).json()["people"]}[
        views.base.owner_id
    ]
    assert row["switchable"] is True
    views.base.settings.allowed_user_ids = ["someone-else"]
    try:
        row = {
            r["user_id"]: r for r in (await views.client.get(route)).json()["people"]
        }[views.base.owner_id]
    finally:
        views.base.settings.allowed_user_ids = None
    assert (row["switchable"], row["hosted"]) == (False, "off")


async def test_the_people_answer_has_exactly_the_contract_s_fields(views) -> None:
    """The shape Console parses strictly (its People schema refuses any other
    field): the same keys as the shared fixture, which Console's own test reads."""
    from pathlib import Path

    contract = json.loads(
        (
            Path(__file__).parent.parent
            / "fixtures"
            / "visibility"
            / "hosted_people_response.json"
        ).read_text()
    )
    await enrolled(views.base, agents=1)
    await _running(views.base, used_pct=40)
    views.as_("admin")
    body = (
        await views.client.get(f"/tenants/{require_tenant_id()}/hosted-people")
    ).json()
    assert set(body) == set(contract)
    assert body["people"], body
    for row in body["people"]:
        assert set(row) == set(contract["people"][0])


async def test_the_overview_shows_v5_s_alerts_with_template_text_only(views) -> None:
    """The Alerts tab: the open hosted alerts, with only its fixed title and detail
    and keyed ids, never anything a box or person wrote."""
    from switch_core.visibility.alerts import Condition, Verdict, apply_alert

    target = KEY.keyed_id(KeyedIdKind.USER, views.base.owner_id)
    await apply_alert(
        views.base.factory, Verdict(Condition.PAUSE_FAILED, target, True, None)
    )
    answer = await views.client.get(OVERVIEW)
    assert answer.status_code == 200, answer.text
    alerts = answer.json()["alerts"]
    assert len(alerts) == 1
    (alert,) = alerts
    assert set(alert) == {
        "id",
        "severity",
        "title",
        "detail",
        "raised_at",
        "cleared_at",
    }
    assert alert["severity"] in ("warning", "critical")
    assert alert["cleared_at"] is None
    _never_leaks(answer.text, views.base.owner_id, views.users["owner"].name)
