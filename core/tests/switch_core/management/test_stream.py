"""The controller's one stream: its agents' events, merged, and the nudges.

Against Postgres, through the real routes and Core's real connection registry
and event buffer. The stream itself is read from the route's own response,
since the in-process HTTP transport would wait for a stream that never ends.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import room_control_frame
from switch_core.bridges.agent.protocol.agent_detail import assemble_agent_detail
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.bridges.agent.protocol.presence import (
    agents_present_in,
    rooms_occupied,
)
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.management import controller_routes
from switch_core.management.notifier import (
    ASSIGNMENT_CHANGED,
    CREDENTIAL_REVOKED,
    OPERATION_PENDING,
    PROVIDER_CREDENTIAL_CHANGED,
    ControllerNotifier,
)
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    add_room,
    build_harness,
    cookies_for,
    enroll_console,
    open_connection,
    open_stream,
    parse_frame,
    place_agent,
    provider,
    report_status,
    take,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _message(room_id: str, body: str, *, addressed: bool) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        payload=MessagePayload(
            addressed=addressed,
            sender="@ada:test",
            sender_name="Ada",
            message_id=f"$event-{body}",
            body=body,
            timestamp=0,
        ),
    )


class TestTheNotifier:
    def test_signals_coalesce_and_revocation_comes_last(self) -> None:
        notifier = ControllerNotifier()
        subscription = notifier.subscribe("c1")
        notifier.credential_revoked("c1")
        notifier.assignment_changed("c1", 3)
        notifier.assignment_changed("c1", 5)
        notifier.assignment_changed("c1", 4)
        notifier.operation_pending(
            "c1", operation_id="o1", kind="agent.restart", agent_id="a"
        )
        notifier.provider_credential_changed("c1", "claude", 2)
        notifier.provider_credential_changed("c1", "claude", 3)
        notifier.provider_credential_changed("c1", "claude", 1)
        notifier.assignment_changed("c2", 9)

        assert subscription.wake.is_set()
        assert subscription.drain() == [
            (ASSIGNMENT_CHANGED, {"revision": 5}),
            (
                OPERATION_PENDING,
                {"operation_id": "o1", "kind": "agent.restart", "agent_id": "a"},
            ),
            (PROVIDER_CREDENTIAL_CHANGED, {"provider": "claude", "revision": 3}),
            (CREDENTIAL_REVOKED, {}),
        ]
        assert not subscription.wake.is_set()
        assert subscription.drain() == []

    def test_every_open_stream_hears_and_a_closed_one_is_forgotten(self) -> None:
        notifier = ControllerNotifier()
        first = notifier.subscribe("c1")
        second = notifier.subscribe("c1")
        notifier.assignment_changed("c1", 1)
        assert (
            first.drain() == second.drain() == [(ASSIGNMENT_CHANGED, {"revision": 1})]
        )
        first.close()
        second.close()
        assert notifier.subscriber_count("c1") == 0


class TestOpening:
    async def test_open_names_the_bound_agents_and_the_stream_attaches_them(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            opened = await open_connection(client, controller)
        assert opened["agents"] == [agent_id]
        assert opened["heartbeat_interval_s"] == 2.0

        stream = await open_stream(harness, controller, opened)
        (state, attached) = await take(stream, 2)
        await stream.aclose()

        assert state == (
            "connection_state",
            {
                "controller_id": controller.controller_id,
                "assignment_revision": 1,
                "report_within_s": 60,
                "connection_id": opened["connection_id"],
                "generation": opened["generation"],
                "heartbeat_interval_s": 2.0,
            },
        )
        assert attached == (
            "agent.attached",
            {"agent_id": agent_id, "from_seq": 0, "rooms": [room_id]},
        )

    async def test_events_resume_from_the_cursor_tagged_with_their_agent(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        buffer = harness.protocol.event_buffer
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            first = await place_agent(client, controller, name="first")
            second = await place_agent(client, controller, name="second")
            room_id = await add_room(harness.session_factory, first, second)
            for body in ("one", "two", "three"):
                buffer.enqueue(first, room_id, _message(room_id, body, addressed=False))
            buffer.enqueue(second, room_id, _message(room_id, "hi", addressed=True))
            opened = await open_connection(client, controller, {first: 1})

        stream = await open_stream(harness, controller, opened)
        frames = await take(stream, 5)
        await stream.aclose()

        attached = {
            data["agent_id"]: data for name, data in frames if name == "agent.attached"
        }
        # The first resumes where it asked; the second asked nothing and
        # starts at its head.
        assert attached[first]["from_seq"] == 1
        assert attached[second]["from_seq"] == 1
        events = [
            (d["agent_id"], d["seq"], d["event"])
            for n, d in frames
            if n == "agent.event"
        ]
        assert [(agent, seq) for agent, seq, _ in events] == [(first, 2), (first, 3)]
        bodies = [event["payload"]["body"] for _, _, event in events]
        assert bodies == ["two", "three"]
        assert all(event["sequence"] == seq for _, seq, event in events)

    async def test_an_addressed_event_carries_the_missed_count(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        buffer = harness.protocol.event_buffer
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            opened = await open_connection(client, controller)

        stream = await open_stream(harness, controller, opened)
        await take(stream, 2)
        buffer.enqueue(agent_id, room_id, _message(room_id, "chatter", addressed=False))
        buffer.enqueue(agent_id, room_id, _message(room_id, "more", addressed=False))
        buffer.enqueue(agent_id, room_id, _message(room_id, "@you", addressed=True))
        frames = await take(stream, 3)
        await stream.aclose()

        assert [data["event"].get("missed") for _, data in frames] == [
            None,
            None,
            {"count": 2, "reason": None},
        ]

    async def test_a_cursor_from_before_a_restart_is_a_gap(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            opened = await open_connection(client, controller, {agent_id: 900})

        stream = await open_stream(harness, controller, opened)
        frames = await take(stream, 3)
        await stream.aclose()

        assert frames[1] == (
            "agent.attached",
            {"agent_id": agent_id, "from_seq": 0, "rooms": [room_id]},
        )
        name, gap = frames[2]
        assert name == "agent.gap"
        assert gap["agent_id"] == agent_id
        assert gap["all_rooms"] is True
        assert gap["rooms"] == [room_id]

    async def test_an_overflowed_cursor_is_a_gap_naming_the_rooms(
        self, harness: Harness
    ) -> None:
        harness.protocol.event_buffer = EventBuffer(
            sequence_base=0, max_events_per_agent=2
        )
        buffer = harness.protocol.event_buffer
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            for body in ("a", "b", "c", "d"):
                buffer.enqueue(
                    agent_id, room_id, _message(room_id, body, addressed=False)
                )
            opened = await open_connection(client, controller, {agent_id: 0})

        stream = await open_stream(harness, controller, opened)
        frames = await take(stream, 5)
        await stream.aclose()

        name, gap = frames[2]
        assert name == "agent.gap"
        assert (gap["rooms"], gap["all_rooms"], gap["resumed_at"]) == (
            [room_id],
            False,
            2,
        )
        assert [d["seq"] for n, d in frames[3:]] == [3, 4]


class TestLiveChanges:
    async def test_placing_and_moving_an_agent_attach_and_detach_it_live(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            first = await enroll_console(harness, client, owner, "one")
            second = await enroll_console(harness, client, owner, "two")
            await report_status(client, second, 1, providers=[provider("claude")])
            opened = await open_connection(client, first)
            stream = await open_stream(harness, first, opened)
            assert [name for name, _ in await take(stream, 1)] == ["connection_state"]

            agent_id = await place_agent(client, first, name="reviewer")
            arrived = await take(stream, 2)
            moved = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"controller_id": second.controller_id},
                cookies=cookies_for(owner),
            )
            assert moved.status_code == 200, moved.text
            departed = await take(stream, 2)
        await stream.aclose()

        assert sorted(name for name, _ in arrived) == [
            "agent.attached",
            "assignment.changed",
        ]
        assert (
            "agent.detached",
            {"agent_id": agent_id, "reason": "unassigned"},
        ) in departed
        assert "assignment.changed" in [name for name, _ in departed]

    async def test_deleting_the_agent_detaches_it_as_deleted(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            opened = await open_connection(client, controller)
        stream = await open_stream(harness, controller, opened)
        await take(stream, 2)

        await harness.management.agent_removed(TENANT_ZERO_ID, agent_id)
        frames = await take(stream, 2)
        await stream.aclose()

        assert ("agent.detached", {"agent_id": agent_id, "reason": "deleted"}) in frames

    async def test_a_room_joined_is_told_as_agent_rooms(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            first_room = await add_room(harness.session_factory, agent_id)
            opened = await open_connection(client, controller)
        stream = await open_stream(harness, controller, opened)
        await take(stream, 2)

        second_room = await add_room(harness.session_factory, agent_id, name="new")
        harness.protocol.connections.controllers.room_joined(agent_id, second_room)
        (frame,) = await take(stream, 1)
        await stream.aclose()

        assert frame == (
            "agent.rooms",
            {"agent_id": agent_id, "rooms": sorted([first_room, second_room])},
        )

    async def test_a_session_command_reaches_the_stream_with_its_room(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            opened = await open_connection(client, controller)
        stream = await open_stream(harness, controller, opened)
        await take(stream, 2)

        command = room_control_frame(
            agent_id=agent_id,
            session_id=None,
            room_id=room_id,
            action="reset",
            actor_id="@ada:test",
            message_id="$reset",
            thread_id=None,
            surface="slack",
            requester_name="Ada",
        )
        assert harness.protocol.connections.relay_session_command(agent_id, command)
        (frame,) = await take(stream, 1)
        await stream.aclose()

        assert frame == (
            "agent.session_command",
            {"agent_id": agent_id, "room_id": room_id, "command": command},
        )

    async def test_the_nudges_are_merged_and_revocation_ends_the_stream(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 1)
            notifier = harness.management.service.notifier
            notifier.operation_pending(
                controller.controller_id,
                operation_id="o1",
                kind="provider.recheck",
                agent_id=None,
            )
            pending = await take(stream, 1)
            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            assert revoked.status_code == 200, revoked.text
            final = await take(stream, 1)
            with pytest.raises(StopAsyncIteration):
                await anext(stream)

        assert pending == [
            (
                "operation.pending",
                {"operation_id": "o1", "kind": "provider.recheck", "agent_id": None},
            )
        ]
        assert final == [("credential.revoked", {})]
        assert notifier.subscriber_count(controller.controller_id) == 0


class TestTheConnection:
    async def test_reopening_takes_over_and_fences_the_old_connection(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            old = await open_connection(client, controller)
            old_stream = await open_stream(harness, controller, old)
            await take(old_stream, 1)
            new = await open_connection(client, controller)
            evicted = await take(old_stream, 1)
            with pytest.raises(StopAsyncIteration):
                await anext(old_stream)
            beat_path = f"/v1/controllers/{controller.controller_id}/connection/beat"
            stale = await client.post(
                beat_path,
                json={
                    "connection_id": old["connection_id"],
                    "generation": old["generation"],
                    "cursors": {},
                },
                headers=controller.headers,
            )
            wrong_generation = await client.post(
                beat_path,
                json={
                    "connection_id": new["connection_id"],
                    "generation": new["generation"] + 1,
                    "cursors": {},
                },
                headers=controller.headers,
            )
            unknown = await client.post(
                beat_path,
                json={
                    "connection_id": "nope",
                    "generation": 1,
                    "cursors": {},
                },
                headers=controller.headers,
            )
            no_stream = await client.post(
                beat_path,
                json={
                    "connection_id": new["connection_id"],
                    "generation": new["generation"],
                    "cursors": {},
                },
                headers=controller.headers,
            )
            old_events = await client.get(
                f"/v1/controllers/{controller.controller_id}/events",
                params={
                    "connection_id": old["connection_id"],
                    "generation": old["generation"],
                },
                headers=controller.headers,
            )

        assert new["generation"] != old["generation"]
        assert evicted[0][0] == "evicted"
        assert evicted[0][1]["code"] == "taken_over"
        assert (stale.status_code, stale.json()["error"]["code"]) == (409, "taken_over")
        assert (
            wrong_generation.status_code,
            wrong_generation.json()["error"]["code"],
        ) == (
            409,
            "stale_generation",
        )
        assert (unknown.status_code, unknown.json()["error"]["code"]) == (
            404,
            "unknown_connection",
        )
        assert (no_stream.status_code, no_stream.json()["error"]["code"]) == (
            409,
            "no_stream",
        )
        assert (old_events.status_code, old_events.json()["error"]["code"]) == (
            409,
            "taken_over",
        )

    async def test_a_beat_keeps_its_agents_live_and_confirms_cursors(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        buffer = harness.protocol.event_buffer
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            buffer.enqueue(agent_id, room_id, _message(room_id, "one", addressed=False))
            opened = await open_connection(client, controller)
            assert not presence.is_live(agent_id)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 2)
            beat = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection/beat",
                json={
                    "connection_id": opened["connection_id"],
                    "generation": opened["generation"],
                    "cursors": {agent_id: 99, "not-mine": 3},
                },
                headers=controller.headers,
            )
        live = presence.is_live(agent_id)
        await stream.aclose()

        assert beat.status_code == 200, beat.text
        assert beat.json() == {"agents": [agent_id]}
        assert live
        binding = presence.binding(agent_id)
        assert binding is not None
        assert buffer._cursors[agent_id][presence.holder_id(binding)] == 1
        assert not presence.is_live(agent_id)

    async def test_a_reattached_stream_resumes_from_the_confirmed_cursors(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        buffer = harness.protocol.event_buffer
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            confirmed = await place_agent(client, controller, name="confirmed")
            unconfirmed = await place_agent(client, controller, name="unconfirmed")
            room_id = await add_room(harness.session_factory, confirmed, unconfirmed)
            for body in ("one", "two", "three"):
                buffer.enqueue(
                    confirmed, room_id, _message(room_id, body, addressed=False)
                )
            buffer.enqueue(
                unconfirmed, room_id, _message(room_id, "x", addressed=False)
            )
            opened = await open_connection(client, controller, {confirmed: 0})
            first = await open_stream(harness, controller, opened)
            # state, two attaches, three events for `confirmed`
            await take(first, 6)
            beat = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection/beat",
                json={
                    "connection_id": opened["connection_id"],
                    "generation": opened["generation"],
                    "cursors": {confirmed: 2},
                },
                headers=controller.headers,
            )
            assert beat.status_code == 200, beat.text
            # The socket drops; events keep arriving; the same connection is
            # streamed again.
            buffer.enqueue(
                unconfirmed, room_id, _message(room_id, "y", addressed=False)
            )
            second = await open_stream(harness, controller, opened)
            # The first stream may finish the pass it was on, then sees it
            # was displaced and ends.
            displaced = [parse_frame(raw) async for raw in first]
            frames = await take(second, 5)
        await second.aclose()

        assert displaced[-1][0] == "evicted"
        assert displaced[-1][1]["code"] == "taken_over"
        attached = {
            d["agent_id"]: d["from_seq"] for n, d in frames if n == "agent.attached"
        }
        # Where the beat confirmed it, not where the open asked.
        assert attached[confirmed] == 2
        # Where the first stream attached it, so nothing that arrived while
        # the socket was down is skipped.
        assert attached[unconfirmed] == 1
        events = [(d["agent_id"], d["seq"]) for n, d in frames if n == "agent.event"]
        assert sorted(events) == sorted([(confirmed, 3), (unconfirmed, 2)])

    async def test_a_connected_agent_is_present_in_its_member_rooms_only(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        connections = harness.protocol.connections
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            here = await add_room(harness.session_factory, agent_id, name="here")
            there = await add_room(harness.session_factory, agent_id, name="there")
            outside = await add_room(harness.session_factory, name="outside")
            opened = await open_connection(client, controller)
            before_stream = rooms_occupied(agent_id, connections)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 2)
            connected = rooms_occupied(agent_id, connections)
            present_outside = agents_present_in([agent_id], outside, connections)
            promised = connections.can_spawn_for(agent_id, here)
        await stream.aclose()

        assert before_stream == set()
        assert connected == {here, there}
        assert present_outside == set()
        assert promised is False
        assert rooms_occupied(agent_id, connections) == set()

    async def test_the_agent_detail_shows_one_session_while_connected(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            await add_room(harness.session_factory, agent_id, name="here")
            await add_room(harness.session_factory, agent_id, name="there")
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 2)

            async def sessions() -> list[dict[str, object]]:
                async with harness.session_factory() as session:
                    agent = await AgentStore().get(session, agent_id)
                    assert agent is not None
                    detail = await assemble_agent_detail(
                        session,
                        agent=agent,
                        agent_store=AgentStore(),
                        room_store=RoomStore(),
                        user_store=UserStore(),
                        agent_session_store=AgentSessionStore(),
                        room_role_store=RoomRoleStore(),
                        connections=harness.protocol.connections,
                    )
                return [s.model_dump(exclude={"last_seen_at"}) for s in detail.sessions]

            connected = await sessions()
        await stream.aclose()
        lapsed = await sessions()

        assert connected == [
            {
                "room_id": None,
                "room_name": None,
                "lifecycle": "controller",
                "state": "live",
                "controller_id": controller.controller_id,
            }
        ]
        assert lapsed == []

    async def test_a_lapsed_beat_ends_the_stream_and_its_agents_are_not_live(
        self, harness: Harness, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(controller_routes, "KEEPALIVE_INTERVAL_SECONDS", 0.05)
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            opened = await open_connection(client, controller)
            stream = await open_stream(harness, controller, opened)
            await take(stream, 2)
            assert presence.is_live(agent_id)
            conn = presence._connections[controller.controller_id]
            conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1
            assert not presence.is_live(agent_id)
            evicted = await take(stream, 1)
            beat = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection/beat",
                json={
                    "connection_id": opened["connection_id"],
                    "generation": opened["generation"],
                    "cursors": {},
                },
                headers=controller.headers,
            )

        assert evicted == [
            (
                "evicted",
                {
                    "code": "heartbeat_lapsed",
                    "reason": "heartbeat lapsed; reopen the stream and resume "
                    "from your cursor",
                },
            )
        ]
        assert (beat.status_code, beat.json()["error"]["code"]) == (
            404,
            "unknown_connection",
        )

    async def test_the_sweep_closes_a_lapsed_connection(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        presence = harness.protocol.connections.controllers
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            opened = await open_connection(client, controller)
        conn = presence._connections[controller.controller_id]
        conn.last_beat = time.monotonic() - HEARTBEAT_TTL_SECONDS - 1

        swept = presence.sweep()

        assert [c.id for c in swept] == [opened["connection_id"]]
        assert controller.controller_id not in presence._connections

    async def test_another_controllers_stream_is_forbidden(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            mine = await enroll_console(harness, client, owner, "mine")
            theirs = await enroll_console(harness, client, owner, "theirs")
            response = await client.post(
                f"/v1/controllers/{theirs.controller_id}/connection",
                json={"cursors": {}},
                headers=mine.headers,
            )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "forbidden"


async def test_a_waiting_stream_wakes_promptly_for_an_event(harness: Harness) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="reviewer")
        room_id = await add_room(harness.session_factory, agent_id)
        opened = await open_connection(client, controller)
    stream = await open_stream(harness, controller, opened)
    await take(stream, 2)
    pending = asyncio.ensure_future(anext(stream))
    await asyncio.sleep(0.01)
    harness.protocol.event_buffer.enqueue(
        agent_id, room_id, _message(room_id, "now", addressed=True)
    )
    raw = await asyncio.wait_for(pending, timeout=2)
    await stream.aclose()
    assert b"agent.event" in raw
