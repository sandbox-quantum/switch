"""`AgentCore.get_permalinks` against real Postgres, with a fake bridge lifecycle.

Membership is the boundary, as for `read_context`: a message in a room the
agent is not in reads the same as one that does not exist. The room's own
bridge decides the platform, and its map row decides the post. Slack is
asked only after the session is closed.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    BridgeMessageMap,
    Client,
    CollaborationBridge,
    Tenant,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.messages.recorded_types import MEMBERSHIP_EVENT_TYPE
from tests.db_buffer import say, seed_agent, seed_room
from tests.switch_core.bridges.collaboration.slack_fakes import FakeWebClient

AGENT = "agent-permalinks"
TENANT_B = "permalinks-tenant-b"
BOT_TOKEN = "xoxb-secret-token"


class _Lifecycle:
    """The two questions `get_permalinks` asks the bridge lifecycle."""

    def __init__(self) -> None:
        self.adapters: dict[str, PlatformAdapter] = {}
        self.classes: dict[str, type[PlatformAdapter]] = {
            "slack": SlackAdapter,
            "mattermost": MattermostAdapter,
        }

    def get_adapter(self, bridge_id: str) -> PlatformAdapter | None:
        return self.adapters.get(bridge_id)

    def adapter_class(self, bridge_type: str) -> type[PlatformAdapter] | None:
        return self.classes.get(bridge_type)


class _OpenSessions:
    """The real factory, counting the sessions open at this moment."""

    def __init__(self, inner: async_sessionmaker[AsyncSession]) -> None:
        self._inner = inner
        self.open = 0

    def __call__(self) -> Any:
        return self._session()

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[AsyncSession]:
        async with self._inner() as session:
            self.open += 1
            try:
                yield session
            finally:
                self.open -= 1


class _CountingAdapter:
    """A live adapter that records how many permalink calls run at once, and
    whether any session was open while one ran."""

    supports_message_permalinks = True

    def __init__(self, sessions: _OpenSessions | None = None) -> None:
        self.running = 0
        self.peak = 0
        self.asked: list[str] = []
        self.open_sessions_seen: list[int] = []
        self._sessions = sessions

    async def message_permalink(self, external_post_id: str) -> str:
        if self._sessions is not None:
            self.open_sessions_seen.append(self._sessions.open)
        self.asked.append(external_post_id)
        self.running += 1
        self.peak = max(self.peak, self.running)
        await asyncio.sleep(0.01)
        self.running -= 1
        return f"https://example.slack.com/{external_post_id}"


def _slack_adapter() -> tuple[SlackAdapter, FakeWebClient]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token=BOT_TOKEN, app_token="xapp-test", workspace_id="T123"
        )
    )
    client = FakeWebClient()
    adapter._web_client = client  # type: ignore[assignment]
    return adapter, client


def _service(session_factory: Any, lifecycle: _Lifecycle) -> AgentCore:
    svc = object.__new__(AgentCore)
    svc.session_factory = session_factory
    svc.message_store = MessageStore()
    svc.room_store = RoomStore()
    svc.bridge_store = CollaborationBridgeStore()
    svc.bridge_message_map_store = BridgeMessageMapStore()
    svc.collab_lifecycle = lifecycle  # type: ignore[assignment]
    return svc


async def _bridge(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_type: str = "slack",
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type=bridge_type,
            display_name=bridge_type,
            client_id=client.id,
            status="active",
        )
        session.add(bridge)
        await session.commit()
        return bridge.id


async def _room(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    bridge_id: str | None,
    member: bool = True,
    tenant_id: str = TENANT_ZERO_ID,
) -> str:
    room_id = f"room-{uuid.uuid4().hex[:8]}"
    await seed_room(session_factory, room_id, bridge_id=bridge_id, tenant_id=tenant_id)
    if member:
        await seed_agent(session_factory, AGENT, tenant_id=tenant_id)
        async with tenant_session(session_factory, tenant_id) as session:
            await session.execute(
                insert(room_agents).values(room_id=room_id, agent_id=AGENT)
            )
            await session.commit()
    return room_id


async def _posted(
    session_factory: async_sessionmaker[AsyncSession],
    bridge_id: str,
    event_id: str,
    post_id: str | None,
) -> None:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        session.add(
            BridgeMessageMap(
                bridge_id=bridge_id,
                external_channel_id=post_id.split(":")[0] if post_id else "C1",
                transport_event_id=event_id,
                external_post_id=post_id,
            )
        )
        await session.commit()


@pytest.fixture
def lifecycle() -> _Lifecycle:
    return _Lifecycle()


class TestLinks:
    async def test_member_gets_slack_link_for_bridged_message(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        message = await say(session_factory, room_id)
        await _posted(
            session_factory, bridge_id, message.transport_event_id, "C1:171.2"
        )
        adapter, client = _slack_adapter()
        lifecycle.adapters[bridge_id] = adapter

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert client.permalink_calls == [("C1", "171.2")]
        assert result == {
            "permalinks": {
                message.transport_event_id: "https://example.slack.com/archives/C1/p1712"
            },
            "unavailable": {},
        }

    async def test_attachment_group_lead_links_and_other_parts_have_no_record(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        """Only the lead of a group has a map row; it is the id `read_context`
        shows. The other parts are not looked up through it."""
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        lead, part = [
            await say(
                session_factory,
                room_id,
                f"file {n}",
                content={
                    "body": f"file {n}",
                    ATTACHMENT_GROUP_KEY: {"id": "g1", "index": n, "total": 2},
                },
            )
            for n in (0, 1)
        ]
        await _posted(session_factory, bridge_id, lead.transport_event_id, "C1:1.0")
        lifecycle.adapters[bridge_id] = _slack_adapter()[0]

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [lead.transport_event_id, part.transport_event_id]
        )

        assert list(result["permalinks"]) == [lead.transport_event_id]
        assert result["unavailable"] == {part.transport_event_id: "no_slack_record"}


class TestNotFound:
    async def test_message_in_room_agent_is_not_in_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        await seed_agent(session_factory, AGENT)
        room_id = await _room(session_factory, bridge_id=bridge_id, member=False)
        message = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, message.transport_event_id, "C1:1.0")
        adapter, client = _slack_adapter()
        lifecycle.adapters[bridge_id] = adapter

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result == {
            "permalinks": {},
            "unavailable": {message.transport_event_id: "not_found"},
        }
        assert client.permalink_calls == []

    async def test_unknown_id_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, ["$nope", ""]
        )

        assert result == {
            "permalinks": {},
            "unavailable": {"$nope": "not_found", "": "not_found"},
        }

    async def test_other_tenants_message_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        """The agent is a member of a tenant B room with the same agent id.
        The test connection bypasses row-level security, so only the explicit
        tenant filter keeps it out."""
        async with session_factory() as session:
            session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
            await session.commit()
        room_id = await _room(session_factory, bridge_id=None, tenant_id=TENANT_B)
        message = await say(session_factory, room_id, tenant_id=TENANT_B)

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result["unavailable"] == {message.transport_event_id: "not_found"}


class TestNotSlack:
    async def test_room_without_bridge_is_not_slack(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        room_id = await _room(session_factory, bridge_id=None)
        message = await say(session_factory, room_id)

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result["unavailable"] == {message.transport_event_id: "not_slack"}

    async def test_non_slack_bridge_is_not_slack_even_when_not_running(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory, "mattermost")
        room_id = await _room(session_factory, bridge_id=bridge_id)
        mapped = await say(session_factory, room_id)
        unmapped = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, mapped.transport_event_id, "post1")

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [mapped.transport_event_id, unmapped.transport_event_id]
        )

        assert result["unavailable"] == {
            mapped.transport_event_id: "not_slack",
            unmapped.transport_event_id: "not_slack",
        }


class TestNoSlackRecord:
    async def test_unposted_claim_is_no_slack_record(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        message = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, message.transport_event_id, None)
        lifecycle.adapters[bridge_id] = _slack_adapter()[0]

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result["unavailable"] == {message.transport_event_id: "no_slack_record"}

    async def test_join_event_is_no_slack_record(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        joined = await say(
            session_factory,
            room_id,
            "",
            event_type=MEMBERSHIP_EVENT_TYPE,
            content={"membership": "join"},
        )
        lifecycle.adapters[bridge_id] = _slack_adapter()[0]

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [joined.transport_event_id]
        )

        assert result["unavailable"] == {joined.transport_event_id: "no_slack_record"}

    async def test_row_under_previous_bridge_is_no_slack_record(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        """The room moved to a new Slack bridge. Its old rows belong to the
        old bridge and are not read for the new one."""
        old_bridge = await _bridge(session_factory)
        new_bridge = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=new_bridge)
        message = await say(session_factory, room_id)
        await _posted(session_factory, old_bridge, message.transport_event_id, "C1:1.0")
        adapter, client = _slack_adapter()
        lifecycle.adapters[old_bridge] = adapter
        lifecycle.adapters[new_bridge] = adapter

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result["unavailable"] == {message.transport_event_id: "no_slack_record"}
        assert client.permalink_calls == []


class TestSlackAnswers:
    async def test_no_live_adapter_is_bridge_not_running(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        message = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, message.transport_event_id, "C1:1.0")

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result["unavailable"] == {
            message.transport_event_id: "bridge_not_running"
        }

    async def test_slack_message_not_found_is_deleted_in_slack(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        message = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, message.transport_event_id, "C1:1.0")
        adapter, client = _slack_adapter()
        client.permalink_errors = ["message_not_found"]
        lifecycle.adapters[bridge_id] = adapter

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert result["unavailable"] == {message.transport_event_id: "deleted_in_slack"}

    async def test_slack_failure_is_bridge_not_running_and_logged_without_detail(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        lifecycle: _Lifecycle,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        message = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, message.transport_event_id, "C1:1.0")
        adapter, client = _slack_adapter()
        client.permalink_errors = ["invalid_auth"]
        lifecycle.adapters[bridge_id] = adapter

        with caplog.at_level(logging.WARNING):
            result = await _service(session_factory, lifecycle).get_permalinks(
                AGENT, [message.transport_event_id]
            )

        assert result == {
            "permalinks": {},
            "unavailable": {message.transport_event_id: "bridge_not_running"},
        }
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        logged = warnings[0].getMessage()
        assert "invalid_auth" in logged
        assert bridge_id in logged
        assert message.transport_event_id in logged
        assert BOT_TOKEN not in caplog.text
        assert "server responded" not in caplog.text
        assert warnings[0].exc_info is None


class TestShape:
    async def test_every_id_lands_in_exactly_one_map(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        slack = await _bridge(session_factory)
        slack_room = await _room(session_factory, bridge_id=slack)
        plain_room = await _room(session_factory, bridge_id=None)
        linked = await say(session_factory, slack_room)
        unmapped = await say(session_factory, slack_room)
        plain = await say(session_factory, plain_room)
        await _posted(session_factory, slack, linked.transport_event_id, "C1:1.0")
        lifecycle.adapters[slack] = _slack_adapter()[0]
        asked = [
            linked.transport_event_id,
            unmapped.transport_event_id,
            plain.transport_event_id,
            "$unknown",
        ]

        result = await _service(session_factory, lifecycle).get_permalinks(AGENT, asked)

        assert set(result["permalinks"]) | set(result["unavailable"]) == set(asked)
        assert not set(result["permalinks"]) & set(result["unavailable"])
        assert result["unavailable"] == {
            unmapped.transport_event_id: "no_slack_record",
            plain.transport_event_id: "not_slack",
            "$unknown": "not_found",
        }

    async def test_at_most_five_slack_calls_run_at_once(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        event_ids: list[str] = []
        for n in range(12):
            message = await say(session_factory, room_id, f"m{n}")
            await _posted(
                session_factory, bridge_id, message.transport_event_id, f"C1:{n}.0"
            )
            event_ids.append(message.transport_event_id)
        adapter = _CountingAdapter()
        lifecycle.adapters[bridge_id] = adapter  # type: ignore[assignment]

        result = await _service(session_factory, lifecycle).get_permalinks(
            AGENT, event_ids
        )

        assert len(result["permalinks"]) == 12
        assert adapter.peak == 5

    async def test_db_reads_finish_before_slack_is_called(
        self, session_factory: async_sessionmaker[AsyncSession], lifecycle: _Lifecycle
    ) -> None:
        """No pool connection is held while Slack answers."""
        bridge_id = await _bridge(session_factory)
        room_id = await _room(session_factory, bridge_id=bridge_id)
        message = await say(session_factory, room_id)
        await _posted(session_factory, bridge_id, message.transport_event_id, "C1:1.0")
        sessions = _OpenSessions(session_factory)
        adapter = _CountingAdapter(sessions)
        lifecycle.adapters[bridge_id] = adapter  # type: ignore[assignment]

        result = await _service(sessions, lifecycle).get_permalinks(
            AGENT, [message.transport_event_id]
        )

        assert list(result["permalinks"]) == [message.transport_event_id]
        assert adapter.open_sessions_seen == [0]
