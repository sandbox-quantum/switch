"""Only agents' messages, and Switch's own notices, are posted to the platform.

People live on the messaging app. One who wrote there already sees their own
message, and one who wrote somewhere else (Switch Console, a scheduled message
in their name) is not reposted under their name, which also keeps their name
away from any avatar service the platform would draw it with.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import (
    ADMIN_MARKER,
    PLATFORM_MARKER,
    CollaborationCore,
)
from switch_core.db.models import TENANT_ZERO_ID, Client
from switch_core.db.stores.client_store import ClientStore
from switch_core.transport import InboundMessage, RoomRef
from tests.switch_core.bridges.collaboration.outbound_fakes import (
    posting_without_a_database,
)

ROOM = "!r:switch.local"


class _RecordingAdapter:
    def __init__(self) -> None:
        self.admin_calls: list[str] = []
        self.message_calls: list[tuple[str, str]] = []

    def translate_outbound(self, content: str) -> str:
        return content

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
        self.admin_calls.append(content)
        return "ref-admin"

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        self.message_calls.append((sender_name, content))
        return "ref-msg"


async def _none(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "tenant-1"


def _bridge(adapter: _RecordingAdapter, *, non_agents: set[str]) -> CollaborationCore:
    core = object.__new__(CollaborationCore)
    core._bridge_type = "slack"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[assignment]
    core._human_user_ids = {"@slack-person:switch.local"}  # type: ignore[assignment]
    core._non_agent_senders = non_agents  # type: ignore[attr-defined]
    core._workspace_consumer_transport_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", ROOM)}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    posting_without_a_database(core)
    core._outbound_thread_root_ref = _none  # type: ignore[assignment]
    return core


def _event(
    sender: str, sender_name: str | None, content: dict[str, Any] | None = None
) -> InboundMessage:
    return InboundMessage(
        room_id=ROOM,
        event_id=f"${sender_name or 'system'}",
        sender=sender,
        timestamp=1700000000000,
        content=content or {},
        body="hello",
        sender_name=sender_name,
    )


async def test_an_agent_message_is_posted() -> None:
    adapter = _RecordingAdapter()
    await _bridge(adapter, non_agents=set()).handle_outbound_message(
        RoomRef(ROOM), _event("@agent-scout:switch.local", "scout")
    )
    assert adapter.message_calls == [("scout", "hello")]


async def test_a_person_writing_from_console_is_not_posted() -> None:
    adapter = _RecordingAdapter()
    member = "@member-ada:switch.local"
    await _bridge(adapter, non_agents={member}).handle_outbound_message(
        RoomRef(ROOM), _event(member, "ada")
    )
    assert adapter.message_calls == []
    assert adapter.admin_calls == []


async def test_a_person_on_the_platform_is_not_echoed() -> None:
    adapter = _RecordingAdapter()
    await _bridge(adapter, non_agents=set()).handle_outbound_message(
        RoomRef(ROOM), _event("@slack-person:switch.local", "bob")
    )
    assert adapter.message_calls == []


async def test_switch_notices_are_posted_whoever_sends_them() -> None:
    adapter = _RecordingAdapter()
    admin = "@switch-admin:switch.local"
    core = _bridge(adapter, non_agents={admin})

    await core.handle_outbound_message(
        RoomRef(ROOM),
        _event(admin, None, {ADMIN_MARKER: {"type": "command_result"}}),
    )
    await core.handle_outbound_message(
        RoomRef(ROOM), _event(admin, None, {PLATFORM_MARKER: {}})
    )

    assert len(adapter.admin_calls) == 2


def _real_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationCore:
    core = object.__new__(CollaborationCore)
    core._session_factory = session_factory  # type: ignore[assignment]
    core._client_store = ClientStore()  # type: ignore[assignment]
    core._human_user_ids = set()  # type: ignore[assignment]
    core._agent_sender_ids = set()  # type: ignore[assignment]
    core._not_agent_sender_ids = set()  # type: ignore[assignment]
    return core


async def test_only_an_agent_client_counts_as_an_agent(session_factory) -> None:
    async with session_factory() as session:
        for transport_user_id, client_type in [
            ("@agent:t", "agent"),
            ("@member:t", "member"),
            ("@person:t", "user"),
        ]:
            session.add(
                Client(
                    transport_user_id=transport_user_id,
                    display_name=transport_user_id,
                    type=client_type,
                )
            )
        await session.commit()
    core = _real_bridge(session_factory)

    assert await core._is_agent_sender(TENANT_ZERO_ID, "@agent:t") is True
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@member:t") is False
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@person:t") is False
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@unknown:t") is False


async def test_the_answer_is_read_once_per_sender(session_factory) -> None:
    async with session_factory() as session:
        session.add(
            Client(transport_user_id="@agent:t", display_name="a", type="agent")
        )
        await session.commit()
    core = _real_bridge(session_factory)

    assert await core._is_agent_sender(TENANT_ZERO_ID, "@agent:t") is True
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@ghost:t") is False

    def _no_database(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("asked the database again")

    core._session_factory = _no_database  # type: ignore[assignment]
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@agent:t") is True
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@ghost:t") is False


async def test_a_person_on_the_bridge_is_known_without_asking() -> None:
    core = object.__new__(CollaborationCore)
    core._human_user_ids = {"@slack-person:t"}  # type: ignore[assignment]
    assert await core._is_agent_sender(TENANT_ZERO_ID, "@slack-person:t") is False
