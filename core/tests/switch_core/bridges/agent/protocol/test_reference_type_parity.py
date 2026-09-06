"""`list_reference_types` resolves per-principal in two independent code paths
— the agent protocol op (the agent's owner) and the gateway route (the signed-in
user). They are separate implementations over the same service, so this file
pins them to the same answer for the same principal: a filter added to one and
not the other is a drift bug that no other test would catch.

`ProtocolService.__init__` takes 17 required collaborators, so the service is
built with `object.__new__` and the three attributes this method touches, per
`test_agent_detail_mcp_tools.py`. `_resolve_acting_identity` loads the owner
with `session.get(User, ...)` on the live session rather than through
`user_store`, so no `user_store` is needed here.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.resource.registry import BUILTIN_REFERENCE_TYPES
from switch_core.bridges.resource.service import ResourceService
from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.references import list_reference_types as route_list_types

_USER_STORE = UserStore()


def _resource_service(
    session_factory: async_sessionmaker[AsyncSession],
) -> ResourceService:
    return ResourceService(
        reference_store=ReferenceStore(),
        reference_type_store=ReferenceTypeStore(),
        document_store=DocumentStore(),
        package_store=PackageStore(),
        room_link_store=RoomLinkStore(),
        session_factory=session_factory,
    )


def _protocol_service(
    session_factory: async_sessionmaker[AsyncSession],
    resource_service: ResourceService,
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.resource_service = resource_service  # type: ignore[attr-defined]
    return svc


async def _make_user(session: AsyncSession, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.invalid", role=role)
    session.add(user)
    await session.flush()
    return user


async def _make_agent(
    session: AsyncSession, name: str, *, owner_id: str | None, api_key_user_id: str
) -> Agent:
    # `agents.owner_id` is nullable but `api_keys.user_id` is not, so an
    # ownerless agent still has a key belonging to whoever registered it.
    api_key = ApiKey(
        user_id=api_key_user_id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:example.invalid",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="session_addressable",
        connector_type="Claude Code",
        integration_profile={"connection_model": "session_passive"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _make_type(
    session: AsyncSession,
    service: ResourceService,
    slug: str,
    *,
    owner_id: str,
    read_visibility: str,
) -> None:
    await service.create_reference_type(
        session,
        owner_id=owner_id,
        type=slug,
        display_name=slug.replace("_", " ").title(),
        instructions=f"Use the {slug} links as {slug} material.",
        value_hint=f"Paste {slug} links.",
        read_visibility=read_visibility,
        write_visibility="private",
    )


async def _seed(
    session: AsyncSession, service: ResourceService
) -> tuple[User, User, Agent]:
    """alice owns an agent and a private type; bob owns one of each visibility."""
    alice = await _make_user(session, "alice")
    bob = await _make_user(session, "bob")
    await _make_type(
        session, service, "alice_private", owner_id=alice.id, read_visibility="private"
    )
    await _make_type(
        session, service, "bob_private", owner_id=bob.id, read_visibility="private"
    )
    await _make_type(
        session, service, "bob_public", owner_id=bob.id, read_visibility="public"
    )
    agent = await _make_agent(
        session, "alice-agent", owner_id=alice.id, api_key_user_id=alice.id
    )
    return alice, bob, agent


async def _slugs_from_route(
    session: AsyncSession, service: ResourceService, user: User
) -> set[str]:
    listed = await route_list_types(session, service, _USER_STORE, user)
    return {info.type for info in listed}


class TestAgentAndGatewayAgree:
    async def test_same_principal_sees_the_same_slugs(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _resource_service(session_factory)
        svc = _protocol_service(session_factory, service)
        async with session_factory() as session:
            alice, _bob, agent = await _seed(session, service)
            await session.commit()
            alice_id, agent_id = alice.id, agent.id

        agent_slugs = {e["type"] for e in await svc.list_reference_types(agent_id)}
        async with session_factory() as session:
            alice = await _USER_STORE.get(session, alice_id)  # type: ignore[assignment]
            route_slugs = await _slugs_from_route(session, service, alice)

        assert agent_slugs == route_slugs
        assert agent_slugs == set(BUILTIN_REFERENCE_TYPES) | {
            "alice_private",
            "bob_public",
        }

    async def test_admin_owner_sees_every_type_on_both_paths(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _resource_service(session_factory)
        svc = _protocol_service(session_factory, service)
        async with session_factory() as session:
            _alice, _bob, _agent = await _seed(session, service)
            root = await _make_user(session, "root", role="admin")
            agent = await _make_agent(
                session, "root-agent", owner_id=root.id, api_key_user_id=root.id
            )
            await session.commit()
            root_id, agent_id = root.id, agent.id

        agent_slugs = {e["type"] for e in await svc.list_reference_types(agent_id)}
        async with session_factory() as session:
            root = await _USER_STORE.get(session, root_id)  # type: ignore[assignment]
            route_slugs = await _slugs_from_route(session, service, root)

        assert agent_slugs == route_slugs
        assert {"alice_private", "bob_private", "bob_public"} <= agent_slugs


class TestOwnerlessAgent:
    """A read tool must not require an owner: `create_reference` refuses an
    ownerless agent, `list_reference_types` resolves it as an anonymous
    principal and returns the built-ins plus the public types.
    """

    async def test_sees_builtins_and_public_types_only(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _resource_service(session_factory)
        svc = _protocol_service(session_factory, service)
        async with session_factory() as session:
            _alice, bob, _agent = await _seed(session, service)
            agent = await _make_agent(
                session, "ownerless", owner_id=None, api_key_user_id=bob.id
            )
            await session.commit()
            agent_id = agent.id

        slugs = {e["type"] for e in await svc.list_reference_types(agent_id)}
        assert slugs == set(BUILTIN_REFERENCE_TYPES) | {"bob_public"}


class TestEntryShape:
    async def test_entries_carry_origin_and_value_hint(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _resource_service(session_factory)
        svc = _protocol_service(session_factory, service)
        async with session_factory() as session:
            _alice, _bob, agent = await _seed(session, service)
            await session.commit()
            agent_id = agent.id

        entries = {e["type"]: e for e in await svc.list_reference_types(agent_id)}
        custom = entries["alice_private"]
        assert custom["origin"] == "user"
        assert custom["display_name"] == "Alice Private"
        assert custom["value_hint"] == "Paste alice_private links."
        assert custom["value_schema"]["properties"]["urls"]["type"] == "array"
        assert entries["github"]["origin"] == "builtin"
        # The owner never reaches an agent: only the gateway picker discloses it.
        assert "owner_id" not in custom
