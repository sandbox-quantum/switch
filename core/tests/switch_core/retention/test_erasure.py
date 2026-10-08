"""Erasing a person, against real Postgres.

What matters here is what is gone and what is not: every message the person
sent, in every room, with the files only they carried, their identity rows,
claims, memberships and client, and their name on approval answers; while
other people's messages, files those still quote, and other identities stay.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    ApprovalRequest,
    AuditEvent,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    HostedLaunch,
    HostedWakeMailbox,
    MediaBlob,
    Message,
    MessageAttachment,
    PersonErasure,
    Room,
    User,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.erasure_store import (
    ERASED_ANSWERER,
    ErasureAlreadyQueued,
    ErasureStore,
    UnknownIdentity,
)
from switch_core.db.stores.message_store import MessageStore
from switch_core.retention.erasure import ErasureService

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


class _Clients:
    def __init__(self, fail_on_stop: bool = False) -> None:
        self.stopped: list[str] = []
        self._fail = fail_on_stop

    async def stop(self, client_id: str) -> None:
        if self._fail:
            raise RuntimeError("client would not stop")
        self.stopped.append(client_id)

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        await ClientStore().delete(session, client_id)


class _Bridges:
    def __init__(self) -> None:
        self.forgotten: list[tuple[str, str, str]] = []

    async def forget_human(
        self, bridge_id: str, external_user_id: str, transport_user_id: str
    ) -> None:
        self.forgotten.append((bridge_id, external_user_id, transport_user_id))


async def _bridge(session: AsyncSession) -> CollaborationBridge:
    client = Client(
        transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Acme Slack", client_id=client.id, status="active"
    )
    session.add(bridge)
    await session.flush()
    return bridge


async def _person(
    session: AsyncSession, bridge: CollaborationBridge, username: str
) -> ExternalUser:
    client = Client(
        transport_user_id=f"@switch-slack-{bridge.id}-{username}:test",
        display_name=username,
        type="user",
    )
    session.add(client)
    await session.flush()
    person = ExternalUser(
        bridge_id=bridge.id,
        external_user_id=f"U-{username}",
        external_username=username,
        client_id=client.id,
    )
    session.add(person)
    await session.flush()
    return person


async def _room(session: AsyncSession, name: str, *, archived: bool = False) -> Room:
    room = Room(
        transport_room_id=f"!{name}-{uuid.uuid4().hex[:8]}:test",
        name=name,
        description=name,
        archived_at=NOW if archived else None,
    )
    session.add(room)
    await session.flush()
    return room


async def _say(
    session: AsyncSession,
    room: Room,
    sender: Client,
    event_id: str,
    uri: str | None = None,
) -> Message:
    attachments = (
        []
        if uri is None
        else [MessageAttachment(uri=uri, filename="f", mimetype="text/plain", size=1)]
    )
    return await MessageStore().create(
        session,
        Message(
            room_id=room.id,
            transport_event_id=event_id,
            sender_id=sender.transport_user_id,
            sender_client_id=sender.id,
            event_type="m.room.message",
            msgtype="m.text",
            body=event_id,
            content={"msgtype": "m.text", "body": event_id},
        ),
        attachments,
    )


async def _blob(session: AsyncSession, uri: str) -> None:
    session.add(
        MediaBlob(uri=uri, content_type="text/plain", filename="f", size=1, data=b"x")
    )
    await session.flush()


async def _client_of(session: AsyncSession, person: ExternalUser) -> Client:
    client = await session.get(Client, person.client_id)
    assert client is not None
    return client


async def _agent(session: AsyncSession) -> Agent:
    name = f"agent-{uuid.uuid4().hex[:6]}"
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"h-{name}",
        encrypted_key="e",
        label=name,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=name,
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _queue(
    session_factory: async_sessionmaker[AsyncSession],
    external_user_ids: list[str],
    former_sender_ids: list[str] | None = None,
) -> str:
    async with session_factory() as session:
        owner = User(
            name=f"owner-{uuid.uuid4().hex[:6]}",
            email=f"{uuid.uuid4().hex[:6]}@example.invalid",
            role="user",
        )
        session.add(owner)
        await session.flush()
        erasure = await ErasureStore().queue(
            session,
            external_user_ids=external_user_ids,
            former_sender_ids=former_sender_ids or [],
            requested_by_user_id=owner.id,
        )
        await session.commit()
        return erasure.id


async def _disconnect(session: AsyncSession, person: ExternalUser) -> str:
    """What removing their chat app does: identity and client go, messages stay."""
    client = await _client_of(session, person)
    await session.execute(
        update(Message)
        .where(Message.sender_client_id == client.id)
        .values(sender_name=person.external_username)
    )
    sender_id = client.transport_user_id
    await session.delete(person)
    await session.flush()
    await session.delete(client)
    await session.flush()
    return sender_id


class TestErasing:
    async def test_everything_they_sent_goes_and_everything_else_stays(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge = await _bridge(session)
            ana = await _person(session, bridge, "ana")
            bo = await _person(session, bridge, "bo")
            ana_client = await _client_of(session, ana)
            bo_client = await _client_of(session, bo)
            active = await _room(session, "active")
            archived = await _room(session, "archived", archived=True)
            session.add_all(
                [
                    ClientRoom(client_id=ana_client.id, room_id=active.id),
                    ClientRoom(client_id=bo_client.id, room_id=active.id),
                ]
            )
            claimant = User(name="ana-member", email="ana@example.invalid", role="user")
            session.add(claimant)
            await session.flush()
            session.add(ExternalUserClaim(external_user_id=ana.id, user_id=claimant.id))
            for uri in ("switch-media://ana-only", "switch-media://shared"):
                await _blob(session, uri)
            await _say(session, active, ana_client, "$ana1", "switch-media://ana-only")
            await _say(session, archived, ana_client, "$ana2", "switch-media://shared")
            await _say(session, active, bo_client, "$bo1", "switch-media://shared")
            last = await _say(session, active, ana_client, "$ana3")
            agent = await _agent(session)
            for request_id, answered_by in (
                ("by-ana", ana_client.transport_user_id),
                ("by-bo", bo_client.transport_user_id),
            ):
                session.add(
                    ApprovalRequest(
                        agent_id=agent.id,
                        session_id="s",
                        request_id=request_id,
                        turn_id="t",
                        kind="approval",
                        title="t",
                        options=[],
                        questions=[],
                        state="answered",
                        answered_by=answered_by,
                    )
                )
            await session.commit()
            ana_id, ana_client_id, ana_tid = (
                ana.id,
                ana_client.id,
                ana_client.transport_user_id,
            )
            bridge_id, active_id, last_seq = bridge.id, active.id, last.seq

        erasure_id = await _queue(session_factory, [ana_id])
        clients, bridges = _Clients(), _Bridges()
        await ErasureService(session_factory, clients, bridges).work_once(
            datetime.now(UTC)
        )

        async with session_factory() as session:
            events = set(
                (await session.execute(select(Message.transport_event_id))).scalars()
            )
            blobs = set((await session.execute(select(MediaBlob.uri))).scalars())
            identities = set(
                (
                    await session.execute(select(ExternalUser.external_username))
                ).scalars()
            )
            claims = await session.scalar(
                select(func.count()).select_from(ExternalUserClaim)
            )
            memberships = set(
                (await session.execute(select(ClientRoom.client_id))).scalars()
            )
            answers = dict(
                (
                    await session.execute(
                        select(ApprovalRequest.request_id, ApprovalRequest.answered_by)
                    )
                ).all()
            )
            erasure = await session.get(PersonErasure, erasure_id)
            audit = (
                await session.execute(
                    select(AuditEvent.action, AuditEvent.details).where(
                        AuditEvent.target_id == erasure_id
                    )
                )
            ).all()
            fresh = await _say(
                session, await session.get(Room, active_id), bo_client, "$bo2"
            )
            client_gone = await session.get(Client, ana_client_id) is None

        assert events == {"$bo1"}
        assert blobs == {"switch-media://shared"}
        assert identities == {"bo"}
        assert claims == 0
        assert memberships == {bo_client.id}
        assert client_gone
        assert answers == {
            "by-ana": ERASED_ANSWERER,
            "by-bo": bo_client.transport_user_id,
        }
        assert clients.stopped == [ana_client_id]
        assert bridges.forgotten == [(bridge_id, ana_id, ana_tid)]
        assert fresh.seq == last_seq + 1
        assert erasure is not None
        assert (erasure.state, erasure.messages_deleted, erasure.files_deleted) == (
            "done",
            3,
            1,
        )
        assert erasure.identities_erased == 1 and erasure.completed_at is not None
        assert audit == [
            (
                "person_erasure.completed",
                {"messages_deleted": 3, "files_deleted": 1, "identities_erased": 1},
            )
        ]

    async def test_a_person_on_two_platforms_is_erased_from_both(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            slack, other = await _bridge(session), await _bridge(session)
            on_slack = await _person(session, slack, "ana")
            on_other = await _person(session, other, "ana")
            room = await _room(session, "r")
            await _say(session, room, await _client_of(session, on_slack), "$a")
            await _say(session, room, await _client_of(session, on_other), "$b")
            await session.commit()
            ids = [on_slack.id, on_other.id]

        erasure_id = await _queue(session_factory, ids)
        await ErasureService(session_factory, _Clients(), _Bridges()).work_once(
            datetime.now(UTC)
        )

        async with session_factory() as session:
            assert await session.scalar(select(func.count()).select_from(Message)) == 0
            assert (
                await session.scalar(select(func.count()).select_from(ExternalUser))
                == 0
            )
            erasure = await session.get(PersonErasure, erasure_id)
        assert erasure is not None
        assert (erasure.identities_erased, erasure.messages_deleted) == (2, 2)

    async def test_a_failure_is_recorded_on_the_request_and_not_retried(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await _person(session, await _bridge(session), "ana")
            await session.commit()
            person_id = person.id
        erasure_id = await _queue(session_factory, [person_id])
        service = ErasureService(
            session_factory, _Clients(fail_on_stop=True), _Bridges()
        )

        finished = await service.work_once(datetime.now(UTC))

        async with session_factory() as session:
            still_there = await session.get(ExternalUser, person_id)
        assert finished is not None and finished.id == erasure_id
        assert finished.state == "failed"
        assert finished.error == "RuntimeError: client would not stop"
        assert still_there is not None
        assert await service.work_once(datetime.now(UTC)) is None
        await _queue(session_factory, [person_id])

    async def test_a_failure_after_the_identity_is_gone_does_not_fail_the_request(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        class _BrokenBridges(_Bridges):
            async def forget_human(self, *args: str) -> None:
                raise RuntimeError("bridge unreachable")

        async with session_factory() as session:
            person = await _person(session, await _bridge(session), "ana")
            await session.commit()
            person_id = person.id
        await _queue(session_factory, [person_id])

        finished = await ErasureService(
            session_factory, _Clients(), _BrokenBridges()
        ).work_once(datetime.now(UTC))

        assert finished is not None
        assert (finished.state, finished.identities_erased) == ("done", 1)

    async def test_a_request_left_running_by_a_dead_process_is_finished(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await _person(session, await _bridge(session), "ana")
            room = await _room(session, "r")
            await _say(session, room, await _client_of(session, person), "$a")
            await session.commit()
            person_id = person.id
        erasure_id = await _queue(session_factory, [person_id])
        async with session_factory() as session:
            erasure = await session.get(PersonErasure, erasure_id)
            assert erasure is not None
            erasure.state = "running"
            erasure.messages_deleted = 7
            await session.commit()
        service = ErasureService(session_factory, _Clients(), _Bridges())

        assert await service.work_once(datetime.now(UTC)) is None
        finished = await service.work_once(datetime.now(UTC) + timedelta(minutes=11))

        assert finished is not None
        assert (finished.state, finished.messages_deleted) == ("done", 8)

    async def test_their_words_on_approvals_go_and_their_choice_stays(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await _person(session, await _bridge(session), "ana")
            client = await _client_of(session, person)
            agent = await _agent(session)
            session.add(
                ApprovalRequest(
                    agent_id=agent.id,
                    session_id="s",
                    request_id="q",
                    turn_id="t",
                    kind="questions",
                    title="t",
                    options=[],
                    questions=[],
                    state="answered",
                    answered_by=client.transport_user_id,
                    answers=[
                        {
                            "question_id": "q1",
                            "selected_option_ids": ["yes"],
                            "custom_text": "my home address is ...",
                        }
                    ],
                )
            )
            await session.commit()
            person_id = person.id
        await _queue(session_factory, [person_id])

        await ErasureService(session_factory, _Clients(), _Bridges()).work_once(
            datetime.now(UTC)
        )

        async with session_factory() as session:
            row = (await session.execute(select(ApprovalRequest))).scalar_one()
        assert row.answered_by == ERASED_ANSWERER
        assert row.answers == [{"question_id": "q1", "selected_option_ids": ["yes"]}]

    async def test_their_name_leaves_direct_rooms_and_hosted_copies_go(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await _person(session, await _bridge(session), "ana")
            client = await _client_of(session, person)
            dm = Room(
                transport_room_id=f"!dm-{uuid.uuid4().hex[:8]}:test",
                name="Acme Slack: ana / helper",
                description="Acme Slack DM — ana / helper",
                channel_type="direct",
            )
            channel = Room(
                transport_room_id=f"!ch-{uuid.uuid4().hex[:8]}:test",
                name="Acme Slack: ana-fans",
                description="channel",
                channel_type="channel_public",
            )
            session.add_all([dm, channel])
            await session.flush()
            session.add_all(
                [
                    ClientRoom(client_id=client.id, room_id=dm.id),
                    ClientRoom(client_id=client.id, room_id=channel.id),
                ]
            )
            message = await _say(session, dm, client, "$to-hosted")
            owner = User(name="launch-owner", email="lo@example.invalid", role="user")
            session.add(owner)
            await session.flush()
            launch = HostedLaunch(
                id=f"launch-{uuid.uuid4().hex[:8]}",
                owner_id=owner.id,
                name="helper",
                spec={},
                state="ready",
                agent_id=str(uuid.uuid4()),
            )
            session.add(launch)
            await session.flush()
            session.add(
                HostedWakeMailbox(
                    agent_id=launch.agent_id,
                    room_id=dm.id,
                    message_id=message.transport_event_id,
                    launch_id=launch.id,
                    event={"body": "hello"},
                    addressed_at=datetime.now(UTC),
                    updated_at=datetime.now(UTC),
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                )
            )
            await session.commit()
            person_id, dm_id, channel_id = person.id, dm.id, channel.id
        await _queue(session_factory, [person_id])

        await ErasureService(session_factory, _Clients(), _Bridges()).work_once(
            datetime.now(UTC)
        )

        async with session_factory() as session:
            dm_after = await session.get(Room, dm_id)
            channel_after = await session.get(Room, channel_id)
            mailbox = await session.scalar(
                select(func.count()).select_from(HostedWakeMailbox)
            )
        assert dm_after is not None and channel_after is not None
        assert dm_after.name == "Acme Slack: erased person / helper"
        assert dm_after.description == "Acme Slack DM — erased person / helper"
        assert channel_after.name == "Acme Slack: ana-fans"
        assert mailbox == 0


class TestQueue:
    async def test_people_are_listed_with_their_message_counts_and_claimants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge = await _bridge(session)
            ana = await _person(session, bridge, "ana")
            await _person(session, bridge, "Bo")
            room = await _room(session, "r")
            for index in range(3):
                await _say(session, room, await _client_of(session, ana), f"$a{index}")
            member = User(name="Ana Member", email="am@example.invalid", role="user")
            session.add(member)
            await session.flush()
            session.add(ExternalUserClaim(external_user_id=ana.id, user_id=member.id))
            await session.commit()

            people = await ErasureStore().list_people(session)

        assert [(p.username, p.message_count) for p in people] == [
            ("ana", 3),
            ("Bo", 0),
        ]
        assert [c.name for c in people[0].claimed_by] == ["Ana Member"]
        assert (people[0].platform, people[0].bridge_name) == ("slack", "Acme Slack")

    async def test_an_identity_from_nowhere_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        with pytest.raises(UnknownIdentity):
            await _queue(session_factory, ["not-a-person"])

    async def test_an_identity_already_being_erased_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge = await _bridge(session)
            ana = await _person(session, bridge, "ana")
            bo = await _person(session, bridge, "bo")
            await session.commit()
            ana_id, bo_id = ana.id, bo.id
        await _queue(session_factory, [ana_id])

        with pytest.raises(ErasureAlreadyQueued):
            await _queue(session_factory, [bo_id, ana_id])
        await _queue(session_factory, [bo_id])


class TestFormerParticipants:
    async def test_people_of_a_disconnected_app_are_listed_and_no_one_else(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge = await _bridge(session)
            ana = await _person(session, bridge, "ana")
            bo = await _person(session, bridge, "bo")
            agent = await _agent(session)
            agent_client = await session.get(Client, agent.client_id)
            assert agent_client is not None
            room = await _room(session, "r")
            for index in range(2):
                await _say(session, room, await _client_of(session, ana), f"$a{index}")
            await _say(session, room, await _client_of(session, bo), "$b")
            await _say(session, room, agent_client, "$agent")
            ana_sender = await _disconnect(session, ana)
            await session.commit()

            former = await ErasureStore().list_former_participants(session)

        assert [
            (f.sender_id, f.names, f.platform, f.message_count) for f in former
        ] == [(ana_sender, ["ana"], "slack", 2)]

    async def test_a_former_participant_is_erased_and_the_rest_stays(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge = await _bridge(session)
            ana = await _person(session, bridge, "ana")
            bo = await _person(session, bridge, "bo")
            ana_client = await _client_of(session, ana)
            bo_client = await _client_of(session, bo)
            agent = await _agent(session)
            room = await _room(session, "r", archived=True)
            dm = Room(
                transport_room_id=f"!dm-{uuid.uuid4().hex[:8]}:test",
                name="Acme Slack: ana / helper",
                description="Acme Slack DM — ana / helper",
                channel_type="direct",
            )
            session.add(dm)
            await session.flush()
            await _blob(session, "mxc://test/ana-only")
            await _blob(session, "mxc://test/shared")
            await _say(session, room, ana_client, "$a1", "mxc://test/ana-only")
            await _say(session, dm, ana_client, "$a2", "mxc://test/shared")
            await _say(session, room, bo_client, "$b1", "mxc://test/shared")
            session.add(
                ApprovalRequest(
                    agent_id=agent.id,
                    session_id="s",
                    request_id="q",
                    turn_id="t",
                    kind="questions",
                    title="t",
                    options=[],
                    questions=[],
                    state="answered",
                    answered_by=ana_client.transport_user_id,
                    answers=[{"question_id": "q1", "custom_text": "private"}],
                )
            )
            ana_sender = await _disconnect(session, ana)
            await session.commit()
            dm_id = dm.id
        erasure_id = await _queue(session_factory, [], [ana_sender])

        finished = await ErasureService(
            session_factory, _Clients(), _Bridges()
        ).work_once(datetime.now(UTC))

        assert finished is not None and finished.id == erasure_id
        assert (finished.state, finished.error) == ("done", None)
        assert (
            finished.messages_deleted,
            finished.files_deleted,
            finished.identities_erased,
        ) == (2, 1, 1)
        async with session_factory() as session:
            left = (await session.execute(select(Message.transport_event_id))).scalars()
            blobs = (await session.execute(select(MediaBlob.uri))).scalars()
            approval = (await session.execute(select(ApprovalRequest))).scalar_one()
            dm_after = await session.get(Room, dm_id)
            former = await ErasureStore().list_former_participants(session)
        assert list(left) == ["$b1"]
        assert list(blobs) == ["mxc://test/shared"]
        assert approval.answered_by == ERASED_ANSWERER
        assert approval.answers == [{"question_id": "q1"}]
        assert dm_after is not None
        assert dm_after.name == "Acme Slack: erased person / helper"
        assert former == []

    async def test_a_sender_that_is_not_a_former_participant_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            ana = await _person(session, await _bridge(session), "ana")
            await _say(
                session, await _room(session, "r"), await _client_of(session, ana), "$a"
            )
            await session.commit()
            live_sender = (await _client_of(session, ana)).transport_user_id

        with pytest.raises(UnknownIdentity):
            await _queue(session_factory, [], [live_sender])
