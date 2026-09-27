from collections.abc import Collection
from datetime import UTC, datetime

from sqlalchemy import delete, insert, or_, select, update
from sqlalchemy import func as sa_func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    Room,
    RoomGroup,
    require_tenant_id,
    room_agents,
)
from switch_core.db.sql import any_of


class RoomStore:
    async def create(self, session: AsyncSession, room: Room) -> Room:
        session.add(room)
        await session.flush()
        return room

    async def get(self, session: AsyncSession, room_id: str) -> Room | None:
        return await session.get(Room, room_id)

    async def get_with_membership(
        self, session: AsyncSession, room_id: str, agent_id: str
    ) -> tuple[Room, bool] | None:
        """The room plus whether `agent_id` is one of its members.

        `None` when no such room exists, which the caller must distinguish
        from a room the agent simply cannot see. Outer-joined so both answers
        come back in one statement — the pair is the single most frequent
        authorization question in the bridge.
        """
        result = await session.execute(
            select(Room, room_agents.c.agent_id)
            .outerjoin(
                room_agents,
                (Room.id == room_agents.c.room_id)
                & (room_agents.c.agent_id == agent_id),
            )
            .where(Room.id == room_id)
        )
        row = result.one_or_none()
        if row is None:
            return None
        return row[0], row[1] is not None

    async def get_by_matrix_room_id(
        self, session: AsyncSession, matrix_room_id: str
    ) -> Room | None:
        """Resolve a room by its Matrix room id within the bound tenant.

        Scoped explicitly rather than left to row-level security:
        `matrix_room_id` is unique per tenant
        (`uq_rooms_tenant_matrix_room_id`), not globally, so the moment a
        second tenant has a room bound to the same transport id, an unfiltered
        read here matches both rows and raises `MultipleResultsFound` out of
        every inbound-event path that resolves a room this way (provisioning,
        the Postgres transport, admin commands). Every caller that reaches
        this by now already knows its tenant — `PostgresTransport` and the
        two `ClientBase` subclasses carry it on the row they were built from,
        and `PostgresProvisioning` is only ever called from `room_service`
        inside a `tenant_scope` bound to the room it is acting on — so there
        is no bootstrap case left that needs an unfiltered fallback, the same
        as `ClientStore.get_by_matrix_user_id`.
        """
        result = await session.execute(
            select(Room).where(
                Room.tenant_id == require_tenant_id(),
                Room.matrix_room_id == matrix_room_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_all(
        self, session: AsyncSession, *, include_archived: bool = False
    ) -> list[Room]:
        stmt = select(Room)
        if not include_archived:
            stmt = stmt.where(Room.archived_at.is_(None))
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def list_readable(
        self,
        session: AsyncSession,
        user_id: str,
        *,
        is_admin: bool,
        include_archived: bool = False,
    ) -> list[Room]:
        """Return rooms the user may read: owned, publicly readable, or all
        if admin. Archived rooms are excluded unless `include_archived`."""
        stmt = select(Room)
        if not is_admin:
            stmt = stmt.where(
                or_(Room.owner_id == user_id, Room.read_visibility == "public")
            )
        if not include_archived:
            stmt = stmt.where(Room.archived_at.is_(None))
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def delete(self, session: AsyncSession, room_id: str) -> None:
        await session.execute(delete(ClientRoom).where(ClientRoom.room_id == room_id))
        await session.execute(
            delete(room_agents).where(room_agents.c.room_id == room_id)
        )
        room = await session.get(Room, room_id)
        if room:
            await session.delete(room)
        await session.flush()

    async def update_bridge(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        bridge_id: str,
        channel_type: str,
        external_channel_id: str | None,
    ) -> None:
        room = await session.get(Room, room_id)
        if room is None:
            return
        room.bridge_id = bridge_id
        room.channel_type = channel_type
        room.external_channel_id = external_channel_id
        await session.flush()

    async def clear_bridge(self, session: AsyncSession, room_id: str) -> None:
        room = await session.get(Room, room_id)
        if room is None:
            return
        room.bridge_id = None
        room.channel_type = None
        room.external_channel_id = None
        await session.flush()

    async def add_agents(
        self,
        session: AsyncSession,
        room_id: str,
        agent_ids: list[str],
        *,
        join_event_listeners: set[str] | None = None,
    ) -> None:
        """Add agents to a room.

        `join_event_listeners` is the subset of `agent_ids` that should receive
        `room_join` events in this room. Any agent not in that set keeps the
        column default (off) — agents are opted in to join events explicitly.
        """
        if not agent_ids:
            return
        listeners = join_event_listeners or set()
        await session.execute(
            insert(room_agents),
            [
                {
                    "room_id": room_id,
                    "agent_id": aid,
                    "receives_join_events": aid in listeners,
                }
                for aid in agent_ids
            ],
        )
        await session.flush()

    async def set_receives_join_events(
        self, session: AsyncSession, room_id: str, agent_id: str, value: bool
    ) -> None:
        """Toggle whether `agent_id` receives `room_join` events in `room_id`.

        Raises ValueError if the agent is not a member of the room.
        """
        result = await session.execute(
            update(room_agents)
            .where(
                room_agents.c.room_id == room_id,
                room_agents.c.agent_id == agent_id,
            )
            .values(receives_join_events=value)
        )
        if not result.rowcount:  # type: ignore[attr-defined]
            raise ValueError(f"Agent {agent_id} is not a member of room {room_id}")
        await session.flush()

    async def get_receives_join_events(
        self, session: AsyncSession, room_id: str, agent_id: str
    ) -> bool:
        """Whether `agent_id` is configured to receive `room_join` events in
        `room_id`. Returns False if the agent is not a member."""
        result = await session.execute(
            select(room_agents.c.receives_join_events).where(
                room_agents.c.room_id == room_id,
                room_agents.c.agent_id == agent_id,
            )
        )
        return bool(result.scalar_one_or_none())

    async def get_join_event_listeners(
        self, session: AsyncSession, room_id: str
    ) -> list[str]:
        """Agent ids in `room_id` configured to receive `room_join` events."""
        result = await session.execute(
            select(room_agents.c.agent_id).where(
                room_agents.c.room_id == room_id,
                room_agents.c.receives_join_events.is_(True),
            )
        )
        return list(result.scalars().all())

    async def remove_agents(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> None:
        if not agent_ids:
            return
        await session.execute(
            delete(room_agents).where(
                room_agents.c.room_id == room_id,
                room_agents.c.agent_id.in_(agent_ids),
            )
        )
        await session.flush()

    async def get_rooms_for_agent(
        self, session: AsyncSession, agent_id: str, *, include_archived: bool = False
    ) -> list[Room]:
        stmt = (
            select(Room)
            .join(room_agents, Room.id == room_agents.c.room_id)
            .where(room_agents.c.agent_id == agent_id)
        )
        if not include_archived:
            stmt = stmt.where(Room.archived_at.is_(None))
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def get_agent_room_memberships(
        self, session: AsyncSession, agent_id: str
    ) -> list[tuple[str, str, bool]]:
        """`[(room_id, name, archived)]` for every room the agent is in.

        The three columns the agent-detail view actually renders, as plain
        values. `get_rooms_for_agent` answers the same question with mapped
        `Room` objects, which for this caller means SQLAlchemy building a full
        entity — identity map, attribute state, change tracking — per row, to
        read a name off it and discard the rest. Archived rooms are included:
        the view lists them, marked.
        """
        result = await session.execute(
            select(Room.id, Room.name, Room.archived_at)
            .join(room_agents, Room.id == room_agents.c.room_id)
            .where(room_agents.c.agent_id == agent_id)
        )
        return [
            (room_id, name, archived_at is not None)
            for room_id, name, archived_at in result.all()
        ]

    async def get_memberships_by_agent(
        self, session: AsyncSession
    ) -> dict[str, list[tuple[str, str, bool]]]:
        """`{agent_id: [(room_id, name, archived)]}` for the bound tenant.

        Every membership in one read. The per-agent form of this question,
        asked once per agent, is what Switch Console's sidebar refresh was
        doing — seventy requests every twenty seconds, each assembling a full
        agent detail to have three fields taken off it.

        Only agents that are in at least one room appear. The endpoint fills
        in the empty ones, because "in no rooms" and "not in the answer" are
        different things to a caller and the join cannot tell them apart.
        """
        result = await session.execute(
            select(room_agents.c.agent_id, Room.id, Room.name, Room.archived_at).join(
                Room, Room.id == room_agents.c.room_id
            )
        )
        out: dict[str, list[tuple[str, str, bool]]] = {}
        for agent_id, room_id, name, archived_at in result.all():
            out.setdefault(agent_id, []).append(
                (room_id, name, archived_at is not None)
            )
        return out

    async def get_agent_ids(self, session: AsyncSession, room_id: str) -> list[str]:
        result = await session.execute(
            select(room_agents.c.agent_id).where(room_agents.c.room_id == room_id)
        )
        return list(result.scalars().all())

    async def get_agent_ids_for_rooms(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, list[str]]:
        """`{room_id: [agent_id]}` for several rooms in one read.

        Every room asked about gets an entry, empty ones included, so a caller
        can index it directly rather than guarding each lookup.

        For the room list, which needs this for every room it returns and was
        asking one room at a time — fifty rooms, fifty round trips, each
        paying the async-bridge toll that dominates our per-query cost far
        more than the query itself does.
        """
        if not room_ids:
            return {}
        result = await session.execute(
            select(room_agents.c.room_id, room_agents.c.agent_id).where(
                any_of(room_agents.c.room_id, room_ids)
            )
        )
        out: dict[str, list[str]] = {room_id: [] for room_id in room_ids}
        for room_id, agent_id in result.all():
            out[room_id].append(agent_id)
        return out

    async def get_alias(
        self, session: AsyncSession, room_id: str, agent_id: str
    ) -> str | None:
        """The agent's alias in this room, or None if it has none."""
        result = await session.execute(
            select(room_agents.c.alias).where(
                room_agents.c.room_id == room_id,
                room_agents.c.agent_id == agent_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_aliases(self, session: AsyncSession, room_id: str) -> dict[str, str]:
        """Map of agent_id -> alias for every agent in the room that has one."""
        result = await session.execute(
            select(room_agents.c.agent_id, room_agents.c.alias).where(
                room_agents.c.room_id == room_id,
                room_agents.c.alias.is_not(None),
            )
        )
        return {agent_id: alias for agent_id, alias in result.all()}

    async def get_agent_id_by_alias(
        self, session: AsyncSession, room_id: str, alias: str
    ) -> str | None:
        """Resolve a room alias to its agent_id (case-insensitive), or None."""
        result = await session.execute(
            select(room_agents.c.agent_id).where(
                room_agents.c.room_id == room_id,
                sa_func.lower(room_agents.c.alias) == alias.lower(),
            )
        )
        return result.scalar_one_or_none()

    async def set_alias(
        self, session: AsyncSession, room_id: str, agent_id: str, alias: str | None
    ) -> None:
        """Set (or clear, with alias=None) an agent's alias in this room.

        Raises ValueError if the agent is not a member of the room. Validation
        of the alias value (format, collisions) is the caller's responsibility.
        """
        result = await session.execute(
            update(room_agents)
            .where(
                room_agents.c.room_id == room_id,
                room_agents.c.agent_id == agent_id,
            )
            .values(alias=alias)
        )
        if not result.rowcount:  # type: ignore[attr-defined]
            raise ValueError(f"Agent {agent_id} is not a member of room {room_id}")
        await session.flush()

    async def add_client(
        self, session: AsyncSession, client_id: str, room_id: str
    ) -> None:
        """Record a membership, tolerating one that is already there.

        Membership has more than one writer. Over Matrix it effectively had
        one: an invitation was accepted later, over sync, long after the
        inviting transaction had committed, so `room_service` was the only
        thing writing this table. On the Postgres transport the invitation is
        the join — synchronous and in-process — so the joining client writes
        the row and the inviting caller then writes it again.

        A plain insert made that second write an IntegrityError that rolled
        the caller's whole transaction back, leaving an agent a member of the
        room but not one of its agents: receiving messages while
        `!list-agents` reported nobody. The conflict is a correct outcome
        rather than a failure — the membership exists, which is what the
        caller asked for — and this also closes the check-then-insert race
        between two concurrent invitations.
        """
        await session.execute(
            pg_insert(ClientRoom)
            .values(client_id=client_id, room_id=room_id)
            .on_conflict_do_nothing(index_elements=["client_id", "room_id"])
        )
        await session.flush()

    async def remove_client(
        self, session: AsyncSession, client_id: str, room_id: str
    ) -> None:
        await session.execute(
            delete(ClientRoom).where(
                ClientRoom.client_id == client_id,
                ClientRoom.room_id == room_id,
            )
        )
        await session.flush()

    async def get_for_client(self, session: AsyncSession, client_id: str) -> list[Room]:
        """The rooms a client is a member of.

        The mirror of `get_client_ids`, and what a client asks for when it
        wants to know where it belongs — over Matrix that question went to the
        homeserver, which answered from the same memberships this table holds.
        """
        result = await session.execute(
            select(Room)
            .join(ClientRoom, ClientRoom.room_id == Room.id)
            .where(ClientRoom.client_id == client_id)
        )
        return list(result.scalars().all())

    async def get_client_ids(self, session: AsyncSession, room_id: str) -> list[str]:
        result = await session.execute(
            select(ClientRoom.client_id).where(ClientRoom.room_id == room_id)
        )
        return list(result.scalars().all())

    async def get_client_ids_for_rooms(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, list[str]]:
        """`{room_id: [client_id]}` for several rooms in one read.

        The companion to `get_agent_ids_for_rooms`, and for the same caller:
        the room list needed both per room, so it was making two round trips
        per row it rendered. Rooms with no clients get an empty list.
        """
        if not room_ids:
            return {}
        result = await session.execute(
            select(ClientRoom.room_id, ClientRoom.client_id).where(
                any_of(ClientRoom.room_id, room_ids)
            )
        )
        out: dict[str, list[str]] = {room_id: [] for room_id in room_ids}
        for room_id, client_id in result.all():
            out[room_id].append(client_id)
        return out

    async def get_member_agent_clients(
        self, session: AsyncSession, room_id: str
    ) -> dict[str, str]:
        """`{client_id: matrix_user_id}` for the agents this room has as members.

        Resolved from the database rather than from the running client
        registry, so it answers correctly before the agent clients have
        finished booting.
        """
        result = await session.execute(
            select(Client.id, Client.matrix_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .join(room_agents, room_agents.c.agent_id == Agent.id)
            .where(room_agents.c.room_id == room_id)
        )
        return {client_id: matrix_user_id for client_id, matrix_user_id in result.all()}

    async def get_by_bridge(self, session: AsyncSession, bridge_id: str) -> list[Room]:
        result = await session.execute(select(Room).where(Room.bridge_id == bridge_id))
        return list(result.scalars().all())

    async def get_by_external_channel(
        self,
        session: AsyncSession,
        bridge_id: str,
        external_channel_id: str,
    ) -> Room | None:
        result = await session.execute(
            select(Room).where(
                Room.bridge_id == bridge_id,
                Room.external_channel_id == external_channel_id,
            )
        )
        return result.scalar_one_or_none()

    async def update_external_channel(
        self, session: AsyncSession, room_id: str, external_channel_id: str
    ) -> None:
        """Re-point a bridged room at a new external channel id, keeping its
        bridge and channel type. For a platform that reissues a channel's id
        under the room (Telegram, when a group becomes a supergroup)."""
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        room.external_channel_id = external_channel_id
        await session.flush()

    async def update_protection_config(
        self, session: AsyncSession, room_id: str, config: dict[str, object]
    ) -> None:
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        room.protection_config = config  # type: ignore[assignment]
        await session.flush()

    async def update_observe_config(
        self, session: AsyncSession, room_id: str, config: dict[str, object]
    ) -> None:
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        room.observe_config = config  # type: ignore[assignment]
        await session.flush()

    async def set_archived(
        self, session: AsyncSession, room_id: str, archived: bool
    ) -> None:
        """Archive or unarchive a room (metadata-only, reversible).

        Archiving stamps `archived_at` with the current UTC time; unarchiving
        clears it. Raises ValueError if the room does not exist.
        """
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        if archived:
            room.archived_at = datetime.now(UTC)  # type: ignore[assignment]
        else:
            room.archived_at = None
        await session.flush()

    async def update_fields(
        self,
        session: AsyncSession,
        room_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        instructions: str | None = None,
        admin_mode: bool | None = None,
        read_visibility: str | None = None,
        write_visibility: str | None = None,
    ) -> None:
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        if name is not None:
            room.name = name
        if description is not None:
            room.description = description
        if instructions is not None:
            room.instructions = instructions
        if admin_mode is not None:
            room.admin_mode = admin_mode
        if read_visibility is not None:
            room.read_visibility = read_visibility
        if write_visibility is not None:
            room.write_visibility = write_visibility
        await session.flush()

    async def set_group(
        self, session: AsyncSession, room_id: str, group_id: str | None
    ) -> None:
        """Assign the room to a group, or make it standalone (`group_id=None`)."""
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        if group_id is not None:
            group = await session.get(RoomGroup, group_id)
            if group is None:
                raise ValueError(f"Room group not found: {group_id}")
        room.group_id = group_id
        await session.flush()

    async def set_group_bulk(
        self, session: AsyncSession, room_ids: list[str], group_id: str | None
    ) -> int:
        """Assign many rooms to a group (or `None` for standalone) in one UPDATE.

        The caller is responsible for validating the group and authorizing the
        rooms. Returns the number of rows updated.
        """
        if not room_ids:
            return 0
        result = await session.execute(
            update(Room).where(Room.id.in_(room_ids)).values(group_id=group_id)
        )
        await session.flush()
        return result.rowcount or 0  # type: ignore[attr-defined]
