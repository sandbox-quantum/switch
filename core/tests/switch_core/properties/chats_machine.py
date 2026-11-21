"""A Hypothesis state machine over chat membership and Postgres.

Membership is a chat's only read authority: a person reads a room while they
have a `client_rooms` row for it and a role in its workspace. Most memberships
last: creating the chat, being invited by a room manager, a manager adding
themselves. One kind does not: a person is put in each live chat they started
that holds an agent they own, and `sync_owned_rooms` takes that back once it no
longer holds. The machine is the people, their agents and their chats: they
create chats, leave them, invite and remove each other, add and remove agents,
archive and restore chats, hand agents to each other, and leave the workspace
and come back. A model keeps why each membership exists, and after every step
the rows, the owner marks and who may read what must match it.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal

import hypothesis.strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.chats.service import ChatError, ChatService
from switch_core.db.engine import create_session_factory
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ChatOwnerGrant,
    Client,
    ClientRoom,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.tenant_context import tenant_scope
from tests.conftest import empty_the_database
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.gateway.conftest import (
    _chat_service,
    _FakeActivityListener,
    _FakeLifecycle,
    _FakeListener,
)

# carol owns no agent, so she can leave the workspace whenever the steps say.
PEOPLE = ("alice", "bob", "carol")
ADMIN = "admin"
EVERYONE = (*PEOPLE, ADMIN)
AGENTS = {"alice-bot": "alice", "bob-bot": "bob", "admin-bot": ADMIN}
MAX_ROOMS = 4
Reason = Literal["lasting", "owner"]

COVERAGE: Counter[str] = Counter()
SHOULD_REACH = (
    "joined as an owner",
    "an owner membership taken back",
    "an owner membership made lasting",
    "refused to remove an owner",
    "joined on reading",
    "refused a reader outside the workspace",
)


@dataclass
class Chat:
    room_id: str
    creator: str
    agents: set[str]
    archived: bool = False
    members: dict[str, Reason] = field(default_factory=dict)


class ChatsMachine(RuleBasedStateMachine):
    url: ClassVar[str]

    def __init__(self) -> None:
        super().__init__()
        self.loop = asyncio.new_event_loop()
        self._scope = tenant_scope(TENANT_ZERO_ID)
        self._scope.__enter__()
        self.engine = create_async_engine(self.url)
        try:
            self._set_up()
        except BaseException:
            self._release()
            raise

    def _set_up(self) -> None:
        self.run(empty_the_database(self.engine))
        self.factory = create_session_factory(self.engine)
        self.lifecycle = _FakeLifecycle()
        self.service: ChatService
        self.service, self.room_service = _chat_service(
            self.factory,
            lifecycle=self.lifecycle,
            listener=_FakeListener(),
            activity=_FakeActivityListener(),
            connections=AgentConnectionRegistry(),
        )
        self.users: dict[str, User] = {}
        self.agent_ids: dict[str, str] = {}
        self.run(self._seed())
        # The model.
        self.member = dict.fromkeys(EVERYONE, True)
        self.owner = dict(AGENTS)
        self.chats: list[Chat] = []
        self.requests = 0
        self.counting = False
        # Start with a chat each kind of owner rule turns on: one with someone
        # else's agent, one with the other person's, one with the creator's own.
        self.create_chat("alice", "admin-bot")
        self.create_chat("bob", "alice-bot")
        self.create_chat("alice", "alice-bot")
        # And one membership held only for an agent: alice leaves her chat
        # with the admin's agent, and her own arrives.
        first = _Drawn(self.chats[0])
        self.leave("alice", first)  # type: ignore[arg-type]
        self.add_agent("alice", "alice-bot", first)  # type: ignore[arg-type]
        assert self.chats[0].members == {"alice": "owner"}
        # And carol, invited to bob's chat, so her leaving the workspace has a
        # chat to be refused.
        self.invite("bob", "carol", _Drawn(self.chats[1]))  # type: ignore[arg-type]
        # Coverage measures what the search reaches, not the set-up.
        self.counting = True

    async def _seed(self) -> None:
        async with self.factory() as session:
            for name in EVERYONE:
                user = User(name=name, email=f"{name}@example.invalid", role="user")
                session.add(user)
                await session.flush()
                await UserStore().add_membership(
                    session,
                    tenant_id=TENANT_ZERO_ID,
                    user_id=user.id,
                    role="admin" if name == ADMIN else "member",
                    organization_role="org_admin" if name == ADMIN else "member",
                )
                self.users[name] = user
            for name, owner in AGENTS.items():
                agent = await add_agent(
                    session, name=name, owner_id=self.users[owner].id
                )
                client = await session.get(Client, agent.client_id)
                assert client is not None
                self.lifecycle.agents[agent.id] = _agent_entry(client)
                self.agent_ids[name] = agent.id
            await session.commit()

    def run(self, coroutine: Any) -> Any:
        return self.loop.run_until_complete(coroutine)

    def teardown(self) -> None:
        self._release()

    def _release(self) -> None:
        try:
            self.run(self.engine.dispose())
        finally:
            self.loop.close()
            self._scope.__exit__(None, None, None)

    def _count(self, what: str) -> None:
        if self.counting:
            COVERAGE[what] += 1

    # ── The model ────────────────────────────────────────────────────────────

    def _owner_joins(self, person: str, chat: Chat) -> bool:
        """`sync_owned_rooms`'s rule: a chat the person started that holds an
        agent they own."""
        return chat.creator == person and any(
            self.owner[agent] == person for agent in chat.agents
        )

    def _manages(self, person: str, chat: Chat) -> bool:
        return person == ADMIN or chat.creator == person

    def _sync(self, person: str) -> None:
        if not self.member[person]:
            return
        for chat in self.chats:
            held = chat.members.get(person)
            if held is None and not chat.archived and self._owner_joins(person, chat):
                chat.members[person] = "owner"
                self._count("joined as an owner")
            elif held == "owner" and not self._owner_joins(person, chat):
                del chat.members[person]
                self._count("an owner membership taken back")

    def _sync_room(self, chat: Chat) -> None:
        """Everyone a change to the chat's agents may concern: the owners of
        its agents and those it holds for owning one."""
        concerned = {self.owner[agent] for agent in chat.agents} | {
            person for person, reason in chat.members.items() if reason == "owner"
        }
        for person in sorted(concerned):
            self._sync(person)

    def _reads(self, person: str, chat: Chat) -> bool:
        """`require_member`: a role and a membership, which an owner gains on
        the way when the rule holds."""
        if not self.member[person]:
            return False
        if person in chat.members:
            return True
        if not chat.archived and self._owner_joins(person, chat):
            self._sync(person)
            self._count("joined on reading")
            return person in chat.members
        return False

    def _make_lasting(self, person: str, chat: Chat) -> None:
        if chat.members.get(person) == "owner":
            self._count("an owner membership made lasting")
        chat.members[person] = "lasting"

    def _expect_refusal(self, call: Any, code: str | None, what: str) -> None:
        """Run `call`, which the model refuses with `code` (None: allows)."""
        try:
            self.run(call)
        except ChatError as error:
            assert code is not None, f"{what} was refused: {error.code} {error.message}"
            assert error.code == code, (
                f"{what} was refused with {error.code}, the model says {code}"
            )
            return
        assert code is None, f"{what} was allowed, the model refuses it ({code})"

    # ── Steps: chats ─────────────────────────────────────────────────────────

    @precondition(lambda self: len(self.chats) < MAX_ROOMS)
    @rule(creator=st.sampled_from(PEOPLE), agent=st.sampled_from(sorted(AGENTS)))
    def create_chat(self, creator: str, agent: str) -> None:
        if not self.member[creator]:
            return
        self.requests += 1
        room = self.run(
            self.service.create_chat(
                TENANT_ZERO_ID,
                self.users[creator],
                agent_ids=[self.agent_ids[agent]],
                member_user_ids=[],
                name=None,
                request_id=f"chat-{self.requests}",
                greeting=None,
                kind=None,
                bridge_id=None,
                resume_only=False,
            )
        )
        chat = Chat(room.id, creator, {agent}, members={creator: "lasting"})
        self.chats.append(chat)
        # Its agent joining syncs the people that concerns, as any change to
        # a room's agents does, which catches up a sync missed elsewhere.
        self._sync_room(chat)

    @precondition(lambda self: self.chats)
    @rule(person=st.sampled_from(EVERYONE), data=st.data())
    def read(self, person: str, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        allowed = self._reads(person, chat)

        async def go() -> None:
            async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
                await self.service.require_member(
                    session, TENANT_ZERO_ID, self.users[person], chat.room_id
                )

        self._expect_refusal(
            go(),
            None if allowed else "NOT_A_MEMBER",
            f"{person} reading {chat.room_id}",
        )
        if not self.member[person]:
            self._count("refused a reader outside the workspace")

    @precondition(lambda self: self.chats)
    @rule(person=st.sampled_from(EVERYONE), data=st.data())
    def leave(self, person: str, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        if not self.member[person]:
            return
        code: str | None = None
        if not self._reads(person, chat):
            code = "NOT_A_MEMBER"
        elif self._owner_joins(person, chat):
            code = "AGENT_OWNER"
            self._count("refused to remove an owner")
        call = self.service.remove_member(
            TENANT_ZERO_ID, self.users[person], chat.room_id, self.users[person].id
        )
        self._expect_refusal(call, code, f"{person} leaving {chat.room_id}")
        if code is None:
            del chat.members[person]

    @precondition(lambda self: self.chats)
    @rule(
        manager=st.sampled_from(EVERYONE),
        person=st.sampled_from(EVERYONE),
        data=st.data(),
    )
    def invite(self, manager: str, person: str, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        if not self.member[manager]:
            return
        code: str | None = None
        if not self._manages(manager, chat):
            code = "NOT_A_MANAGER"
        elif not self.member[person]:
            code = "NOT_A_TENANT_MEMBER"
        call = self.service.add_member(
            TENANT_ZERO_ID, self.users[manager], chat.room_id, self.users[person].id
        )
        self._expect_refusal(call, code, f"{manager} inviting {person}")
        if code is None:
            self._make_lasting(person, chat)

    @precondition(lambda self: self.chats)
    @rule(
        manager=st.sampled_from(EVERYONE),
        person=st.sampled_from(EVERYONE),
        data=st.data(),
    )
    def remove(self, manager: str, person: str, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        if not self.member[manager] or manager == person:
            return
        code: str | None = None
        if not self._manages(manager, chat):
            code = "NOT_A_MANAGER"
        elif person in chat.members and self._owner_joins(person, chat):
            code = "AGENT_OWNER"
            self._count("refused to remove an owner")
        call = self.service.remove_member(
            TENANT_ZERO_ID, self.users[manager], chat.room_id, self.users[person].id
        )
        self._expect_refusal(call, code, f"{manager} removing {person}")
        if code is None:
            chat.members.pop(person, None)

    @precondition(lambda self: self.chats)
    @rule(
        manager=st.sampled_from(EVERYONE),
        agent=st.sampled_from(sorted(AGENTS)),
        data=st.data(),
    )
    def add_agent(self, manager: str, agent: str, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        if not self.member[manager]:
            return
        code = None if self._manages(manager, chat) else "NOT_A_MANAGER"
        call = self.service.add_agent(
            TENANT_ZERO_ID, self.users[manager], chat.room_id, self.agent_ids[agent]
        )
        self._expect_refusal(call, code, f"{manager} adding {agent}")
        if code is None and agent not in chat.agents:
            chat.agents.add(agent)
            self._sync_room(chat)

    @precondition(lambda self: self.chats)
    @rule(data=st.data())
    def add_agent_unsynced(self, data: st.DataObject) -> None:
        """An agent of the chat's creator arrives while the room-agents
        listener fails, as one that lost its database does: the failure is
        logged, nobody is synced, and the creator's next read is what puts
        them in."""
        chat = data.draw(st.sampled_from(self.chats))
        theirs = sorted(
            agent
            for agent, owner in self.owner.items()
            if owner == chat.creator and agent not in chat.agents
        )
        if not theirs:
            return
        agent = data.draw(st.sampled_from(theirs))

        async def failing(tenant_id: str, room_id: str) -> None:
            raise ConnectionError("the database went away")

        listeners = self.room_service._room_agents_listeners
        self.room_service._room_agents_listeners = (failing,)
        try:
            self.run(
                self.room_service.add_agents_to_room(
                    chat.room_id, agent_ids=[self.agent_ids[agent]]
                )
            )
        finally:
            self.room_service._room_agents_listeners = listeners
        chat.agents.add(agent)

    @precondition(lambda self: self.chats)
    @rule(
        manager=st.sampled_from(EVERYONE),
        agent=st.sampled_from(sorted(AGENTS)),
        data=st.data(),
    )
    def remove_agent(self, manager: str, agent: str, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        if not self.member[manager]:
            return
        code = None if self._manages(manager, chat) else "NOT_A_MANAGER"
        call = self.service.remove_agent(
            TENANT_ZERO_ID, self.users[manager], chat.room_id, self.agent_ids[agent]
        )
        self._expect_refusal(call, code, f"{manager} removing {agent}")
        if code is None and agent in chat.agents:
            chat.agents.discard(agent)
            self._sync_room(chat)

    @precondition(lambda self: self.chats)
    @rule(person=st.sampled_from(EVERYONE), archived=st.booleans(), data=st.data())
    def archive(self, person: str, archived: bool, data: st.DataObject) -> None:
        chat = data.draw(st.sampled_from(self.chats))
        if not self.member[person]:
            return
        code: str | None = None
        if not self._reads(person, chat):
            code = "NOT_A_MEMBER"
        elif not self._manages(person, chat):
            code = "NOT_A_MANAGER"
        user = self.users[person]
        call = (
            self.service.archive(TENANT_ZERO_ID, user, chat.room_id)
            if archived
            else self.service.unarchive(TENANT_ZERO_ID, user, chat.room_id)
        )
        self._expect_refusal(call, code, f"{person} archiving={archived}")
        if code is None:
            chat.archived = archived

    # ── Steps: agents and the workspace ──────────────────────────────────────

    @rule(agent=st.sampled_from(sorted(AGENTS)), to=st.sampled_from(EVERYONE))
    def transfer(self, agent: str, to: str) -> None:
        """The agent changes hands, and each chat holding it is synced, as the
        ownership route does once the transfer commits."""
        if not self.member[to] or self.owner[agent] == to:
            return

        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    update(Agent)
                    .where(Agent.id == self.agent_ids[agent])
                    .values(owner_id=self.users[to].id)
                )
                await session.commit()
            for chat in self.chats:
                if agent in chat.agents:
                    await self.service.sync_room(TENANT_ZERO_ID, chat.room_id)

        self.run(go())
        self.owner[agent] = to
        for chat in self.chats:
            if agent in chat.agents:
                self._sync_room(chat)

    @rule(person=st.sampled_from(PEOPLE))
    def leave_workspace(self, person: str) -> None:
        """The person is removed from the workspace. The removal route refuses
        while they own an agent, so only someone who has handed theirs on
        leaves."""
        if person in self.owner.values():
            return

        async def go() -> None:
            async with self.factory() as session:
                await session.execute(
                    delete(TenantMember).where(
                        TenantMember.tenant_id == TENANT_ZERO_ID,
                        TenantMember.user_id == self.users[person].id,
                    )
                )
                await session.commit()

        self.run(go())
        self.member[person] = False

    @rule(person=st.sampled_from(PEOPLE))
    def rejoin_workspace(self, person: str) -> None:
        if self.member[person]:
            return

        async def go() -> None:
            async with self.factory() as session:
                await UserStore().add_membership(
                    session,
                    tenant_id=TENANT_ZERO_ID,
                    user_id=self.users[person].id,
                    role="member",
                    organization_role="member",
                )
                await session.commit()

        self.run(go())
        self.member[person] = True

    @rule(person=st.sampled_from(EVERYONE))
    def sync(self, person: str) -> None:
        self.run(self.service.sync_owned_rooms(TENANT_ZERO_ID, self.users[person].id))
        self._sync(person)

    # ── Invariants ───────────────────────────────────────────────────────────

    async def _rows(self) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
        """Every person's room memberships, and every owner mark."""
        names = {user.id: name for name, user in self.users.items()}
        async with self.factory() as session:
            joined = await session.execute(
                select(Client.user_id, ClientRoom.room_id)
                .join(ClientRoom, ClientRoom.client_id == Client.id)
                .where(Client.type == MEMBER_CLIENT_TYPE)
            )
            marks = await session.execute(
                select(ChatOwnerGrant.user_id, ChatOwnerGrant.room_id)
            )
            return (
                {(names[u], r) for u, r in joined.tuples() if u is not None},
                {(names[u], r) for u, r in marks.tuples()},
            )

    @invariant()
    def memberships_match_the_model(self) -> None:
        if not hasattr(self, "chats"):
            return
        joined, marks = self.run(self._rows())
        expected = {
            (person, chat.room_id) for chat in self.chats for person in chat.members
        }
        assert joined == expected, (
            f"members {sorted(joined - expected)} the model does not have, "
            f"missing {sorted(expected - joined)}"
        )
        held = {
            (person, chat.room_id)
            for chat in self.chats
            for person, reason in chat.members.items()
            if reason == "owner"
        }
        assert marks == held, (
            f"owner marks {sorted(marks - held)} the model holds as lasting, "
            f"missing {sorted(held - marks)}"
        )

    @invariant()
    def who_reads_matches_the_model(self) -> None:
        if not hasattr(self, "chats"):
            return

        async def go() -> dict[tuple[str, str], bool]:
            reads = {}
            async with tenant_session(self.factory, TENANT_ZERO_ID) as session:
                for chat in self.chats:
                    for person in EVERYONE:
                        _, may = await self.service.reads_room(
                            session, TENANT_ZERO_ID, self.users[person].id, chat.room_id
                        )
                        reads[(person, chat.room_id)] = may
            return reads

        for (person, room_id), may in self.run(go()).items():
            chat = next(chat for chat in self.chats if chat.room_id == room_id)
            expected = (
                self.member[person] and person in chat.members and not chat.archived
            )
            assert may == expected, (
                f"{person} {'reads' if may else 'cannot read'} {room_id}; the model "
                f"says {'they may' if expected else 'they may not'}"
            )


class _Drawn:
    """A draw already made, for the steps the set-up takes itself."""

    def __init__(self, value: object) -> None:
        self.value = value

    def draw(self, strategy: object) -> object:
        return self.value


def _agent_entry(client: Client) -> Any:
    return type(
        "Running",
        (),
        {"client_id": client.id, "transport_user_id": client.transport_user_id},
    )()


def machine_on(url: str) -> type[ChatsMachine]:
    """The machine against the database at `url`."""
    return type("ChatsMachineOnPostgres", (ChatsMachine,), {"url": url})
