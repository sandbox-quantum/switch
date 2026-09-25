"""Runs: the rooms agents create, kept as a tree a person can see and stop.

An agent can create a room, and a kickoff in that room can wake other agents
that create rooms of their own. Nothing about the shape of that chain says
whether it is going wrong: two agents that keep handing work to each other
across new rooms is often exactly what was meant. So the server does not
guess. It records the chain, stops the few requests that cannot work, and
leaves the rest to people, who can see every run and stop it.

**The run.** Every room an agent creates records the room it was working in
(``parent_room_id``) and the root of the chain (``run_id``), a room a person
made. A template a person runs is a run of its own, rooted at the room it
made. The run's state sits on its root (``run_control``): running, paused, or
stopped.

**What is refused**, before anything is created, with the reason:

* A second room while the agent's previous one is still being created. One at
  a time throttles an agent without counting anything.
* Any room in a run that is paused or stopped.
* A kickoff that mentions an agent whose addressing does not admit the
  creating agent. The room would sit there with nobody working in it, and
  the agent would be told it succeeded.
* The same request made again: the agent asks for a room with the same kickoff
  as a room it already made higher up the same path. That is the one pattern
  that marks a task going round, so the run is paused and its owner can let it
  continue.

**What an agent is told.** A kickoff an agent posts carries the run so far, so
the agents it wakes can see what already happened and decline to repeat it.
Whether two steps mean the same thing is a judgment the agents can make and
the server cannot.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING, Literal, cast

from pydantic import BaseModel
from sqlalchemy import func, select

from switch_core.addressing import can_address, parse_policy
from switch_core.clients.admin_client import AdminClient
from switch_core.clients.mentions import mention_regex, strip_emphasis

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.clients.client_lifecycle_service import ClientLifecycleService
    from switch_core.db.models import Agent, Room
    from switch_core.db.stores.agent_store import AgentStore
    from switch_core.db.stores.room_store import RoomStore

logger = logging.getLogger(__name__)

RunState = Literal["running", "paused", "stopped"]


class RunRefused(ValueError):
    """A room an agent asked for that was not created, and why. The message
    is written for the agent: it says what happened and what to do next."""


class RunControl(BaseModel):
    """The state kept on a run's root. Absent means running."""

    state: RunState
    reason: str | None = None
    # Who changed it last; None when the server paused the run itself.
    by_user_id: str | None = None
    by_name: str | None = None
    at: datetime
    # When a person last let a paused run continue. A repeat is only a repeat
    # of a room made after this, so each Continue allows one more round.
    resumed_at: datetime | None = None
    # The room the paused request would have repeated.
    repeat_of: str | None = None


def run_control(room: Room) -> RunControl | None:
    return RunControl.model_validate(room.run_control) if room.run_control else None


@dataclass(frozen=True)
class AgentOrigin:
    """An agent creating rooms, and where they go in its run.

    ``parent_room_id`` is the room the agent is working in, and ``run_id`` the
    root of that room's run. Both are None for an agent working in no room:
    what it creates starts a run of its own. ``trace`` is the run so far, as
    the agents a kickoff wakes are shown it.
    """

    agent_id: str
    agent_name: str
    owner_id: str | None
    owner_name: str | None
    parent_room_id: str | None
    run_id: str | None
    trace: str | None = None

    @property
    def headline_name(self) -> str:
        """How a kickoff names who it speaks for: the agent, and whose it is,
        without an @ so the agent does not wake on its own kickoff."""
        if self.owner_name is None:
            return self.agent_name
        return f"{self.agent_name}, {self.owner_name}'s agent"

    @property
    def owner_label(self) -> str:
        return self.owner_name or "The agent's owner"


def kickoff_fingerprint(text: str) -> str:
    """The same request, however it is spaced or capitalised."""
    normalised = " ".join(text.split()).casefold()
    return hashlib.sha256(normalised.encode()).hexdigest()


def mentioned(text: str, name: str, alias: str | None) -> bool:
    body = strip_emphasis(text)
    if mention_regex(name).search(body):
        return True
    return alias is not None and mention_regex(alias).search(body) is not None


class RunService:
    """Keeps runs: checks an agent's request against its run, records where
    the room goes, and lets a person pause, continue or stop a run."""

    def __init__(
        self,
        *,
        room_store: RoomStore,
        agent_store: AgentStore,
        session_factory: async_sessionmaker[AsyncSession],
        client_lifecycle: ClientLifecycleService | None = None,
    ) -> None:
        self._room_store = room_store
        self._agent_store = agent_store
        self._session_factory = session_factory
        self._client_lifecycle = client_lifecycle

    # ── An agent creating rooms ───────────────────────────────────────────

    @asynccontextmanager
    async def agent_creating(
        self,
        agent: Agent,
        *,
        owner_name: str | None,
        from_room_id: str | None,
        kickoffs: list[tuple[str, list[str], dict[str, str]]] | None = None,
    ) -> AsyncIterator[AgentOrigin]:
        """Hold the agent's one creation slot while its rooms are made.

        Everything that can refuse the request is checked here, before the
        caller creates anything, so a request is made whole or not at all.
        ``kickoffs`` lists each kickoff the request would post, with the
        agents in its room and their aliases (agent name to alias).
        """
        async with self._one_at_a_time(agent.id):
            origin = await self._origin(agent, owner_name, from_room_id)
            await self._check_open(origin)
            hashes = [kickoff_fingerprint(text) for text, _, _ in kickoffs or []]
            await self._check_repeat(origin, hashes)
            await self._check_audience(agent, kickoffs or [])
            if kickoffs:
                origin = replace(origin, trace=await self._trace(origin))
            yield origin

    @asynccontextmanager
    async def _one_at_a_time(self, agent_id: str) -> AsyncIterator[None]:
        """At most one room creation per agent at once, across every server
        process. A session-level advisory lock, held on one connection for as
        long as the creation runs and released with it, or with the
        connection if the process dies."""
        key = func.hashtext(f"agent-room-create:{agent_id}")
        async with self._session_factory() as session:
            got = (
                await session.execute(select(func.pg_try_advisory_lock(key)))
            ).scalar()
            if not got:
                raise RunRefused(
                    "You are already creating a room. Wait for it to finish, "
                    "then try again."
                )
            try:
                yield
            finally:
                await session.execute(select(func.pg_advisory_unlock(key)))

    async def _origin(
        self, agent: Agent, owner_name: str | None, from_room_id: str | None
    ) -> AgentOrigin:
        parent = None
        if from_room_id is not None:
            async with self._session_factory() as session:
                parent = await self._room_store.get(session, from_room_id)
        return AgentOrigin(
            agent_id=agent.id,
            agent_name=agent.name,
            owner_id=agent.owner_id,
            owner_name=owner_name,
            parent_room_id=parent.id if parent else None,
            run_id=(parent.run_id or parent.id) if parent else None,
        )

    async def _check_open(self, origin: AgentOrigin) -> None:
        if origin.run_id is None:
            return
        async with self._session_factory() as session:
            root = await self._room_store.get(session, origin.run_id)
        control = run_control(root) if root is not None else None
        if control is None or control.state == "running":
            return
        if control.state == "paused":
            raise RunRefused(
                f"Nothing was created: this run is paused. {control.reason} "
                f"The owner can let it continue from Templates in Switch Console."
            )
        raise RunRefused(
            f"Nothing was created: this run was stopped by "
            f"{control.by_name or 'its owner'}. No more rooms can be created in it."
        )

    async def _check_repeat(self, origin: AgentOrigin, hashes: list[str]) -> None:
        if origin.parent_room_id is None or origin.run_id is None or not hashes:
            return
        async with self._session_factory() as session:
            path = await self._room_store.path_to_root(session, origin.parent_room_id)
            root = await self._room_store.get(session, origin.run_id)
            control = run_control(root) if root is not None else None
            resumed_at = control.resumed_at if control else None
            repeated = next(
                (
                    room
                    for room in path
                    if room.created_by_agent_id == origin.agent_id
                    and room.kickoff_hash in hashes
                    and (
                        resumed_at is None
                        or cast(datetime, room.created_at) > resumed_at
                    )
                ),
                None,
            )
            if repeated is None:
                return
            reason = (
                f"{origin.agent_name} asked for a room with the same kickoff as "
                f'"{repeated.name}", which it already created on this path.'
            )
            await self._room_store.set_run_control(
                session,
                origin.run_id,
                RunControl(
                    state="paused",
                    reason=reason,
                    at=(
                        await session.execute(select(func.clock_timestamp()))
                    ).scalar_one(),
                    resumed_at=resumed_at,
                    repeat_of=repeated.id,
                ).model_dump(mode="json"),
            )
            await session.commit()
            parent = await self._room_store.get(session, origin.parent_room_id)
        if parent is not None:
            await self._notice(
                parent,
                f"Paused this run: {reason} {origin.owner_label} can let it "
                f"continue from Templates in Switch Console.",
            )
        raise RunRefused(
            f"Nothing was created, and the run is paused: {reason} If this is a "
            f"new step, say how it differs and ask {origin.owner_name or 'your owner'} "
            f"to let the run continue from Templates in Switch Console."
        )

    async def _check_audience(
        self, agent: Agent, kickoffs: list[tuple[str, list[str], dict[str, str]]]
    ) -> None:
        """Every agent a kickoff mentions must accept this agent, or the room
        would be made and nobody would start work in it."""
        refused: list[str] = []
        async with self._session_factory() as session:
            for text, names, aliases in kickoffs:
                for name in names:
                    if name == agent.name or not mentioned(
                        text, name, aliases.get(name)
                    ):
                        continue
                    target = await self._agent_store.get_by_name(session, name)
                    if target is None:
                        continue
                    policy = parse_policy(target.addressing_policy)
                    if policy.is_open() or can_address(
                        policy,
                        # A rule scoped to a room or group cannot name a room
                        # that does not exist yet.
                        room_id="",
                        group_id=None,
                        sender_kind="agent",
                        sender_id=agent.id,
                        sender_user_ids=[],
                        sender_owner_user_id=agent.owner_id,
                        owner_user_id=target.owner_id,
                    ):
                        continue
                    if name not in refused:
                        refused.append(name)
        if refused:
            listed = ", ".join(refused)
            raise RunRefused(
                f"Nothing was created: the kickoff mentions {listed}, and "
                f"{'it does' if len(refused) == 1 else 'they do'} not accept "
                f"messages from {agent.name}, so nobody would start work in the "
                f"room. Ask their owner to let {agent.name} address them (in "
                f"Switch Console, the agent's 'Who can talk to your agent'), or "
                f"leave them out of the kickoff."
            )

    async def _trace(self, origin: AgentOrigin) -> str | None:
        """The run so far, top down, as the woken agents are shown it."""
        if origin.parent_room_id is None:
            return None
        async with self._session_factory() as session:
            path = list(
                reversed(
                    await self._room_store.path_to_root(session, origin.parent_room_id)
                )
            )
            agent_ids = {r.created_by_agent_id for r in path if r.created_by_agent_id}
            names = {
                a.id: a.name
                for a in [await self._agent_store.get(session, i) for i in agent_ids]
                if a is not None
            }
        lines = []
        for i, room in enumerate(path, start=1):
            who = (
                f"created by {names.get(room.created_by_agent_id, 'an agent')}"
                if room.created_by_agent_id
                else "a person's room"
            )
            about = f": {room.description}" if room.description else ""
            lines.append(f"{i}. {room.name} ({who}){about}")
        lines.append(f"{len(path) + 1}. this room (created by {origin.agent_name})")
        return (
            "This room is part of a run that started in "
            f"{path[0].name}. So far:\n"
            + "\n".join(lines)
            + "\nIf you are asked to repeat a step that already ran, say so here "
            "and stop, rather than creating another room."
        )

    # ── A person controlling a run ────────────────────────────────────────

    async def may_control(
        self, session: AsyncSession, root_id: str, *, user_id: str, is_admin: bool
    ) -> bool:
        """Admins, the owner of an agent that created rooms in the run, and
        the person who ran the template that started it."""
        if is_admin:
            return True
        return any(
            room.created_by == user_id
            and (room.created_by_agent_id is not None or room.template_name is not None)
            for room in await self._room_store.run_rooms(session, root_id)
        )

    async def set_state(
        self,
        root_id: str,
        state: Literal["running", "stopped"],
        *,
        user_id: str,
        user_name: str,
    ) -> None:
        """Continue a paused run, or stop a run. Stopping keeps its rooms."""
        async with self._session_factory() as session:
            root = await self._room_store.get(session, root_id)
            if root is None:
                raise LookupError(root_id)
            current = run_control(root)
            if current is not None and current.state == "stopped":
                raise RunRefused("This run is already stopped.")
            # The database's clock, the one rooms are stamped with: a room made
            # after this Continue must compare as later, whatever the app
            # server's clock says.
            now = (await session.execute(select(func.clock_timestamp()))).scalar_one()
            control = RunControl(
                state=state,
                reason=None,
                by_user_id=user_id,
                by_name=user_name,
                at=now,
                resumed_at=now
                if state == "running"
                else (current.resumed_at if current else None),
            )
            await self._room_store.set_run_control(
                session, root_id, control.model_dump(mode="json")
            )
            await session.commit()
            rooms = await self._room_store.run_rooms(session, root_id)
        if state == "stopped":
            text = (
                f"{user_name} stopped this run. Agents can no longer create rooms "
                "in it; the rooms stay as they are."
            )
            for room in rooms:
                if room.archived_at is None:
                    await self._notice(room, text)
        elif current is not None and current.state == "paused" and current.repeat_of:
            text = f"{user_name} let this run continue."
            for room in rooms:
                if room.id == current.repeat_of:
                    await self._notice(room, text)

    async def _notice(self, room: Room, text: str) -> None:
        """Best effort: the state has changed whether or not the note lands."""
        if self._client_lifecycle is None:
            return
        admins = self._client_lifecycle.get_by_type("admin", room.tenant_id)
        admin = next((c for c in admins if isinstance(c, AdminClient)), None)
        if admin is None:
            return
        try:
            await admin.send_notice(room.matrix_room_id, text)
        except Exception:  # noqa: BLE001 - a note is not worth failing a stop
            logger.warning("Could not post a run notice in %s", room.id, exc_info=True)
