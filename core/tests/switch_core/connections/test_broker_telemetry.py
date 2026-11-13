"""What the broker reports about service connectors, against Postgres.

A connection made or made again, an agent's access given, changed and taken
away, a connection ended or lost, and a token refused — once an hour per
agent, service and reason, since a session host asks again on its own.
"""

from __future__ import annotations

from datetime import timedelta
from typing import get_args

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import (
    ConnectionSecret,
    ReauthorizationRequiredError,
)
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG, AdapterName
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.telemetry.services import (
    AUTH_KINDS,
    TOKEN_REFUSAL_WINDOW_SECONDS,
    TokenRefusals,
)
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.test_broker import (
    RESOURCES,
    STORE,
    _refused,
    _secret,
    _user,
    _world,
)
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.telemetry_records import RecordingSink, recording_telemetry


@pytest.fixture
def vendor() -> FakeVendor:
    return FakeVendor()


def _reporting(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> tuple[ServiceBroker, RecordingSink]:
    telemetry, sink = recording_telemetry()
    broker = ServiceBroker(
        telemetry=telemetry,
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"github": vendor},
        organization_apps=None,
        disabled={},
        store=STORE,
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=False,
        public_url=None,
    )
    return broker, sink


async def _link(broker: ServiceBroker, session: AsyncSession, user_id: str) -> None:
    await broker.connect(
        session,
        user_id=user_id,
        service="github",
        consent="write",
        granted_scopes=[],
        account_id="1001",
        external_identity="ada-gh",
        secret=ConnectionSecret(_secret(expires_in=3600)),
        oauth_client_id=None,
    )


async def test_a_connection_and_linking_it_again(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> None:
    broker, sink = _reporting(session_factory, vendor)
    async with session_factory() as session:
        ada = await _user(session, "ada")
        await session.commit()
        await _link(broker, session, ada.id)
        await _link(broker, session, ada.id)

    added = {
        "service": "github",
        "auth_kind": "github_app",
        "consent": "write",
    }
    assert sink.events("service_connection_added") == [
        {**added, "relinked": False, "first_for_person": True},
        {**added, "relinked": True, "first_for_person": False},
    ]


async def test_access_given_changed_and_taken_away(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> None:
    broker, sink = _reporting(session_factory, vendor)
    world = await _world(session_factory)
    async with session_factory() as session:
        planner = await add_agent(session, name="planner", owner_id=world.owner.id)
        await session.commit()
        for access in ("read", "write"):
            grant, _ = await broker.set_grant(
                session,
                agent=planner,
                actor_id=world.owner.id,
                service="github",
                access=access,  # type: ignore[arg-type]
                tool_mode=None,
                tools=None,
                resources=RESOURCES,
                granted_by="person",
            )
        await broker.revoke_grant(session, grant, world.owner.id, removed_by="agent")

    assert [
        (e["access"], e["granted_by"], e["change"])
        for e in sink.events("service_grant_set")
    ] == [("read", "person", "new"), ("write", "person", "updated")]
    assert sink.events("service_grant_removed") == [
        {"service": "github", "removed_by": "agent"}
    ]


async def test_a_disconnect_says_who_ended_it_and_how_old_it_was(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> None:
    broker, sink = _reporting(session_factory, vendor)
    world = await _world(session_factory)
    async with session_factory() as session:
        await broker.disconnect(session, world.owner.id, "github")

    [removed] = sink.events("service_connection_removed")
    assert (removed["service"], removed["removed_by"]) == ("github", "self")
    assert removed["age_days"] >= 0


async def test_a_refused_refresh_is_a_lost_connection_and_one_refusal_an_hour(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> None:
    broker, sink = _reporting(session_factory, vendor)
    world = await _world(session_factory, expires_in=60)
    vendor.refresh_error = ReauthorizationRequiredError("GitHub refused the sign-in.")

    await _refused(broker, session_factory, world.agent.id)
    await _refused(broker, session_factory, world.agent.id)

    assert sink.events("service_connection_lost") == [
        {"service": "github", "reason": "refresh_refused"}
    ]
    assert sink.events("service_token_refused") == [
        {
            "service": "github",
            "reason": "connector_revoked",
            "retryable": False,
            "principal": "agent_key",
        }
    ]


def test_a_refusal_is_reported_again_once_the_hour_is_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(
        "switch_core.telemetry.services.time.monotonic", lambda: clock[0]
    )
    refusals = TokenRefusals(held=100)

    first = refusals.first_in_window("a1", "github", "grant_missing")
    soon = refusals.first_in_window("a1", "github", "grant_missing")
    other = refusals.first_in_window("a1", "github", "forbidden")
    clock[0] += 3601
    later = refusals.first_in_window("a1", "github", "grant_missing")

    assert (first, soon, other, later) == (True, False, True, True)


def test_refusals_held_are_capped_dropping_the_oldest_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(
        "switch_core.telemetry.services.time.monotonic", lambda: clock[0]
    )
    refusals = TokenRefusals(held=2)

    for agent in ("a1", "a2", "a3"):
        assert refusals.first_in_window(agent, "github", "grant_missing")
        clock[0] += 1

    # a1 was dropped to make room, so it reports again; a3 is still held.
    assert refusals.first_in_window("a1", "github", "grant_missing")
    assert not refusals.first_in_window("a3", "github", "grant_missing")


def test_a_refusal_reported_again_moves_to_the_back_of_the_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(
        "switch_core.telemetry.services.time.monotonic", lambda: clock[0]
    )
    refusals = TokenRefusals(held=2)
    refusals.first_in_window("a1", "github", "grant_missing")
    clock[0] += TOKEN_REFUSAL_WINDOW_SECONDS + 1
    refusals.first_in_window("a2", "github", "grant_missing")
    # a1's window is over: reported again, and now newer than a2.
    assert refusals.first_in_window("a1", "github", "grant_missing")
    refusals.first_in_window("a3", "github", "grant_missing")

    assert refusals.first_in_window("a2", "github", "grant_missing")
    assert not refusals.first_in_window("a3", "github", "grant_missing")


def test_every_adapter_has_an_auth_kind() -> None:
    assert set(AUTH_KINDS) == set(get_args(AdapterName))


async def test_a_connection_already_lost_is_not_reported_lost_again(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> None:
    """Another request recorded the refusal while this one was asking the
    vendor: the connection was lost once, so it is reported once."""
    broker, sink = _reporting(session_factory, vendor)
    world = await _world(session_factory)

    async def lost_meanwhile() -> None:
        async with session_factory() as session:
            assert await STORE.mark_needs_reauthorization(
                session, world.owner.id, "github", "sign_in_refused"
            )
            await session.commit()

    vendor.during_issue = lost_meanwhile
    vendor.issue_error = ReauthorizationRequiredError("GitHub refused the sign-in.")

    await _refused(broker, session_factory, world.agent.id)

    assert sink.events("service_connection_lost") == []
