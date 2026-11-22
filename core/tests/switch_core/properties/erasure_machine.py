"""A Hypothesis state machine that leaves a person's traces around Switch, erases
them, and looks for what is left in every column of the schema.

The person is one of the three kinds an erasure names: a chat-platform
identity, a member's Switch Console client, or someone whose chat app was
disconnected (a former participant, found only by their messages). They and the
people around them post, in threads and with files, type commands, join rooms,
answer approvals and press cards, are copied into an agent's own events, are
mentioned by others and claimed by members; a platform identity can be
disconnected along with its app. What can go through Switch's own code does:
messages are written through a transport, and so routed and metered; arrivals
through provisioning; card answers through the bridge's store.

At the end the person is erased by the real `ErasureService`, optionally while
they send one more message, and two things are checked:

- **Nothing names them** (`retention.erasure-complete`): every row of every
  table in the live schema, listed from `information_schema` rather than the
  ORM and cast whole to text, is searched for each of the person's
  identifiers, recorded before the erasure. A table or column added later is
  searched without anyone listing it. What the design keeps on purpose is
  allowed, row by row, in `KEPT`, each with its reason.
- **Nothing else went**: every message, agent event, identity and file that
  was not the person's is still there.

Identifiers are distinctive (`zq` and random hex), so a match is never a common
word. The search finds only what the world puts in the database, so the rules
are written to reach every place a person's traces go today.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, ClassVar

import hypothesis.strategies as st
import pytest
from hypothesis.stateful import RuleBasedStateMachine, initialize, precondition, rule
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from switch_core.bridges.collaboration.collaboration_core import answerer_name
from switch_core.db.engine import create_session_factory
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentEventRow,
    ApprovalRequest,
    BridgeMessageMap,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    ExternalUserLinkRequest,
    MediaBlob,
    Message,
    Room,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.erasure_store import ErasureStore, UnknownIdentity
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.retention.erasure import ErasureService
from switch_core.tenant_context import tenant_scope
from tests.conftest import empty_the_database
from tests.routing import Process, make_agent, process_on

KINDS = ("platform", "member", "former")
# Who acts: the person, a bystander on another chat app, a member writing
# from Switch Console, and the agent.
ACTORS = ("person", "bo", "mira", "helper")
ROOMS = ("general", "archive", "direct")

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "erased a platform identity",
    "erased a member client",
    "erased a former participant",
    "the person sent during their erasure",
    "the person sent as their client stopped",
    "the person answered a card",
    "the person was copied to an agent",
)


def _token() -> str:
    return f"zq{uuid.uuid4().hex[:10]}"


@dataclass
class Person:
    kind: str
    client: Client
    identity: ExternalUser | None
    bridge: CollaborationBridge | None
    user: User | None

    def identifiers(self) -> dict[str, str]:
        """Everything that names them, by what it is."""
        found = {
            "client id": self.client.id,
            "transport id": self.client.transport_user_id,
        }
        if self.identity is not None:
            found |= {
                "identity id": self.identity.id,
                "platform user id": self.identity.external_user_id,
                "username": self.identity.external_username,
                "display name": self.client.display_name,
            }
        return found


class _Clients:
    """What the erasure asks of the running clients: stop one, and delete its
    record, as `ClientLifecycle` does. `on_stop` runs as a client is stopped:
    a send already under way, which stopping does not end."""

    def __init__(self, on_stop: Callable[[], Awaitable[None]]) -> None:
        self._on_stop = on_stop

    async def stop(self, client_id: str) -> None:
        await self._on_stop()

    async def delete_record(self, session: AsyncSession, client_id: str) -> None:
        await ClientStore().delete(session, client_id)


class _Bridges:
    async def forget_human(
        self, bridge_id: str, external_user_id: str, transport_user_id: str
    ) -> None:
        return None


# ── What the design keeps ─────────────────────────────────────────────────────
#
# Each entry is a table, the reason its rows may still name the person, and the
# SQL condition (on the table's alias `t`) that says which rows. `{person}` is
# the person's transport id. A table not here keeps nothing.

SURVIVING_MESSAGE = (
    "EXISTS (SELECT 1 FROM messages m WHERE m.room_id = t.room_id "
    "AND m.seq = t.room_seq AND m.sender_id <> {person})"
)
KEPT: dict[str, tuple[str, str]] = {
    "messages": (
        "what other people wrote: quotes and mentions stay, so their records "
        "are not rewritten",
        "t.sender_id <> {person}",
    ),
    "agent_events": (
        "an agent's copy of a message someone else wrote",
        SURVIVING_MESSAGE,
    ),
    "person_erasures": (
        "the erasure request itself, which names the identities by internal id",
        "TRUE",
    ),
    "audit_events": (
        "the record that an erasure was asked for, by internal id, kept for "
        "accountability",
        "t.action LIKE 'person_erasure.%'",
    ),
}
KEPT["tenant_usage"] = (
    "usage counted under the client that stood in for them, which is deleted, "
    "so the id names nothing",
    "TRUE",
)
# Known issues, each fixed in its own pull request; take an entry out when its
# fix is merged. While one is here, the sweep cannot see that kind of leftover.
KNOWN_ISSUES: dict[str, tuple[str, str]] = {
    "bridge_message_map": (
        "a card the person answered keeps their name on the agent's post "
        "mapping (card_answer)",
        "t.card_answer IS NOT NULL",
    ),
    "rooms": (
        "a disconnected app's direct room keeps a former participant's name: "
        "detaching clears the room's channel type, so erasure does not find it",
        "t.bridge_id IS NULL AND t.channel_type IS NULL",
    ),
}
KEPT |= KNOWN_ISSUES

# A member client and its memberships stay: the member is still a member.
KEPT_FOR_A_MEMBER: dict[str, tuple[str, str]] = {
    "clients": ("the member's own client, which stays", "TRUE"),
    "client_rooms": ("the member client's memberships, which stay", "TRUE"),
    "delivery_cursors": (
        "how far the member client's consumer has read, which stays with it",
        "TRUE",
    ),
}


class Erasure(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        try:
            self.run(empty_the_database(self.engine))
            self.factory = create_session_factory(self.engine)
            self.process: Process = process_on(self.factory)
        except BaseException:
            self._release()
            raise
        self.person: Person
        self.clients: dict[str, Client] = {}
        self.rooms: dict[str, Room] = {}
        self.events: dict[str, list[str]] = {actor: [] for actor in ACTORS}
        self.mapped: set[str] = set()
        self.disconnected = False
        self.send_during_erasure: str | None = None

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    def _release(self) -> None:
        try:
            self.run(self.engine.dispose())
        finally:
            self.loop.close()
            self._scope.__exit__(None, None, None)

    # ── The world ─────────────────────────────────────────────────────────────

    @initialize(kind=st.sampled_from(KINDS))
    def set_up(self, kind: str) -> None:
        self.run(self._set_up(kind))

    async def _set_up(self, kind: str) -> None:
        agent, helper = await make_agent(self.factory, "helper")
        self.agent = agent
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            self.admin = User(
                name="admin", email=f"{_token()}@example.invalid", role="user"
            )
            session.add(self.admin)
            their_app = await self._bridge(session)
            other_app = await self._bridge(session)
            person_client, identity = await self._platform_person(
                session, their_app, f"ana-{_token()}"
            )
            bo, _ = await self._platform_person(session, other_app, "bo")
            mira_user = User(
                name="Mira", email=f"{_token()}@example.invalid", role="user"
            )
            session.add(mira_user)
            await session.flush()
            mira = Client(
                transport_user_id=f"@switch-member-{mira_user.id}:test",
                display_name="Mira",
                type="member",
                user_id=mira_user.id,
            )
            session.add(mira)
            if kind == "member":
                user = User(
                    name=f"Ana {_token()}",
                    email=f"{_token()}@example.invalid",
                    role="user",
                )
                session.add(user)
                await session.flush()
                person_client = Client(
                    transport_user_id=f"@switch-member-{user.id}:test",
                    display_name=user.name,
                    type="member",
                    user_id=user.id,
                )
                session.add(person_client)
                self.person = Person(kind, person_client, None, None, user)
            else:
                self.person = Person(kind, person_client, identity, their_app, None)
            await session.flush()
            name = self.person.client.display_name
            for room_name in ROOMS:
                direct = room_name == "direct"
                room = Room(
                    transport_room_id=f"!{room_name}-{_token()}:test",
                    # As the bridge names a direct room it adopts.
                    name=f"Slack: {name} / helper" if direct else room_name,
                    description=f"Slack DM \u2014 {name} / helper" if direct else "",
                    channel_type="direct" if direct else "channel_public",
                    bridge_id=their_app.id if kind != "member" else None,
                    archived_at=datetime.now(UTC) if room_name == "archive" else None,
                )
                session.add(room)
                await session.flush()
                self.rooms[room_name] = room
            self.clients = {
                "person": self.person.client,
                "bo": bo,
                "mira": mira,
                "helper": helper,
            }
            for room in self.rooms.values():
                for client in self.clients.values():
                    session.add(ClientRoom(client_id=client.id, room_id=room.id))
                await session.execute(
                    insert(room_agents).values(
                        room_id=room.id,
                        agent_id=agent.id,
                        alias=None,
                        receives_join_events=True,
                    )
                )
            await session.commit()

    async def _bridge(self, session: AsyncSession) -> CollaborationBridge:
        client = Client(
            transport_user_id=f"@bridge-{_token()}:test",
            display_name="bridge",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack", display_name="Slack", client_id=client.id, status="active"
        )
        session.add(bridge)
        await session.flush()
        return bridge

    async def _platform_person(
        self, session: AsyncSession, bridge: CollaborationBridge, username: str
    ) -> tuple[Client, ExternalUser]:
        """A person on a chat app as the bridge first sees them: the name the
        platform gives is their username and their client's display name."""
        client = Client(
            transport_user_id=f"@switch-slack-{bridge.id}-{username}:test",
            display_name=username,
            type="user",
        )
        session.add(client)
        await session.flush()
        identity = ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"U{uuid.uuid4().hex[:10].upper()}",
            external_username=username,
            client_id=client.id,
        )
        session.add(identity)
        await session.flush()
        return client, identity

    # ── What people do ────────────────────────────────────────────────────────

    def _can_act(self, actor: str) -> bool:
        return actor != "person" or not self.disconnected

    def _say(
        self,
        actor: str,
        room: str,
        body: str,
        *,
        thread: bool = False,
        extra: dict[str, object] | None = None,
    ) -> str:
        client = self.clients[actor]
        roots = [e for events in self.events.values() for e in events]
        result = self.run(
            self.process.transport(client).send_message(
                self.rooms[room].transport_room_id,
                body,
                sender_name=client.display_name,
                # A person's post relayed by the bridge is metered, as
                # `CollaborationCore` sends it.
                metered=client.type == "user",
                format="markdown",
                thread_root_id=roots[-1] if thread and roots else None,
                extra_content=extra,
            )
        )
        self.events[actor].append(result.event_id)
        return str(result.event_id)

    @rule(
        actor=st.sampled_from(ACTORS),
        room=st.sampled_from(ROOMS),
        to_helper=st.booleans(),
        about_person=st.booleans(),
        thread=st.booleans(),
    )
    def say(
        self, actor: str, room: str, to_helper: bool, about_person: bool, thread: bool
    ) -> None:
        if not self._can_act(actor):
            return
        person = self.person.client
        words = ["@helper" if to_helper else "hello"]
        extra: dict[str, object] | None = None
        if about_person and actor != "person":
            words.append(f"as {person.display_name} said, @{person.display_name}")
            extra = {"m.mentions": {"user_ids": [person.transport_user_id]}}
        if actor == "person" and to_helper:
            COVERAGE["the person was copied to an agent"] += 1
        self._say(actor, room, " ".join(words), thread=thread, extra=extra)

    @rule(actor=st.sampled_from(ACTORS), room=st.sampled_from(ROOMS))
    def command(self, actor: str, room: str) -> None:
        if not self._can_act(actor) or actor == "helper":
            return
        client = self.clients[actor]
        result = self.run(
            self.process.transport(client).send_event(
                self.rooms[room].transport_room_id,
                "com.switch.command",
                {
                    "command": "list-agents",
                    "args": "",
                    "user_id": client.transport_user_id,
                    "user_name": client.display_name,
                },
            )
        )
        self.events[actor].append(result.event_id)

    @rule(
        actor=st.sampled_from(ACTORS),
        room=st.sampled_from(ROOMS),
        shared=st.booleans(),
    )
    def send_file(self, actor: str, room: str, shared: bool) -> None:
        """A file, stored; `shared` is one file posted by two people, which
        must outlive the erasure of either."""
        if not self._can_act(actor):
            return
        client = self.clients[actor]
        uri = "switch-media://shared" if shared else f"switch-media://{_token()}"
        self.run(self._store_blob(uri))
        result = self.run(
            self.process.transport(client).send_media(
                self.rooms[room].transport_room_id,
                uri,
                f"notes-{client.display_name}.txt",
                "text/plain",
                1,
                sender_name=client.display_name,
                metered=client.type == "user",
                msgtype="m.file",
                caption=f"from {client.display_name}",
                thread_root_id=None,
                group=None,
            )
        )
        self.events[actor].append(result.event_id)

    async def _store_blob(self, uri: str) -> None:
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            if (
                await session.scalar(select(MediaBlob.id).where(MediaBlob.uri == uri))
                is None
            ):
                session.add(
                    MediaBlob(
                        uri=uri,
                        content_type="text/plain",
                        filename="notes.txt",
                        size=1,
                        data=b"x",
                    )
                )
                await session.commit()

    @precondition(lambda self: not self.disconnected)
    @rule()
    def join_a_room(self) -> None:
        """The person arrives in a new room, as provisioning writes it, with
        the agent listening for arrivals."""
        self.run(self._join_a_room())

    async def _join_a_room(self) -> None:
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            room = Room(
                transport_room_id=f"!joined-{_token()}:test",
                name="joined",
                description="",
                channel_type="channel_public",
            )
            session.add(room)
            await session.flush()
            await session.execute(
                insert(room_agents).values(
                    room_id=room.id,
                    agent_id=self.agent.id,
                    alias=None,
                    receives_join_events=True,
                )
            )
            session.add(
                ClientRoom(client_id=self.clients["helper"].id, room_id=room.id)
            )
            await session.commit()
        await self.process.provisioning.invite_to_room(
            room.transport_room_id, self.person.client.transport_user_id
        )

    @rule(answerer=st.sampled_from(("person", "bo", "mira")))
    def answer_approval(self, answerer: str) -> None:
        """An approval the agent asked, answered with typed words."""
        if not self._can_act(answerer):
            return
        self.run(self._answer_approval(self.clients[answerer]))

    async def _answer_approval(self, client: Client) -> None:
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            session.add(
                ApprovalRequest(
                    agent_id=self.agent.id,
                    session_id=_token(),
                    request_id=_token(),
                    turn_id=_token(),
                    kind="questions",
                    room_id=self.rooms["general"].id,
                    title="Deploy?",
                    options=[],
                    questions=[{"question": "Deploy?"}],
                    answer="yes",
                    answers=[
                        {
                            "answer": "yes",
                            "custom_text": f"yes, {client.display_name} here",
                        }
                    ],
                    answered_by=client.transport_user_id,
                    answered_at=datetime.now(UTC),
                )
            )
            await session.commit()

    @precondition(lambda self: self.person.kind != "member")
    @rule(answerer=st.sampled_from(("person", "bo")))
    def answer_card(self, answerer: str) -> None:
        """The agent posts a card on the person's chat app and someone presses
        a button, as the bridge records it."""
        if not self._can_act(answerer) or self.disconnected:
            return
        card = self._say("helper", "general", "Pick one")
        if answerer == "person":
            COVERAGE["the person answered a card"] += 1
        self.run(self._answer_card(card, self.clients[answerer]))

    async def _answer_card(self, card_event_id: str, answerer: Client) -> None:
        assert self.person.bridge is not None
        post = f"post-{_token()}"
        store = BridgeMessageMapStore()
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            session.add(
                BridgeMessageMap(
                    bridge_id=self.person.bridge.id,
                    external_channel_id="C1",
                    transport_event_id=card_event_id,
                    external_post_id=post,
                )
            )
            await session.flush()
            await store.answer_card(
                session,
                bridge_id=self.person.bridge.id,
                external_post_id=post,
                answer={"by": answerer_name(answerer.display_name), "label": "Yes"},
            )
            await session.commit()

    @precondition(lambda self: self.person.kind != "member" and not self.disconnected)
    @rule()
    def map_a_post(self) -> None:
        """The bridge records the platform post a message of the person's was
        relayed from."""
        unmapped = [e for e in self.events["person"] if e not in self.mapped]
        if not unmapped:
            return
        assert self.person.bridge is not None
        self.run(self._map(self.person.bridge.id, unmapped[-1]))
        self.mapped.add(unmapped[-1])

    async def _map(self, bridge_id: str, event_id: str) -> None:
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            session.add(
                BridgeMessageMap(
                    bridge_id=bridge_id,
                    external_channel_id="C1",
                    transport_event_id=event_id,
                    external_post_id=f"post-{_token()}",
                )
            )
            await session.commit()

    @precondition(lambda self: self.person.kind != "member" and not self.disconnected)
    @rule(confirmed=st.booleans())
    def link_to_mira(self, confirmed: bool) -> None:
        """Mira says the person's chat account is hers: a link request, and once
        the account confirms it, a claim."""
        self.run(self._link(confirmed))

    async def _link(self, confirmed: bool) -> None:
        assert self.person.identity is not None
        mira = self.clients["mira"].user_id
        assert mira is not None
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            identity = self.person.identity.id
            if confirmed:
                if await session.get(ExternalUserClaim, (identity, mira)) is None:
                    session.add(
                        ExternalUserClaim(external_user_id=identity, user_id=mira)
                    )
            elif await session.get(ExternalUserLinkRequest, (identity, mira)) is None:
                session.add(
                    ExternalUserLinkRequest(
                        external_user_id=identity,
                        user_id=mira,
                        requested_by_user_id=mira,
                        code_hash=_token(),
                    )
                )
            await session.commit()

    @precondition(lambda self: self.person.kind == "former" and not self.disconnected)
    @rule()
    def disconnect_their_app(self) -> None:
        """Their chat app is removed, as `CollaborationLifecycle.remove` does
        in the database: its people and their clients go, the rooms are
        detached, the messages stay."""
        self.run(self._disconnect())
        self.disconnected = True

    async def _disconnect(self) -> None:
        bridge = self.person.bridge
        assert bridge is not None
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            people = await ExternalUserStore().get_by_bridge(session, bridge.id)
            removed = [p.client_id for p in people] + [bridge.client_id]
            for room in await RoomStore().get_by_bridge(session, bridge.id):
                await RoomStore().clear_bridge(session, room.id)
            await ExternalUserStore().delete_by_bridge(session, bridge.id)
            await CollaborationBridgeStore().delete(session, bridge.id)
            for client_id in removed:
                await ClientStore().delete(session, client_id)
            await session.commit()

    @precondition(lambda self: self.person.kind == "platform")
    @rule(when=st.sampled_from(("alongside", "as their client stops")))
    def send_while_erased(self, when: str) -> None:
        """The person sends once more while their erasure runs: alongside it,
        landing wherever it lands, or just as their client is stopped, after
        the erasure's batches and before its last transaction."""
        self.send_during_erasure = when

    # ── Erasing, and what is left ─────────────────────────────────────────────

    def teardown(self) -> None:
        try:
            if hasattr(self, "person"):
                self.run(self._erase_and_check())
        finally:
            self._release()

    async def _erase_and_check(self) -> None:
        person = self.person
        identifiers = person.identifiers()
        if person.kind == "former" and not self.disconnected:
            await self._disconnect()
            self.disconnected = True
        before = await self._others_things()
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            if person.kind == "former" and not await session.scalar(
                select(Message.id)
                .where(Message.sender_id == person.client.transport_user_id)
                .limit(1)
            ):
                # Found only by their messages, so with none left there is
                # nobody to erase, and the queue says so.
                with pytest.raises(UnknownIdentity):
                    await ErasureStore().queue(
                        session,
                        external_user_ids=[],
                        former_sender_ids=[person.client.transport_user_id],
                        member_client_ids=[],
                        requested_by_user_id=self.admin.id,
                    )
                COVERAGE["a former participant with no messages is refused"] += 1
                return
            erasure = await ErasureStore().queue(
                session,
                external_user_ids=[person.identity.id]
                if person.kind == "platform" and person.identity is not None
                else [],
                former_sender_ids=[person.client.transport_user_id]
                if person.kind == "former"
                else [],
                member_client_ids=[person.client.id] if person.kind == "member" else [],
                requested_by_user_id=self.admin.id,
            )
            await session.commit()
        COVERAGE[
            {
                "platform": "erased a platform identity",
                "member": "erased a member client",
                "former": "erased a former participant",
            }[person.kind]
        ] += 1

        async def one_more() -> None:
            await self.process.transport(person.client).send_message(
                self.rooms["general"].transport_room_id,
                "one more thing",
                sender_name=person.client.display_name,
                metered=True,
                format="markdown",
            )

        async def nothing() -> None:
            return None

        late = self.send_during_erasure == "as their client stops"
        service = ErasureService(
            self.factory, _Clients(one_more if late else nothing), _Bridges()
        )
        theirs = await self._their_things()
        if self.send_during_erasure == "alongside":
            COVERAGE["the person sent during their erasure"] += 1
            outcome = await asyncio.gather(
                service.work_once(datetime.now(UTC)),
                one_more(),
                return_exceptions=True,
            )
            finished = outcome[0]
        else:
            if late:
                COVERAGE["the person sent as their client stopped"] += 1
            finished = await service.work_once(datetime.now(UTC))
        assert not isinstance(finished, BaseException), finished
        assert finished is not None and finished.id == erasure.id
        assert finished.state == "done", finished.error

        left = await self._names(identifiers)
        assert not left, "the erased person is still named in:\n" + "\n".join(
            f"  {table}.{column}: {what} ({count} rows)"
            for (table, column, what), count in sorted(left.items())
        )
        after = await self._others_things()
        for what, things in before.items():
            gone = things - after[what]
            assert not gone, f"the erasure took {len(gone)} of others' {what}: {gone}"
        still = await self._their_things_left(theirs)
        for what, things in still.items():
            assert not things, (
                f"the erasure left {len(things)} of their {what}: {things}"
            )

    async def _their_things(self) -> dict[str, set[str]]:
        """What only the person's messages carried, which names nothing of
        theirs a sweep could find but has to go with them: the platform posts
        their messages were relayed from, and the files only they posted."""
        person = self.person.client.transport_user_id
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            return {
                "post mappings": set(
                    await session.scalars(
                        select(Message.transport_event_id).where(
                            Message.sender_id == person
                        )
                    )
                ),
                "files": set(
                    await session.scalars(
                        text(
                            "SELECT DISTINCT a.uri FROM message_attachments a "
                            "JOIN messages m ON m.id = a.message_id "
                            "WHERE m.sender_id = :person AND NOT EXISTS ("
                            "SELECT 1 FROM message_attachments o "
                            "JOIN messages om ON om.id = o.message_id "
                            "WHERE o.uri = a.uri AND om.sender_id <> :person)"
                        ).bindparams(person=person)
                    )
                ),
            }

    async def _their_things_left(
        self, theirs: dict[str, set[str]]
    ) -> dict[str, set[str]]:
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            return {
                "post mappings": set(
                    await session.scalars(
                        select(BridgeMessageMap.transport_event_id).where(
                            BridgeMessageMap.transport_event_id.in_(
                                theirs["post mappings"]
                            )
                        )
                    )
                ),
                "files": set(
                    await session.scalars(
                        select(MediaBlob.uri).where(MediaBlob.uri.in_(theirs["files"]))
                    )
                ),
            }

    async def _others_things(self) -> dict[str, set[Any]]:
        """What does not belong to the person, and has to outlive their
        erasure."""
        person = self.person.client.transport_user_id
        async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
            return {
                "messages": set(
                    await session.scalars(
                        select(Message.id).where(Message.sender_id != person)
                    )
                ),
                "agent events": set(
                    (
                        await session.execute(
                            select(AgentEventRow.agent_id, AgentEventRow.seq)
                            .join(
                                Message,
                                (Message.room_id == AgentEventRow.room_id)
                                & (Message.seq == AgentEventRow.room_seq),
                            )
                            .where(Message.sender_id != person)
                        )
                    ).all()
                ),
                "identities": set(
                    await session.scalars(
                        select(ExternalUser.id).where(
                            ExternalUser.client_id != self.person.client.id
                        )
                    )
                ),
                "files": set(
                    await session.scalars(
                        text(
                            "SELECT DISTINCT a.uri FROM message_attachments a "
                            "JOIN messages m ON m.id = a.message_id "
                            "WHERE m.sender_id <> :person"
                        ).bindparams(person=person)
                    )
                ),
            }

    async def _names(
        self, identifiers: dict[str, str]
    ) -> dict[tuple[str, str, str], int]:
        """Each column, outside what `KEPT` allows, that still holds one of
        `identifiers`, with how many rows.

        A table is searched whole, its rows cast to text, so a column of any
        type is searched; only a table with a match is searched column by
        column, to say where."""
        kept = dict(KEPT)
        if self.person.kind == "member":
            kept |= KEPT_FOR_A_MEMBER
        params = {
            "patterns": [f"%{value}%" for value in identifiers.values()],
            "person": self.person.client.transport_user_id,
        }
        found: dict[tuple[str, str, str], int] = {}
        async with self.engine.connect() as connection:
            tables = (
                await connection.scalars(
                    text(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = current_schema() "
                        "AND table_type = 'BASE TABLE' ORDER BY table_name"
                    )
                )
            ).all()
            for table in tables:
                allowed = kept.get(table, ("", "FALSE"))[1].replace(
                    "{person}", ":person"
                )
                outside = f"NOT ({allowed})"
                hits = (
                    await connection.execute(
                        text(
                            f'SELECT count(*) FROM "{table}" t WHERE {outside} '
                            "AND t::text LIKE ANY(:patterns)"
                        ),
                        params,
                    )
                ).scalar_one()
                if not hits:
                    continue
                columns = (
                    await connection.scalars(
                        text(
                            "SELECT column_name FROM information_schema.columns "
                            "WHERE table_schema = current_schema() "
                            "AND table_name = :table ORDER BY column_name"
                        ),
                        {"table": table},
                    )
                ).all()
                for column in columns:
                    for what, value in identifiers.items():
                        count = (
                            await connection.execute(
                                text(
                                    f'SELECT count(*) FROM "{table}" t WHERE '
                                    f'{outside} AND t."{column}"::text LIKE :pattern'
                                ),
                                {**params, "pattern": f"%{value}%"},
                            )
                        ).scalar_one()
                        if count:
                            found[(table, column, what)] = count
                if not any(key[0] == table for key in found):
                    found[(table, "(the row as a whole)", "an identifier")] = hits
        return found


def machine_on(url: str) -> type[Erasure]:
    """The machine against the database at `url`."""
    return type("ErasureOnPostgres", (Erasure,), {"url": url})
