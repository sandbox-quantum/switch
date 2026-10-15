"""After a rename, the running agent answers to its new name and not its old one.

The consumer decides whether a message is for its agent from the agent row its
actor holds. `rename_agent` hands the actor the renamed row, so this drives the
consumer's own addressing methods, with the real resolver against Postgres,
straight after a real rename, with no restart and no re-read in between.
"""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import AgentActor
from switch_core.clients.agent_consumer import AgentConsumer
from switch_core.clients.room_meta import RoomMeta
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    register,
)
from tests.switch_core.bridges.agent.protocol.test_rename_agent import (
    _agent,
    _FakeAdapter,
    _room,
    _service,
)


class _Transport:
    async def set_display_name(self, display_name: str) -> None:
        return None


def _event(body: str) -> SimpleNamespace:
    return SimpleNamespace(
        sender="@someone:test", body=body, formatted_body=None, content={}
    )


async def _renamed_consumer(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AgentConsumer, RoomMeta]:
    """A running agent `flint-tracker` in a group room, renamed `flint-scout`."""
    svc = _service(session_factory, _FakeAdapter())
    owner = await make_owner(session_factory)
    agent_id = await register(svc, "flint-tracker", owner)
    room_id = await _room(session_factory, "ops", [agent_id])
    agent = await _agent(session_factory, agent_id)

    actor = object.__new__(AgentActor)
    actor.transport = _Transport()  # type: ignore[assignment]
    actor.display_name = "flint-tracker"
    actor.transport_user_id = "@flint-tracker:test"
    actor.set_agent(agent)
    svc.client_lifecycle.actors[agent.client_id] = actor  # type: ignore[attr-defined]

    consumer = object.__new__(AgentConsumer)
    consumer.actor = actor
    consumer._addressing = AddressingResolver(
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        client_store=ClientStore(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
        live_connection_ids=set,
    )

    await svc.rename_agent(agent_id=agent_id, new_name="flint-scout", display_name=None)
    return consumer, RoomMeta(room_id=room_id, name="ops", channel_type="group")


class TestAddressingAfterRename:
    async def test_the_new_name_addresses_the_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        consumer, meta = await _renamed_consumer(session_factory)
        event = _event("@flint-scout can you look at this?")

        assert consumer._is_mentioned(event) is True  # type: ignore[arg-type]
        assert consumer._addressed_without_lookup(event, meta) is True  # type: ignore[arg-type]

    async def test_the_old_name_no_longer_does(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        consumer, meta = await _renamed_consumer(session_factory)
        event = _event("@flint-tracker can you look at this?")

        assert consumer._is_mentioned(event) is False  # type: ignore[arg-type]
        async with session_factory() as session:
            assert (
                await consumer._compute_addressed(session, event, meta)  # type: ignore[arg-type]
                is False
            )

    async def test_a_mention_is_stripped_under_the_new_name(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        consumer, _meta = await _renamed_consumer(session_factory)

        assert consumer._strip_mention("@flint-scout: deploy it") == "deploy it"
