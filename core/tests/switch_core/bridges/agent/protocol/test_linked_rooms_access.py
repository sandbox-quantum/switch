"""The rooms an agent's room links to are the ones its owner may read.

An agent holds no more than its owner does, so the linked rooms it is handed
on connect, and by `list_linked_rooms`, leave out private rooms its owner
cannot open, as the dashboard does. A room the agent is in always qualifies:
its owner takes part in it through the agent.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Room
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


async def _room(
    session: AsyncSession, name: str, owner_id: str, *, read: str, agent_ids: list[str]
) -> str:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description=f"about {name}",
        owner_id=owner_id,
        read_visibility=read,
        write_visibility="private",
    )
    session.add(room)
    await session.flush()
    await RoomStore().add_agents(session, room.id, agent_ids)
    return room.id


async def test_an_agent_is_shown_only_linked_rooms_its_owner_may_read(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = _service(session_factory)
    links = ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )
    svc.resource_service = links  # type: ignore[assignment]
    alice = await _make_user(session_factory, "alice")
    bob = await _make_user(session_factory, "bob")
    agent = await _register(svc, "alice-agent", alice)
    async with session_factory() as session:
        hub = await _room(session, "hub", bob, read="public", agent_ids=[agent])
        lobby = await _room(session, "lobby", bob, read="public", agent_ids=[])
        theirs = await _room(session, "theirs", bob, read="private", agent_ids=[agent])
        secret = await _room(session, "secret", bob, read="private", agent_ids=[])
        for target in (lobby, theirs, secret):
            await links.attach_linked_room(
                session, source_room_id=hub, target_room_id=target, label="see"
            )
        await session.commit()

    payload = await svc.list_room_resources(agent, hub)

    assert {link["target_room_name"] for link in payload["linked_rooms"]} == {
        "lobby",
        "theirs",
    }
