"""After a rename, a message to the new name is for the agent, and one to the
old name is not.

Delivery reads the agent's row for each room row it routes, so this reads the
row back from Postgres straight after a real rename, as delivery would, and
asks the real resolver.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver, IncomingMessage
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    register,
)
from tests.switch_core.bridges.agent.protocol.test_rename_agent import (
    _agent,
    _FakeAdapter,
    _service,
)

_RESOLVER = AddressingResolver(
    room_store=RoomStore(),
    room_role_store=RoomRoleStore(),
    client_store=ClientStore(),
    agent_store=AgentStore(),
    external_user_store=ExternalUserStore(),
    live_connection_ids=set,
)


async def _renamed(session_factory: async_sessionmaker[AsyncSession]) -> Agent:
    svc = _service(session_factory, _FakeAdapter())
    owner = await make_owner(session_factory)
    agent_id = await register(svc, "flint-tracker", owner)
    await svc.rename_agent(agent_id=agent_id, new_name="flint-scout", display_name=None)
    return await _agent(session_factory, agent_id)


def _mentions(agent: Agent, body: str) -> bool:
    return _RESOLVER.mentions_name(
        agent=agent,
        agent_user_id="@switch-agent-0000:test",
        message=IncomingMessage(sender="@someone:test", body=body),
    )


async def test_the_new_name_addresses_the_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    agent = await _renamed(session_factory)

    assert _mentions(agent, "@flint-scout what's the status?")


async def test_the_old_name_no_longer_does(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    agent = await _renamed(session_factory)

    assert not _mentions(agent, "@flint-tracker what's the status?")
