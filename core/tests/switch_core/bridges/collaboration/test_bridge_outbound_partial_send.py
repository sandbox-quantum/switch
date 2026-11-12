"""A room message the platform took only part of is not posted again.

An adapter splits a long message over several platform messages, and when a
later part is refused it raises `MessagePartlySent` naming the first. The
relay settles the message's claim with that ref: letting the claim go would
have the next delivery post the parts already in the channel a second time.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import MessagePartlySent
from switch_core.bridges.collaboration.collaboration_core import (
    ADMIN_MARKER,
    CollaborationCore,
)
from switch_core.transport import InboundMessage, RoomRef
from tests.switch_core.bridges.collaboration.outbound_fakes import (
    posting_without_a_database,
)


class _PartlyAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def translate_outbound(self, content: str) -> str:
        return content

    async def _partly(self) -> str:
        self.calls += 1
        raise MessagePartlySent(
            platform="Mattermost", first_ref="post-1", delivered=1, total=3
        )

    async def admin_message(self, *args: Any, **kwargs: Any) -> str | None:
        return await self._partly()

    async def send_message(self, *args: Any, **kwargs: Any) -> str | None:
        return await self._partly()


def _bridge(
    adapter: _PartlyAdapter,
) -> tuple[CollaborationCore, list[dict[str, str]], list[str]]:
    core = object.__new__(CollaborationCore)
    core._bridge_type = "mattermost"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[assignment]
    core._human_user_ids = set()  # type: ignore[assignment]
    core._workspace_consumer_transport_user_id = "@bridge:switch.local"  # type: ignore[assignment]
    core._find_channel = lambda **_kwargs: "C1"  # type: ignore[assignment]
    core._channel_to_room = {"C1": ("room-uuid", "!r:switch.local")}  # type: ignore[assignment]
    core._room_tenant = _tenant  # type: ignore[assignment]
    recorded = posting_without_a_database(core)
    released: list[str] = []
    release = core._release_outbound

    async def recording_release(transport_event_id: str) -> None:
        released.append(transport_event_id)
        await release(transport_event_id)

    core._release_outbound = recording_release  # type: ignore[method-assign]
    core._outbound_thread_root_ref = _none  # type: ignore[assignment]
    return core, recorded, released


async def _none(*_args: Any, **_kwargs: Any) -> None:
    return None


async def _tenant(*_args: Any, **_kwargs: Any) -> str:
    return "tenant-1"


def _event(*, admin: bool) -> InboundMessage:
    content: dict[str, Any] = {}
    if admin:
        content[ADMIN_MARKER] = {"type": "command_result"}
    return InboundMessage(
        room_id="!r:switch.local",
        event_id="$long",
        sender="@someone:switch.local",
        timestamp=1700000000000,
        content=content,
        body="a long reply",
        sender_name=None if admin else "scout",
    )


async def test_an_agent_message_sent_in_part_is_recorded_by_its_first_part() -> None:
    adapter = _PartlyAdapter()
    core, recorded, released = _bridge(adapter)

    await core.handle_outbound_message(RoomRef("!r:switch.local"), _event(admin=False))

    assert adapter.calls == 1
    assert released == []
    assert recorded == [
        {
            "external_channel_id": "C1",
            "transport_event_id": "$long",
            "external_post_id": "post-1",
        }
    ]


async def test_an_admin_message_sent_in_part_is_recorded_by_its_first_part() -> None:
    adapter = _PartlyAdapter()
    core, recorded, released = _bridge(adapter)

    await core.handle_outbound_message(RoomRef("!r:switch.local"), _event(admin=True))

    assert released == []
    assert [r["external_post_id"] for r in recorded] == ["post-1"]
