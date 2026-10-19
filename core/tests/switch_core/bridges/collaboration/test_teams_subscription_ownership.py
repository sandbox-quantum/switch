"""A Teams bridge's Graph subscriptions are made, adopted and renewed by the
one process that holds the bridge.

Against real PostgreSQL, two "processes" on one database, each wired as
`test_bridge_ownership.py` wires one, both running a bring-your-own Teams
bridge. Graph here (`_Graph`) is the one both copies' clients reach: it keeps
the subscriptions, and each client records what it asked of it. Graph
delivers a channel's messages to every subscription made for it, and its
webhooks reach whichever process the load balancer picks, so a quiet copy
hands what would change the subscriptions to the holder.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.teams import adapter as adapter_module
from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.collaboration.test_bridge_ownership import (
    _Process,
)
from tests.switch_core.bridges.collaboration.test_bridge_ownership import (
    _process as _bridge_process,
)
from tests.switch_core.bridges.collaboration.test_teams_capture_repair import (
    _config,
)

TIMEOUT = 10.0
TEAM = "team-1"
CHANNEL = "19:captured@thread.tacv2"
NEW_CHANNEL = "19:made-through-the-quiet-one@thread.tacv2"
NOTIFICATION_URL = "https://switch.example/api/teams/notifications"


def _resource(channel_id: str) -> str:
    return f"teams/{TEAM}/channels/{channel_id}/messages"


class _Graph:
    """Microsoft Graph, as far as these bridges reach it."""

    def __init__(self) -> None:
        self.subscriptions: dict[str, dict[str, Any]] = {}

    def add(self, channel_id: str, *, expires_in: timedelta) -> str:
        subscription_id = f"sub-{uuid.uuid4().hex[:8]}"
        self.subscriptions[subscription_id] = {
            "id": subscription_id,
            "resource": _resource(channel_id),
            "notificationUrl": NOTIFICATION_URL,
            "expirationDateTime": (datetime.now(UTC) + expires_in).isoformat(),
        }
        return subscription_id


class _GraphClient:
    """One copy's Graph client, recording what that copy asked."""

    def __init__(self, graph: _Graph) -> None:
        self.graph = graph
        self.listed = 0
        self.created: list[str] = []
        self.renewed: list[str] = []
        self.deleted: list[str] = []

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        self.listed += 1
        return list(self.graph.subscriptions.values())

    async def create_subscription(
        self, *, resource: str, expiration_iso: str, **_: Any
    ) -> dict[str, Any]:
        self.created.append(resource)
        channel_id = resource.split("/channels/")[1].split("/")[0]
        subscription_id = self.graph.add(channel_id, expires_in=timedelta(minutes=55))
        return {"id": subscription_id, "expirationDateTime": expiration_iso}

    async def renew_subscription(
        self, *, subscription_id: str, expiration_iso: str
    ) -> None:
        self.renewed.append(subscription_id)

    async def delete_subscription(self, *, subscription_id: str) -> None:
        self.deleted.append(subscription_id)
        self.graph.subscriptions.pop(subscription_id, None)

    async def create_channel(self, *, display_name: str, **_: Any) -> dict[str, Any]:
        return {"id": NEW_CHANNEL, "displayName": display_name}

    def __getattr__(self, name: str) -> Any:
        # The rest of Graph is not what these tests are about: reading a
        # channel's type or name fails, as an unreachable Graph would.
        async def unreachable(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError(f"Graph {name} is not part of this test")

        return unreachable


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch) -> _Graph:
    graph = _Graph()
    monkeypatch.setattr(adapter_module, "GraphClient", lambda **_: _GraphClient(graph))
    for name in (
        "TeamsTokenProvider",
        "BotFrameworkAuthenticator",
        "SigningKeys",
        "BotConnectorClient",
    ):
        monkeypatch.setattr(adapter_module, name, lambda **_: MagicMock())

    async def no_listener(self: TeamsAdapter) -> None:
        return None

    # Both copies run in this one test process: neither binds its port.
    monkeypatch.setattr(TeamsAdapter, "_open_listener", no_listener)
    return graph


@dataclass
class _Teams:
    bridge_id: str


@pytest.fixture
async def teams(session_factory: async_sessionmaker[AsyncSession]) -> _Teams:
    """A bring-your-own Teams bridge carrying one channel."""
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@switch-bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        row = CollaborationBridge(
            type="teams",
            display_name="Teams",
            connection_config=_config().model_dump(),
            client_id=client.id,
            status="active",
            channel_creation_enabled=True,
            preconfigured=False,
        )
        session.add(row)
        await session.flush()
        room = Room(
            transport_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
            name="captured",
            description="",
            bridge_id=row.id,
            external_channel_id=CHANNEL,
            channel_type="channel_public",
        )
        session.add(room)
        await session.flush()
        await RoomStore().add_client(session, client.id, room.id)
        await session.commit()
        return _Teams(bridge_id=row.id)


@pytest.fixture
async def two(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    graph: _Graph,
    teams: _Teams,
) -> AsyncIterator[tuple[_Process, _Process]]:
    started: list[_Process] = []
    try:
        for _ in range(2):
            process = await _bridge_process(postgres_url, session_factory)
            process.bridges.register_adapter(
                "teams", TeamsAdapter, TeamsConnectionConfig
            )
            started.append(process)
            await process.boot()
        # The first balance of each cannot see the other; balance once more
        # now that both leases are there, as the interval would.
        for process in started:
            await process.ownership.balance()
        for process in started:
            await process.settled()
        for process in started:
            await _eventually(lambda p=process: p.bridges.is_connected(teams.bridge_id))
        yield started[0], started[1]
    finally:
        for process in started:
            await process.stop()


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


def _holder(
    two: tuple[_Process, _Process], bridge_id: str
) -> tuple[_Process, _Process]:
    a, b = two
    holders = [p for p in (a, b) if p.bridges.holds(bridge_id)]
    assert len(holders) == 1
    return (a, b) if holders[0] is a else (b, a)


def _adapter(process: _Process, bridge_id: str) -> TeamsAdapter:
    adapter = process.bridges.get_adapter(bridge_id)
    assert isinstance(adapter, TeamsAdapter)
    return adapter


def _graph_of(process: _Process, bridge_id: str) -> _GraphClient:
    client = _adapter(process, bridge_id)._graph
    assert isinstance(client, _GraphClient)
    return client


class TestOnlyTheHolder:
    @pytest.fixture
    def graph(self, graph: _Graph) -> _Graph:
        # Made before either process started, and close to running out.
        graph.add(CHANNEL, expires_in=timedelta(minutes=5))
        return graph

    async def test_adopts_and_renews_the_subscriptions(
        self, two: tuple[_Process, _Process], teams: _Teams, graph: _Graph
    ) -> None:
        holder, quiet = _holder(two, teams.bridge_id)
        held = _graph_of(holder, teams.bridge_id)

        await _eventually(lambda: len(held.renewed) == 1)
        # Long enough for the quiet copy's renewal, had there been one.
        await asyncio.sleep(0.5)

        assert held.renewed == list(graph.subscriptions)
        copy = _graph_of(quiet, teams.bridge_id)
        assert copy.listed == 0
        assert copy.renewed == []
        assert copy.created == []


class TestWebhooksReachingTheQuietProcess:
    async def test_a_channel_made_through_it_is_subscribed_once_by_the_holder(
        self, two: tuple[_Process, _Process], teams: _Teams, graph: _Graph
    ) -> None:
        holder, quiet = _holder(two, teams.bridge_id)

        await _adapter(quiet, teams.bridge_id).create_channel("new", "")

        held = _graph_of(holder, teams.bridge_id)
        await _eventually(lambda: _resource(NEW_CHANNEL) in held.created)
        await asyncio.sleep(0.5)
        assert held.created.count(_resource(NEW_CHANNEL)) == 1
        assert _graph_of(quiet, teams.bridge_id).created == []

    async def test_a_subscription_needing_renewal_is_renewed_by_the_holder(
        self, two: tuple[_Process, _Process], teams: _Teams, graph: _Graph
    ) -> None:
        holder, quiet = _holder(two, teams.bridge_id)
        held = _graph_of(holder, teams.bridge_id)
        # The holder subscribes to the bridge's channel as it starts.
        await _eventually(lambda: len(graph.subscriptions) == 1)
        (subscription_id,) = graph.subscriptions
        renewed_before = list(held.renewed)

        await _adapter(quiet, teams.bridge_id).receive_notification(
            {
                "subscriptionId": subscription_id,
                "clientState": "s3cr3t",
                "lifecycleEvent": "reauthorizationRequired",
            }
        )

        await _eventually(lambda: held.renewed != renewed_before)
        assert held.renewed[len(renewed_before) :] == [subscription_id]
        assert _graph_of(quiet, teams.bridge_id).renewed == []
