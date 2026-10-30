"""Every follow-the-conversation journey, end to end through the router.

The rule tests (`test_conversation.py`) call the decision directly. These
write each message the way production does, through a client's transport, so
the router (`delivery/router.py`) decides it as it is written. The assertion
is what each agent was given: an own event for the message in
`agent_events`, read back from the database.

So if the rules are ever unhooked from the router, these fail. One test per
journey, mirroring the end-to-end demo.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import ColumnElement, func, select, update

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.commands import (
    _cmd_assign_agent,
    _cmd_follow_ups,
    _cmd_unassign_agent,
)
from switch_core.clients.admin_messages import ADMIN_MARKER, AUTO_REPLY_FLAG
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.models import AgentEventRow, Client, ClientRoom, Message, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.conversation import ConversationSettings
from switch_core.transport import RoomRef
from tests.routing import Process, process_on
from tests.switch_core.delivery.world import World


class Journey:
    """The world's room, written to through a process's router.

    `say` writes a message as a person or an agent and returns its event id;
    `reached` says which agents were given it. `at` is seconds into the
    journey: before each write, the rows already written are moved back in
    time so the gaps between them are the ones the test gives.
    """

    def __init__(self, world: World, settings: ConversationSettings) -> None:
        self.world = world
        self.settings = settings
        self.process: Process
        self.room: Room
        self.clients: dict[str, Client] = {}
        self.at: dict[str, float] = {}
        self.notices: list[str] = []

    async def start(self) -> Journey:
        world = self.world
        self.process = process_on(world.session_factory, conversation=self.settings)
        async with world.session_factory() as session:
            room = await RoomStore().get(session, world.room_id)
            assert room is not None
            self.room = room
            for name in (*world.agents, "alice", "bob", "admin"):
                client = await ClientStore().get_by_transport_user_id(
                    session, world.mxid(name)
                )
                assert client is not None
                self.clients[name] = client
                session.add(ClientRoom(client_id=client.id, room_id=room.id))
            await session.commit()
        return self

    async def _set_the_clock(self, at: float) -> None:
        async with self.world.session_factory() as session:
            for event_id, then in self.at.items():
                await session.execute(
                    update(Message)
                    .where(Message.transport_event_id == event_id)
                    .values(sent_at=_seconds_ago(at - then))
                )
            await session.commit()

    async def say(
        self,
        who: str,
        body: str,
        *,
        at: float,
        thread: str | None = None,
        **content: object,
    ) -> str:
        """Write a message as `who`, `at` seconds in, and return its event id."""
        await self._set_the_clock(at)
        event_id = await self.process.say(
            self.room,
            body,
            sender=self.clients[who],
            thread_root_id=thread,
            extra_content=content or None,
        )
        self.at[event_id] = at
        await self.process.idle()
        return event_id

    post = say

    async def reached(self, event_id: str) -> set[str]:
        """The agents given `event_id` as one of their own events."""
        ids = {agent.id: name for name, agent in self.world.agents.items()}
        async with self.world.session_factory() as session:
            agent_ids = (
                await session.scalars(
                    select(AgentEventRow.agent_id).where(
                        AgentEventRow.message_key == event_id
                    )
                )
            ).all()
        return {ids[agent_id] for agent_id in agent_ids}

    async def auto_replies(self, who: str) -> list[str]:
        """What Switch has posted on `who`'s behalf: refusals and notices."""
        async with self.world.session_factory() as session:
            rows = (
                await session.scalars(
                    select(Message).where(
                        Message.room_id == self.room.id,
                        Message.sender_id == self.world.mxid(who),
                    )
                )
            ).all()
        return [row.body or "" for row in rows if AUTO_REPLY_FLAG in row.content]

    # ── Room commands, run by the Switch app ────────────────────────────────

    def _host(self, at: float) -> SimpleNamespace:
        world = self.world

        async def _resolve_room_meta(_transport_room_id: str) -> RoomMeta:
            return RoomMeta(room_id=world.room_id, name="room")

        async def _reply_command(_room: str, body: str, **_kw: object) -> None:
            self.notices.append(body)
            await self.say(
                "admin", body, at=at, **{ADMIN_MARKER: {"type": "command_result"}}
            )

        return SimpleNamespace(
            session_factory=world.session_factory,
            _resolve_room_meta=_resolve_room_meta,
            reply_command=_reply_command,
            _room_store=RoomStore(),
            _agent_store=AgentStore(),
            _room_role_store=RoomRoleStore(),
            _external_user_store=ExternalUserStore(),
            client_store=ClientStore(),
            _connections=SimpleNamespace(live_connection_ids=lambda: set()),
            _follow_the_conversation_enabled=True,
        )

    async def command(self, who: str, command: str, args: str, *, at: float) -> str:
        """Run a room command as `who`; return Switch's reply."""
        handlers = {
            "assign-agent": _cmd_assign_agent,
            "unassign-agent": _cmd_unassign_agent,
            "follow-ups": _cmd_follow_ups,
        }
        event = SimpleNamespace(
            command=command, args=args, thread_id=None, user_id=self.world.mxid(who)
        )
        await handlers[command](
            self._host(at),  # type: ignore[arg-type]
            RoomRef(room_id=self.room.transport_room_id),
            event,  # type: ignore[arg-type]
            False,
        )
        return self.notices[-1]


def _seconds_ago(seconds: float) -> ColumnElement[datetime]:
    return func.now() - timedelta(seconds=seconds)


ON = ConversationSettings(enabled=True, window_seconds=300)


@pytest.fixture
async def room(world: World) -> Journey:
    return await Journey(world, ON).start()


async def _owner_only(world: World, agent: str) -> None:
    """Make `agent` answer only its owner, who has claimed alice, not bob."""
    async with world.session_factory() as session:
        row = await AgentStore().get(session, world.agents[agent].id)
        assert row is not None
        row.addressing_policy = owner_only_policy([]).model_dump(mode="json")
        await session.commit()


class TestJourneys:
    async def test_1_a_mention_works_as_today(self, room: Journey) -> None:
        told = await room.say("alice", "@helper what does just up do?", at=0)

        assert await room.reached(told) == {"helper"}

    async def test_2_a_reply_in_the_agents_thread_reaches_it(
        self, room: Journey
    ) -> None:
        await room.say("alice", "@helper what does just up do?", at=0)
        answer = await room.post("helper", "It starts the stack", at=5)

        told = await room.say("alice", "why two database roles?", at=30, thread=answer)

        assert await room.reached(told) == {"helper"}

    async def test_3_in_a_thread_a_mention_still_wins(self, room: Journey) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)

        told = await room.say(
            "alice", "@reviewer what do you think?", at=30, thread=answer
        )

        assert await room.reached(told) == {"reviewer"}

    async def test_4_the_agent_that_spoke_last_owns_the_thread(
        self, room: Journey
    ) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)
        await room.say("alice", "@reviewer what do you think?", at=10, thread=answer)
        await room.post("reviewer", "One nit", at=20, thread=answer)

        told = await room.say("alice", "which nit?", at=30, thread=answer)

        assert await room.reached(told) == {"reviewer"}

    async def test_5_thanks_wakes_nobody(self, room: Journey) -> None:
        answer = await room.post("helper", "Done", at=0)

        told = await room.say("alice", "thanks!", at=30, thread=answer)

        assert await room.reached(told) == set()

    async def test_6_the_next_channel_message_reaches_the_agent(
        self, room: Journey
    ) -> None:
        await room.say("alice", "@helper what does just migrate do?", at=0)
        await room.post("helper", "It applies migrations", at=10)
        first = await room.say("alice", "and what does just down do?", at=40)
        await room.post("helper", "It stops the stack", at=50)
        second = await room.say("alice", "and just reset?", at=80)

        assert await room.reached(first) == {"helper"}
        assert await room.reached(second) == {"helper"}

    async def test_7_it_stops_when_someone_else_speaks(self, room: Journey) -> None:
        await room.say("alice", "@helper where is addressing decided?", at=0)
        await room.post("helper", "In delivery/addressing.py", at=10)
        bob = await room.say("bob", "lunch at 1 anyone?", at=20)
        told = await room.say("alice", "and which file has the tests?", at=30)

        assert await room.reached(bob) == set()
        assert await room.reached(told) == set()

    async def test_8_it_stops_after_the_window(self, room: Journey) -> None:
        await room.say("alice", "@helper what port does the gateway use?", at=0)
        await room.post("helper", "5173", at=10)

        told = await room.say("alice", "and the Teams port?", at=10 + 301)

        assert await room.reached(told) == set()

    async def test_9_a_question_to_the_room_reaches_nobody(self, room: Journey) -> None:
        told = await room.say("bob", "anyone know why the deploy failed?", at=0)

        assert await room.reached(told) == set()

    async def test_10_a_follow_up_from_someone_not_allowed_is_dropped_quietly(
        self, world: World, room: Journey
    ) -> None:
        await _owner_only(world, "helper")
        answer = await room.post("helper", "It starts the stack", at=0)

        from_bob = await room.say("bob", "hello? are you there?", at=30, thread=answer)
        from_alice = await room.say("alice", "why?", at=40, thread=answer)

        assert await room.reached(from_bob) == set()
        assert await room.reached(from_alice) == {"helper"}
        refusals = await room.auto_replies("helper")
        assert not any(
            "not permitted" in body or "only take" in body for body in refusals
        )

    async def test_11_after_assign_agent_every_message_reaches_it(
        self, room: Journey
    ) -> None:
        reply = await room.command("alice", "assign-agent", "@helper", at=0)
        question = await room.say("bob", "anyone know why the deploy failed?", at=10)
        chat = await room.say("alice", "morning all", at=20)

        assert reply.startswith("From now on, every message here goes to")
        assert await room.reached(question) == {"helper"}
        assert await room.reached(chat) == {"helper"}

    async def test_12_with_an_assigned_agent_a_mention_still_wins(
        self, room: Journey
    ) -> None:
        await room.command("alice", "assign-agent", "@helper", at=0)

        told = await room.say("alice", "@reviewer can you look at my PR?", at=10)

        assert await room.reached(told) == {"reviewer"}

    async def test_13_follow_ups_off_then_on(self, room: Journey) -> None:
        answer = await room.post("helper", "It runs the tests", at=0)

        off = await room.command("alice", "follow-ups", "off", at=10)
        while_off = await room.say(
            "alice", "how long does it take?", at=20, thread=answer
        )
        on = await room.command("alice", "follow-ups", "on", at=30)
        while_on = await room.say(
            "alice", "which tests are slow?", at=40, thread=answer
        )

        assert "Follow-ups are **off**" in off
        assert await room.reached(while_off) == set()
        assert "Follow-ups are **on**" in on
        assert await room.reached(while_on) == {"helper"}

    async def test_14_unassign_and_a_refused_assign(
        self, world: World, room: Journey
    ) -> None:
        await room.command("alice", "assign-agent", "@helper", at=0)
        unassigned = await room.command("alice", "unassign-agent", "", at=10)
        question = await room.say("bob", "has anyone seen the build logs?", at=20)
        await _owner_only(world, "reviewer")
        refused = await room.command("bob", "assign-agent", "@reviewer", at=30)
        after = await room.say("bob", "can someone check the release notes?", at=40)

        assert "is no longer assigned" in unassigned
        assert await room.reached(question) == set()
        assert refused.startswith("You can't assign")
        assert await room.reached(after) == set()


class TestWithTheFlagOff:
    async def test_nothing_changes(self, world: World) -> None:
        room = await Journey(
            world, ConversationSettings(enabled=False, window_seconds=300)
        ).start()
        await room.say("alice", "@helper what does just migrate do?", at=0)
        answer = await room.post("helper", "It applies migrations", at=10)

        in_thread = await room.say("alice", "why?", at=20, thread=answer)
        in_channel = await room.say("alice", "and just down?", at=30)

        assert await room.reached(in_thread) == set()
        assert await room.reached(in_channel) == set()


class TestAgentsDoNotSetEachOtherOff:
    async def test_an_agent_reply_in_a_thread_reaches_no_other_agent(
        self, room: Journey
    ) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)
        await room.say("alice", "@reviewer thoughts?", at=10, thread=answer)

        told = await room.say("reviewer", "Looks right to me", at=20, thread=answer)

        assert await room.reached(told) == set()

    async def test_switchs_own_notices_reach_nobody(self, room: Journey) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)

        told = await room.say(
            "helper",
            "Starting a session…",
            at=10,
            thread=answer,
            **{AUTO_REPLY_FLAG: True},
        )

        assert await room.reached(told) == set()


class TestReviewFixesThroughTheClients:
    async def test_no_unavailable_notice_for_a_follow_up(self, room: Journey) -> None:
        # The agents here have no session. A mention gets the usual notice;
        # a follow-up is delivered without one.
        await room.say("alice", "@helper what does just up do?", at=0)
        notices_after_mention = len(await room.auto_replies("helper"))
        assert notices_after_mention == 1  # the mention did get a notice
        answer = await room.post("helper", "It starts the stack", at=5)

        told = await room.say("alice", "why two database roles?", at=30, thread=answer)

        assert await room.reached(told) == {"helper"}
        assert len(await room.auto_replies("helper")) == notices_after_mention

    async def test_a_follow_up_with_an_email_address_in_it(self, room: Journey) -> None:
        answer = await room.post("helper", "Who should I send it to?", at=0)

        told = await room.say(
            "alice", "send it to ops@example.com", at=30, thread=answer
        )

        assert await room.reached(told) == {"helper"}

    async def test_switching_agents_ends_the_exchange(self, room: Journey) -> None:
        await room.say("alice", "@helper do X", at=0)
        await room.post("helper", "Done X", at=10)
        await room.say("alice", "@reviewer check Y", at=20)

        told = await room.say("alice", "it's in PR 12", at=30)

        assert await room.reached(told) == set()


class TestCommandsWhileTheFlagIsOff:
    async def test_they_say_so_and_change_nothing(self, world: World) -> None:
        room = await Journey(world, ON).start()
        host = room._host(at=0)
        host._follow_the_conversation_enabled = False
        replies: list[str] = []

        async def _reply_command(_room: str, body: str, **_kw: object) -> None:
            replies.append(body)

        host.reply_command = _reply_command
        for command, args in (
            ("assign-agent", "@helper"),
            ("follow-ups", "off"),
            ("unassign-agent", ""),
        ):
            event = SimpleNamespace(
                command=command, args=args, thread_id=None, user_id=world.mxid("alice")
            )
            handler = {
                "assign-agent": _cmd_assign_agent,
                "follow-ups": _cmd_follow_ups,
                "unassign-agent": _cmd_unassign_agent,
            }[command]
            await handler(
                host, RoomRef(room_id=room.room.transport_room_id), event, False
            )  # type: ignore[arg-type]

        assert len(replies) == 3
        assert all("isn't switched on for this Switch server" in r for r in replies)
        async with world.session_factory() as session:
            assert await RoomStore().main_agent_id(session, world.room_id) is None
            assert await RoomStore().follow_ups_enabled(session, world.room_id)


class TestReadOnceForTheRoom:
    """What the rules read is read once per message, whatever the number of
    agents, and not at all when the room's settings or a mention settle it."""

    def _count(self, room: Journey) -> dict[str, int]:
        store = room.process.router._conversation.message_store
        calls = {"thread": 0, "channel": 0}
        thread, channel = (
            store.list_thread_newest_first,
            store.list_top_level_newest_first,
        )

        async def counted_thread(*args: Any, **kwargs: Any) -> Any:
            calls["thread"] += 1
            return await thread(*args, **kwargs)

        async def counted_channel(*args: Any, **kwargs: Any) -> Any:
            calls["channel"] += 1
            return await channel(*args, **kwargs)

        store.list_thread_newest_first = counted_thread  # type: ignore[method-assign]
        store.list_top_level_newest_first = counted_channel  # type: ignore[method-assign]
        return calls

    async def test_one_read_for_every_agent_in_the_room(self, room: Journey) -> None:
        answer = await room.post("helper", "It starts the stack", at=0)
        calls = self._count(room)

        await room.say("alice", "why?", at=10, thread=answer)
        await room.say("alice", "morning all", at=20)

        assert calls == {"thread": 1, "channel": 1}

    async def test_none_when_follow_ups_are_off(self, room: Journey) -> None:
        await room.command("alice", "follow-ups", "off", at=0)
        calls = self._count(room)

        await room.say("bob", "anyone know why the deploy failed?", at=10)

        assert calls == {"thread": 0, "channel": 0}

    async def test_none_for_a_mention(self, room: Journey) -> None:
        calls = self._count(room)

        await room.say("alice", "@helper what does just up do?", at=0)
        await room.say("alice", "cc @bob", at=10)

        assert calls == {"thread": 0, "channel": 0}
