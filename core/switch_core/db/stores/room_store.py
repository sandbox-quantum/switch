from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import (
    ColumnElement,
    delete,
    exists,
    literal,
    or_,
    select,
    update,
)
from sqlalchemy import func as sa_func
from sqlalchemy import tuple_ as sa_tuple
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.id_lists import any_of
from switch_core.db.models import (
    Agent,
    Client,
    ClientRoom,
    ExternalUser,
    ExternalUserClaim,
    Room,
    RoomGroup,
    require_tenant_id,
    room_agents,
)
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore

# Where a room's name came from, in its `metadata`: "channel" for a bridged
# room named after its channel (it follows the channel's renames), "custom"
# once a person or an agent names it. Absent on rooms from before it was kept.
NAME_SOURCE_KEY = "name_source"
# The linked platform channel's name as the bridge last saw it.
LINKED_CHANNEL_NAME_KEY = "linked_channel_name"

# Keys in a room's `metadata` for the follow-the-conversation settings. Both
# are absent by default (follow-ups on, no main agent), so rooms made before
# the settings existed need no backfill.
# `!follow-ups off`:
FOLLOW_UPS_OFF_KEY = "follow_ups_off"
# `!assign-agent @name`: the agent id every message in the room goes to.
MAIN_AGENT_KEY = "main_agent_id"


def follow_ups_enabled_in(metadata: dict | None) -> bool:
    """Whether a room's metadata leaves follow-ups on."""
    return (metadata or {}).get(FOLLOW_UPS_OFF_KEY) is not True


def main_agent_in(metadata: dict | None) -> str | None:
    """The main agent a room's metadata names, if any."""
    value = (metadata or {}).get(MAIN_AGENT_KEY)
    return value if isinstance(value, str) else None


@dataclass(frozen=True)
class Membership:
    """A client's membership of one room, as `client_rooms` records it."""

    room_id: str
    transport_room_id: str
    joined_at: datetime


class RoomStore:
    async def create(self, session: AsyncSession, room: Room) -> Room:
        session.add(room)
        await session.flush()
        return room

    async def get(self, session: AsyncSession, room_id: str) -> Room | None:
        return await session.get(Room, room_id)

    async def follow_ups_enabled(self, session: AsyncSession, room_id: str) -> bool:
        """Whether follow-ups are on in this room: the room's `!follow-ups`
        setting, on unless someone turned it off."""
        room = await session.get(Room, room_id)
        if room is None:
            return False
        return follow_ups_enabled_in(room.metadata_)

    async def set_follow_ups_enabled(
        self, session: AsyncSession, room_id: str, enabled: bool
    ) -> None:
        """Turn follow-ups on or off for a room. Raises ValueError for a room
        that does not exist."""
        await self._set_metadata_key(
            session, room_id, FOLLOW_UPS_OFF_KEY, None if enabled else True
        )

    async def main_agent_id(self, session: AsyncSession, room_id: str) -> str | None:
        """The room's main agent (`!assign-agent`), or None."""
        room = await session.get(Room, room_id)
        if room is None:
            return None
        return main_agent_in(room.metadata_)

    async def set_main_agent(
        self, session: AsyncSession, room_id: str, agent_id: str | None
    ) -> None:
        """Set (or clear, with None) the room's main agent. Raises ValueError
        for a room that does not exist."""
        await self._set_metadata_key(session, room_id, MAIN_AGENT_KEY, agent_id)

    async def _set_metadata_key(
        self, session: AsyncSession, room_id: str, key: str, value: object
    ) -> None:
        """Set one key in the room's metadata, or remove it when `value` is
        None, leaving every other key as it was."""
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room {room_id} does not exist")
        metadata = dict(room.metadata_ or {})
        if value is None:
            metadata.pop(key, None)
        else:
            metadata[key] = value
        room.metadata_ = metadata
        await session.flush()

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

    async def get_by_transport_room_id(
        self, session: AsyncSession, transport_room_id: str
    ) -> Room | None:
        """Resolve a room by its transport room id (`transport_room_id`) within the bound tenant.

        Scoped explicitly rather than left to row-level security:
        `matrix_room_id` is unique per tenant
        (`uq_rooms_tenant_matrix_room_id`), not globally, so the moment a
        second tenant has a room bound to the same transport id, an unfiltered
        read here matches both rows and raises `MultipleResultsFound` out of
        every inbound-event path that resolves a room this way (provisioning,
        the Postgres transport, admin commands). Every caller that reaches
        this by now already knows its tenant — `PostgresTransport` and the
        two `Actor` subclasses carry it on the row they were built from,
        and `PostgresProvisioning` is only ever called from `room_service`
        inside a `tenant_scope` bound to the room it is acting on — so there
        is no bootstrap case left that needs an unfiltered fallback, the same
        as `ClientStore.get_by_transport_user_id`.
        """
        result = await session.execute(
            select(Room).where(
                Room.tenant_id == require_tenant_id(),
                Room.transport_room_id == transport_room_id,
            )
        )
        return result.scalar_one_or_none()

    async def run_rooms(self, session: AsyncSession, root_id: str) -> list[Room]:
        """Every room of the run rooted at ``root_id``, the root first, then in
        the order they were created. Archived rooms are included: a run is a
        record of what happened."""
        result = await session.execute(
            select(Room)
            .where(or_(Room.id == root_id, Room.run_id == root_id))
            .order_by(Room.run_id.is_not(None), Room.created_at)
        )
        return list(result.scalars().all())

    async def path_to_root(self, session: AsyncSession, room_id: str) -> list[Room]:
        """``room_id`` and each room above it, up to the root of its run.

        Parents are set when a room is created and never change, so the walk
        cannot loop; the bound is only there so a corrupted row cannot hang a
        request."""
        path: list[Room] = []
        current: str | None = room_id
        while current is not None and len(path) < 1000:
            room = await session.get(Room, current)
            if room is None:
                break
            path.append(room)
            current = room.parent_room_id
        return path

    async def set_run_control(
        self, session: AsyncSession, root_id: str, control: dict[str, object] | None
    ) -> None:
        await session.execute(
            update(Room).where(Room.id == root_id).values(run_control=control)
        )

    async def recent_run_roots(
        self, session: AsyncSession, *, user_id: str | None, limit: int
    ) -> list[str]:
        """The roots of the runs most recently added to, newest first.

        A run is a template a person ran or a room an agent created, with
        everything agents created below it. With ``user_id`` only the runs that
        user took part in count: a template they ran, or a room one of their
        agents created (``created_by`` is the agent's owner on that path).
        Without it, every run, which is what an admin sees."""
        root = sa_func.coalesce(Room.run_id, Room.id)
        in_run = or_(
            Room.run_id.is_not(None),
            Room.template_name.is_not(None),
            Room.created_by_agent_id.is_not(None),
        )
        stmt = select(root).where(in_run)
        if user_id is not None:
            stmt = stmt.where(
                Room.created_by == user_id,
                or_(
                    Room.created_by_agent_id.is_not(None),
                    Room.template_name.is_not(None),
                ),
            )
        stmt = stmt.group_by(root).order_by(sa_func.max(Room.created_at).desc())
        result = await session.execute(stmt.limit(limit))
        return [row[0] for row in result.all()]

    async def get_all(
        self, session: AsyncSession, *, include_archived: bool = False
    ) -> list[Room]:
        stmt = select(Room)
        if not include_archived:
            stmt = stmt.where(Room.archived_at.is_(None))
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def page_all(
        self,
        session: AsyncSession,
        *,
        include_archived: bool,
        name_contains: str | None,
        limit: int,
        after: tuple[datetime, str] | None,
    ) -> list[Room]:
        """Up to `limit` rooms after the `(created_at, id)` position `after`,
        oldest first, whose name contains `name_contains` (any case)."""
        stmt = select(Room)
        if not include_archived:
            stmt = stmt.where(Room.archived_at.is_(None))
        if name_contains:
            stmt = stmt.where(Room.name.icontains(name_contains, autoescape=True))
        if after is not None:
            stmt = stmt.where(
                sa_tuple(Room.created_at, Room.id)
                > sa_tuple(literal(after[0]), literal(after[1]))
            )
        stmt = stmt.order_by(Room.created_at, Room.id).limit(limit)
        return list((await session.execute(stmt)).scalars().all())

    async def list_readable(
        self,
        session: AsyncSession,
        user_id: str,
        *,
        is_admin: bool,
        include_archived: bool = False,
    ) -> list[Room]:
        """Return rooms the user may read: publicly readable, ones they take
        part in (`involves`), or all if admin. Archived rooms are excluded
        unless `include_archived`."""
        stmt = select(Room)
        if not is_admin:
            stmt = stmt.where(or_(Room.read_visibility == "public", involves(user_id)))
        if not include_archived:
            stmt = stmt.where(Room.archived_at.is_(None))
        result = await session.execute(stmt)
        return list(result.scalars().all())

    async def involved_room_ids(
        self, session: AsyncSession, user_id: str, room_ids: Collection[str]
    ) -> set[str]:
        """Of `room_ids`, the rooms `involves(user_id)` holds for."""
        if not room_ids:
            return set()
        result = await session.execute(
            select(Room.id).where(Room.id.in_(room_ids), involves(user_id))
        )
        return set(result.scalars().all())

    async def delete(self, session: AsyncSession, room_id: str) -> None:
        await session.execute(delete(ClientRoom).where(ClientRoom.room_id == room_id))
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

    async def correct_channel_type(
        self,
        session: AsyncSession,
        *,
        bridge_id: str,
        external_channel_id: str,
        channel_type: str,
    ) -> list[str]:
        """Set `channel_type` on this bridge's rooms bound to the channel and
        saved as a channel of the other privacy; returns the ids that changed."""
        result = await session.execute(
            update(Room)
            .where(
                Room.bridge_id == bridge_id,
                Room.external_channel_id == external_channel_id,
                Room.channel_type.in_(("channel_public", "channel_private")),
                Room.channel_type != channel_type,
            )
            .values(channel_type=channel_type)
            .returning(Room.id)
        )
        return list(result.scalars().all())

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
        An agent already in the room is left as it is, so two concurrent adds
        of the same agent both succeed.
        """
        if not agent_ids:
            return
        listeners = join_event_listeners or set()
        await session.execute(
            pg_insert(room_agents).on_conflict_do_nothing(),
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
        # An agent that leaves stops being the room's main agent, as its alias
        # goes with its membership row.
        room = await session.get(Room, room_id)
        if room is not None and main_agent_in(room.metadata_) in agent_ids:
            await self.set_main_agent(session, room_id, None)
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

    async def agent_ids_by_room(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, list[str]]:
        """`get_agent_ids` for many rooms in one query, keyed by room id.

        A room with no agents has no key. For a list of rooms, which would
        otherwise read each room's members on a connection it holds for every
        round trip.
        """
        if not room_ids:
            return {}
        result = await session.execute(
            select(room_agents.c.room_id, room_agents.c.agent_id).where(
                room_agents.c.room_id.in_(room_ids)
            )
        )
        by_room: dict[str, list[str]] = {}
        for room_id, agent_id in result.all():
            by_room.setdefault(room_id, []).append(agent_id)
        return by_room

    async def get_many(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, Room]:
        """The rooms among `room_ids` that exist, keyed by id, in one query."""
        if not room_ids:
            return {}
        result = await session.execute(select(Room).where(Room.id.in_(room_ids)))
        return {room.id: room for room in result.scalars().all()}

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
    ) -> bool:
        """Record a membership, tolerating one that is already there, and
        say whether this call recorded it.

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

        Whoever recorded it writes the arrival that announces it, and nobody
        else does: two writers racing for one membership must not greet the
        room twice.
        """
        recorded = await session.scalar(
            pg_insert(ClientRoom)
            .values(client_id=client_id, room_id=room_id)
            .on_conflict_do_nothing(index_elements=["client_id", "room_id"])
            .returning(ClientRoom.client_id)
        )
        # The client's consumer starts reading the room here, wherever and
        # whenever it learns of the membership: the process that owns the
        # client may not be this one. A membership that already existed keeps
        # the cursor it has.
        await DeliveryCursorStore().seed(session, client_id, room_id)
        await session.flush()
        return recorded is not None

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

    async def memberships_of(
        self, session: AsyncSession, client_id: str
    ) -> list[Membership]:
        """Every room the client is a member of, with both its ids and when
        the client joined, in one query."""
        result = await session.execute(
            select(ClientRoom.room_id, Room.transport_room_id, ClientRoom.joined_at)
            .join(Room, Room.id == ClientRoom.room_id)
            .where(ClientRoom.client_id == client_id)
        )
        return [
            Membership(
                room_id=room_id,
                transport_room_id=transport_room_id,
                joined_at=joined_at,
            )
            for room_id, transport_room_id, joined_at in result.all()
        ]

    async def member_room_ids(
        self, session: AsyncSession, client_id: str, room_ids: list[str]
    ) -> dict[str, datetime]:
        """Which of `room_ids` the client is still a member of, each with when
        it joined, in one query."""
        if not room_ids:
            return {}
        result = await session.execute(
            select(ClientRoom.room_id, ClientRoom.joined_at).where(
                ClientRoom.client_id == client_id,
                any_of(ClientRoom.room_id, room_ids),
            )
        )
        return {room_id: joined_at for room_id, joined_at in result.all()}

    async def get_client_ids(self, session: AsyncSession, room_id: str) -> list[str]:
        result = await session.execute(
            select(ClientRoom.client_id).where(ClientRoom.room_id == room_id)
        )
        return list(result.scalars().all())

    async def client_ids_by_room(
        self, session: AsyncSession, room_ids: Collection[str]
    ) -> dict[str, list[str]]:
        """`get_client_ids` for many rooms in one query, keyed by room id. A
        room with no client members has no key."""
        if not room_ids:
            return {}
        result = await session.execute(
            select(ClientRoom.room_id, ClientRoom.client_id).where(
                ClientRoom.room_id.in_(room_ids)
            )
        )
        by_room: dict[str, list[str]] = {}
        for room_id, client_id in result.all():
            by_room.setdefault(room_id, []).append(client_id)
        return by_room

    async def get_member_agent_clients(
        self, session: AsyncSession, room_id: str
    ) -> dict[str, str]:
        """`{client_id: transport_user_id}` for the agents this room has as members.

        Resolved from the database rather than from the running client
        registry, so it answers correctly before the agent clients have
        finished booting.
        """
        result = await session.execute(
            select(Client.id, Client.transport_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .join(room_agents, room_agents.c.agent_id == Agent.id)
            .where(room_agents.c.room_id == room_id)
        )
        return {
            client_id: transport_user_id
            for client_id, transport_user_id in result.all()
        }

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
        if name is not None and name != room.name:
            room.name = name
            # Named by someone: a platform's channel name no longer replaces it.
            room.metadata_ = {**(room.metadata_ or {}), NAME_SOURCE_KEY: "custom"}
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

    async def set_platform_name(
        self, session: AsyncSession, room_id: str, name: str, channel_name: str
    ) -> None:
        """Name the room after its platform channel, so it follows the
        channel's renames from now on."""
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        room.name = name
        room.metadata_ = {
            **(room.metadata_ or {}),
            NAME_SOURCE_KEY: "channel",
            LINKED_CHANNEL_NAME_KEY: channel_name,
        }
        await session.flush()

    async def follow_channel_name(
        self,
        session: AsyncSession,
        room_id: str,
        name: str,
        channel_name: str,
        legacy_name: str,
    ) -> bool:
        """`set_platform_name`, decided on the row locked for it: only when the
        room is named after its channel, or, from before that was recorded,
        still has exactly `legacy_name`. False, and nothing written, when
        someone named the room meanwhile."""
        room = (
            await session.execute(
                select(Room).where(Room.id == room_id).with_for_update()
            )
        ).scalar_one_or_none()
        if room is None:
            return False
        source = (room.metadata_ or {}).get(NAME_SOURCE_KEY)
        if not (source == "channel" or (source is None and room.name == legacy_name)):
            return False
        await self.set_platform_name(session, room_id, name, channel_name)
        return True

    async def record_channel_name(
        self, session: AsyncSession, room_id: str, channel_name: str
    ) -> None:
        room = await session.get(Room, room_id)
        if room is None:
            raise ValueError(f"Room not found: {room_id}")
        room.metadata_ = {
            **(room.metadata_ or {}),
            LINKED_CHANNEL_NAME_KEY: channel_name,
        }
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


def involves(user_id: str) -> ColumnElement[bool]:
    """True for a `Room` row the user takes part in: they own it, their Switch
    Console member client or a platform account they have claimed is in it,
    or an agent they own is. For reading and listing only; it grants no
    write or configuration access."""
    return or_(
        Room.owner_id == user_id,
        exists().where(
            ClientRoom.room_id == Room.id,
            ClientRoom.client_id == Client.id,
            Client.user_id == user_id,
            Client.type == MEMBER_CLIENT_TYPE,
        ),
        exists().where(
            ClientRoom.room_id == Room.id,
            ClientRoom.client_id == ExternalUser.client_id,
            ExternalUser.id == ExternalUserClaim.external_user_id,
            ExternalUserClaim.user_id == user_id,
        ),
        exists().where(
            room_agents.c.room_id == Room.id,
            room_agents.c.agent_id == Agent.id,
            Agent.owner_id == user_id,
        ),
    )
