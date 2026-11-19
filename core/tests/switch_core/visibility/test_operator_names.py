"""Operators named to each other (W5): the Operators list and the audit log's
`actor_name`, on a real database. Operators only; names only, never an id or
an email; only people on the list now; and a removed operator keeps their name
on their past entries, as a choice."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import ServerAuditEvent, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session, get_session_factory
from switch_core.visibility.alerts import Condition, Verdict, apply_alert
from switch_core.visibility.audit_log import record_operator_request
from switch_core.visibility.audit_routes import list_operator_audit_events, router
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind
from switch_core.visibility.operators import OperatorList
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")
# Planted markers: one in emails, one in an operator's user id. Neither may
# reach the Operators list. (The log names operators by user id in its grant
# entries, by design, so only the email marker is checked there.)
MARKER = "zebra-marker-5e2a"
ID_MARKER = "idmark-91b3"
OPERATORS = "/shared-cloud/operators"
LOG = "/shared-cloud/audit-events"


@dataclass
class NamesApp:
    client: httpx.AsyncClient
    app: FastAPI
    users: dict[str, User]
    operators_file: Path

    def as_(self, who: str) -> None:
        self.app.state.current = self.users[who]

    def list_operators(self, *who: str) -> None:
        ids = [self.users[w].id if w in self.users else w for w in who]
        self.operators_file.write_text(json.dumps({"operators": ids}))
        self.operators_file.chmod(0o600)


async def _user(
    harness: RLSHarness, user_id: str, name: str, email: str, role: str = "user"
) -> User:
    async with harness.owner() as session:
        user = User(id=user_id, name=name, email=email, role=role, password_hash="x")
        session.add(user)
        await session.commit()
        return user


@pytest.fixture
async def names(rls_harness: RLSHarness, tmp_path: Path):
    users = {
        "jo": await _user(
            rls_harness, f"op-jo-{ID_MARKER}", "Jo Operator", f"jo-{MARKER}@example.com"
        ),
        "ren": await _user(
            rls_harness, "op-ren", "Ren Operator", f"ren-{MARKER}@example.com"
        ),
        "member": await _user(rls_harness, "member-1", "Mo Member", "mo@example.com"),
        "server_admin": await _user(
            rls_harness, "admin-1", "Dee Admin", "dee@example.com", role="admin"
        ),
    }
    app = FastAPI()
    app.include_router(router)
    operators_file = tmp_path / "operators.json"
    app.state.operator_list = OperatorList(operators_file)

    async def session_dep():
        async with rls_harness.restricted() as opened:
            yield opened

    async def current_user():
        return app.state.current

    app.dependency_overrides[get_session] = session_dep
    app.dependency_overrides[get_session_factory] = lambda: rls_harness.restricted
    app.dependency_overrides[get_current_user] = current_user
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        result = NamesApp(
            client=client, app=app, users=users, operators_file=operators_file
        )
        result.list_operators("jo", "ren")
        result.as_("jo")
        yield result


def _never_leaks(text: str, *forbidden: str) -> None:
    for value in (MARKER, *forbidden):
        assert value not in text, value


@pytest.mark.parametrize("who", ["member", "server_admin"])
async def test_only_operators_on_the_list_get_either_route(
    names: NamesApp, who: str
) -> None:
    names.as_(who)
    assert (await names.client.get(OPERATORS)).status_code == 403
    assert (await names.client.get(LOG)).status_code == 403


async def test_the_list_names_the_operators_now_and_nothing_else(
    names: NamesApp,
) -> None:
    answer = await names.client.get(OPERATORS)
    assert answer.status_code == 200
    assert answer.headers["cache-control"] == "no-store"
    body = answer.json()
    assert [(o["name"], o["you"], o["how"]) for o in body] == [
        ("Jo Operator", True, "server_settings"),
        ("Ren Operator", False, "server_settings"),
    ]
    assert all(set(o) == {"name", "since", "how", "you"} for o in body)
    # Since: when the log recorded the grant, which the first request did.
    for o in body:
        assert abs(datetime.fromisoformat(o["since"]) - datetime.now(UTC)) < timedelta(
            minutes=5
        )
    _never_leaks(answer.text, ID_MARKER, "op-ren", "@example.com", "mo@example.com")


async def test_a_removed_operator_is_gone_on_the_next_read(names: NamesApp) -> None:
    assert len((await names.client.get(OPERATORS)).json()) == 2
    names.list_operators("jo")
    body = (await names.client.get(OPERATORS)).json()
    assert [o["name"] for o in body] == ["Jo Operator"]


async def test_a_listed_id_with_no_user_is_left_out(names: NamesApp) -> None:
    names.list_operators("jo", f"ghost-{ID_MARKER}")
    answer = await names.client.get(OPERATORS)
    assert [o["name"] for o in answer.json()] == ["Jo Operator"]
    _never_leaks(answer.text, ID_MARKER, "ghost-")


async def test_the_log_names_operators_and_keeps_a_removed_ones_name(
    names: NamesApp, rls_harness: RLSHarness
) -> None:
    # The first request records both grants.
    assert (await names.client.get(OPERATORS)).status_code == 200
    await record_operator_request(
        rls_harness.restricted,
        actor_user_id="op-ren",
        action=ServerAuditAction.HOSTED_USER_PAUSED,
        target_type="user",
        target_keyed_id=KEY.keyed_id(KeyedIdKind.USER, "user-1"),
        reason="Misuse report",
    )
    named = (await names.client.get(LOG)).json()
    assert [e["actor_name"] for e in named if e["action"] == "hosted.user_paused"] == [
        "Ren Operator"
    ]
    # Removed from the list: a choice, not an accident. Their past
    # entries still name them to operators.
    names.list_operators("jo")
    after = await names.client.get(LOG)
    assert [
        e["actor_name"] for e in after.json() if e["action"] == "hosted.user_paused"
    ] == ["Ren Operator"]
    _never_leaks(after.text, "@example.com")


async def test_nobody_but_an_operator_is_ever_named(
    names: NamesApp, rls_harness: RLSHarness
) -> None:
    """A user id that was never granted the role gets no name, and a workspace
    admin's copy (a keyed id as its actor) is never looked up, even when the
    keyed id happens to equal a user's id."""
    async with rls_harness.restricted() as session:
        await record_server_audit_event(
            session,
            actor_user_id="member-1",
            action=ServerAuditAction.HOSTED_USER_RESUMED,
            target_type="user",
            target_id=KEY.keyed_id(KeyedIdKind.USER, "user-2"),
            details={"phase": "requested", "reason": "x"},
        )
        await record_server_audit_event(
            session,
            actor_user_id="op-ren",
            action=ServerAuditAction.HOSTED_ADMIN_CHANGE,
            target_type="user",
            target_id=KEY.keyed_id(KeyedIdKind.USER, "user-3"),
            details={"result": "done", "actor_kind": "workspace_admin"},
        )
        await session.commit()
    answer = await names.client.get(LOG)
    by_action = {e["action"]: e for e in answer.json()}
    assert by_action["hosted.user_resumed"]["actor_name"] is None
    assert by_action["hosted.admin_change"]["actor_name"] is None
    _never_leaks(answer.text, "Mo Member", "Ren Operator")


async def test_alert_entries_carry_their_fixed_title(
    names: NamesApp, rls_harness: RLSHarness
) -> None:
    box = KEY.keyed_id(KeyedIdKind.BOX, "box-1")
    now = datetime.now(UTC)
    raised = Verdict(Condition.BOX_RESTARTS, box, True, 4)
    cleared = Verdict(Condition.BOX_RESTARTS, box, False, 1)
    assert await apply_alert(rls_harness.restricted, raised, now) == "raised"
    assert (
        await apply_alert(rls_harness.restricted, cleared, now + timedelta(minutes=1))
        == "cleared"
    )
    title = f"Box `{box}` restarted 4 times in the last hour"
    [up] = (await names.client.get(LOG, params={"action": "alert.raised"})).json()
    [down] = (await names.client.get(LOG, params={"action": "alert.cleared"})).json()
    # A clear names what was raised, not the figure that cleared it.
    assert up["title"] == title
    assert down["title"] == title
    assert up["actor_name"] is None
    others = (await names.client.get(LOG)).json()
    assert all(e["title"] is None for e in others)


async def test_paging_on_time_and_id_skips_and_repeats_nothing(
    rls_harness: RLSHarness,
) -> None:
    """Entries sharing one exact time, paged one at a time: each comes back
    exactly once, even at a page edge."""
    at = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
    async with rls_harness.restricted() as session:
        for n in range(3):
            session.add(
                ServerAuditEvent(
                    occurred_at=at,
                    actor_user_id=None,
                    action=ServerAuditAction.HOSTED_BOX_PROVISION.value,
                    target_type="user",
                    target_id=KEY.keyed_id(KeyedIdKind.USER, f"user-{n}"),
                    details={"phase": "requested"},
                )
            )
        await session.commit()
    operator = SimpleNamespace(id="op-jo")
    seen: list[str] = []
    before: datetime | None = None
    before_id: str | None = None
    for _ in range(4):
        async with rls_harness.restricted() as session:
            page = await list_operator_audit_events(
                session,
                operator,  # type: ignore[arg-type]
                limit=1,
                before=before,
                before_id=before_id,
            )
        if not page:
            break
        seen.append(page[0].id)
        before = datetime.fromisoformat(page[0].occurred_at)
        before_id = page[0].id
    assert len(seen) == 3
    assert len(set(seen)) == 3
    # `before` alone keeps its old meaning: strictly older than that time.
    async with rls_harness.restricted() as session:
        older = await list_operator_audit_events(
            session,
            operator,  # type: ignore[arg-type]
            before=at,
        )
    assert older == []


async def test_each_clear_names_the_raise_it_closed(
    names: NamesApp, rls_harness: RLSHarness
) -> None:
    """Raised and cleared twice with different figures: each clear takes its own
    raise's figure, with the lookup bounded to the page's clears."""
    box = KEY.keyed_id(KeyedIdKind.BOX, "box-2")
    t0 = datetime.now(UTC) - timedelta(hours=1)
    steps = [(True, 3), (False, 1), (True, 5), (False, 0)]
    for n, (true_now, figure) in enumerate(steps):
        verdict = Verdict(Condition.BOX_RESTARTS, box, true_now, figure)
        assert await apply_alert(
            rls_harness.restricted, verdict, t0 + timedelta(minutes=15 * n)
        )
    cleared = (await names.client.get(LOG, params={"action": "alert.cleared"})).json()
    # Newest first: the second clear closed the raise of 5, the first the raise of 3.
    assert [e["title"] for e in cleared] == [
        f"Box `{box}` restarted 5 times in the last hour",
        f"Box `{box}` restarted 3 times in the last hour",
    ]
    # Paged one at a time, each clear still finds its own raise.
    [newest] = (
        await names.client.get(LOG, params={"action": "alert.cleared", "limit": 1})
    ).json()
    [oldest] = (
        await names.client.get(
            LOG,
            params={
                "action": "alert.cleared",
                "limit": 1,
                "before": newest["occurred_at"],
                "before_id": newest["id"],
            },
        )
    ).json()
    assert "5 times" in newest["title"] and "3 times" in oldest["title"]
