from datetime import UTC, datetime

from sqlalchemy import delete, insert, or_, select, update
from sqlalchemy import func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ClientRoom, Room, RoomGroup, room_agents


class RoomStore:
    async def create(self, session: AsyncSession, room: Room) -> Room:
        session.add(room)
        await session.flush()
        return room

    async def get(self, session: AsyncSession, room_id: str) -> Room | None:
        return await session.get(Room, room_id)

    async def get_by_matrix_room_id(
        self, session: AsyncSession, matrix_room_id: str
    ) -> Room | None:
        result = await session.execute(
            select(Room).where(Room.matrix_room_id == matrix_room_id)
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

    async def get_agent_ids(self, session: AsyncSession, room_id: str) -> list[str]:
        result = await session.execute(
            select(room_agents.c.agent_id).where(room_agents.c.room_id == room_id)
        )
        return list(result.scalars().all())

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
        session.add(ClientRoom(client_id=client_id, room_id=room_id))
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

    async def get_client_ids(self, session: AsyncSession, room_id: str) -> list[str]:
        result = await session.execute(
            select(ClientRoom.client_id).where(ClientRoom.room_id == room_id)
        )
        return list(result.scalars().all())

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
