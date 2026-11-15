"""The heads-up for a message that tags an agent not in the room, or a role
nobody live-holds, is posted by the process that wrote the message once it
has committed (`clients/mention_warnings.py`), and a message that tags only
the room's agents is not checked at all."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.admin_messages import AdminMessageType, admin_extra_content
from switch_core.clients.mention_warnings import MentionWarnings
from switch_core.db.models import TENANT_ZERO_ID
from tests.routing import add_member, make_agent, make_person, make_room, process_on

SessionFactory = async_sessionmaker[AsyncSession]


class _Admin:
    """Switch's admin actor, recording what it would post."""

    def __init__(self) -> None:
        self.posted: list[dict[str, Any]] = []

    async def send_admin(
        self,
        room_id: str,
        body: str,
        *,
        message_type: AdminMessageType,
        thread_root_id: str | None,
        mentions: list[str] | None = None,
    ) -> None:
        self.posted.append(
            {
                "room_id": room_id,
                "body": body,
                "type": message_type,
                "thread_root_id": thread_root_id,
            }
        )


def _checks(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The messages a heads-up check ran for."""
    ran: list[str] = []
    check = MentionWarnings.check

    async def recording(self: MentionWarnings, room: Any, event: Any, *a: Any) -> None:
        ran.append(event.body)
        await check(self, room, event, *a)

    monkeypatch.setattr(MentionWarnings, "check", recording)
    return ran


async def test_tagging_an_agent_not_in_the_room_is_warned_by_the_writer(
    session_factory: SessionFactory,
) -> None:
    here = process_on(session_factory)
    admin = _Admin()
    here.router.use_admin(
        lambda tenant_id: admin if tenant_id == TENANT_ZERO_ID else None  # type: ignore[return-value]
    )
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    helper, helper_client = await make_agent(session_factory, "helper")
    await make_agent(session_factory, "absentee")
    await add_member(session_factory, room, helper_client, agent=helper)
    await add_member(session_factory, room, alice)

    event_id = await here.say(room, "@helper and @absentee, a look?", sender=alice)
    await here.idle()

    assert [posted["type"] for posted in admin.posted] == [
        AdminMessageType.ABSENT_AGENT
    ]
    assert "absentee" in admin.posted[0]["body"]
    assert admin.posted[0]["room_id"] == room.transport_room_id
    assert admin.posted[0]["thread_root_id"] == event_id


async def test_tagging_only_the_rooms_agents_is_not_checked(
    session_factory: SessionFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    here = process_on(session_factory)
    admin = _Admin()
    here.router.use_admin(lambda _tenant_id: admin)  # type: ignore[arg-type,return-value]
    ran = _checks(monkeypatch)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    for name in ("helper", "reviewer"):
        agent, client = await make_agent(session_factory, name)
        await add_member(session_factory, room, client, agent=agent)
    await add_member(session_factory, room, alice)

    await here.say(room, "@helper and @Reviewer, a look?", sender=alice)
    await here.idle()

    # The agents' offline notices tag alice, a person, so those are checked.
    assert "@helper and @Reviewer, a look?" not in ran
    assert admin.posted == []


async def test_switchs_own_messages_are_not_checked(
    session_factory: SessionFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    here = process_on(session_factory)
    admin = _Admin()
    here.router.use_admin(lambda _tenant_id: admin)  # type: ignore[arg-type,return-value]
    ran = _checks(monkeypatch)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await make_agent(session_factory, "absentee")
    await add_member(session_factory, room, alice)

    await here.say(
        room,
        "@alice @absentee is not in this room",
        sender=alice,
        extra_content=admin_extra_content(AdminMessageType.ABSENT_AGENT),
    )
    await here.idle()

    assert ran == []
    assert admin.posted == []
