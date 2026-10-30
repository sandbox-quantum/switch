"""Handing an owned thing to another member of the workspace.

Against a real database, as the rest of `accounts/`: what a transfer must not
carry over is held in other tables, and the refusals read them.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.transfer import TransferRefused, transfer_ownership
from switch_core.authz import Principal
from switch_core.bridges.agent.protocol.agent_connections import (
    KEY_REISSUED,
    AgentConnection,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentConnectionRecord,
    ApiKey,
    AuditEvent,
    Document,
    Package,
    Reference,
    Room,
    ServiceConnection,
    ServiceGrant,
    Template,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.ownership import router as ownership_router
from tests.conftest import TEST_KEYRING
from tests.switch_core.accounts.test_account_deletion import _agent, _member, _user
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    _app,
    _client,
    _make_agent_with_key,
    _make_member,
    _make_tenant,
    _token,
)

# Long enough for a statement that is not waiting on a lock to have finished.
_BLOCKED_SECONDS = 0.5


def _reference(owner: User, *, write_visibility: str = "private") -> Reference:
    return Reference(
        owner_id=owner.id,
        read_visibility="public",
        write_visibility=write_visibility,
        type="url",
        name=f"ref-{uuid.uuid4().hex[:6]}",
        description="",
        instructions="",
        value={"url": "https://example.test"},
    )


async def _people(session: AsyncSession) -> tuple[User, User, User]:
    owner = await _user(session, "owner")
    member = await _user(session, "member")
    admin = await _user(session, "admin-member")
    await _member(session, TENANT_ZERO_ID, owner, "member")
    await _member(session, TENANT_ZERO_ID, member, "member")
    await _member(session, TENANT_ZERO_ID, admin, "admin")
    return owner, member, admin


async def _transfer(
    session: AsyncSession, kind: str, resource_id: str, to: User, by: Principal
) -> None:
    await transfer_ownership(
        session,
        tenant_id=TENANT_ZERO_ID,
        kind=kind,
        resource_id=resource_id,
        new_owner_id=to.id,
        caller=by,
        keyring=TEST_KEYRING,
    )


async def test_the_owner_hands_a_reference_to_a_member_and_it_is_audited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        reference = _reference(owner)
        session.add(reference)
        await session.commit()

        await _transfer(
            session, "reference", reference.id, member, Principal(owner.id, False)
        )
        await session.commit()

        assert (
            await session.scalar(
                select(Reference.owner_id).where(Reference.id == reference.id)
            )
        ) == member.id
        event = await session.scalar(
            select(AuditEvent).where(AuditEvent.target_id == reference.id)
        )
        assert event is not None
        assert event.action == "ownership.transferred"
        assert event.actor_user_id == owner.id
        assert event.details == {
            "from": owner.id,
            "to": member.id,
            "agent_key_reissued": False,
        }


async def test_a_writer_who_is_not_the_owner_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        reference = _reference(owner, write_visibility="public")
        session.add(reference)
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "reference", reference.id, member, Principal(member.id, False)
            )
        assert refused.value.status == 403
        assert "owner or a workspace admin" in str(refused.value)


async def test_an_admin_may_hand_over_someone_elses_package(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, admin = await _people(session)
        package = Package(
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        session.add(package)
        await session.commit()

        await _transfer(
            session, "package", package.id, member, Principal(admin.id, True)
        )
        await session.commit()
        assert (
            await session.scalar(
                select(Package.owner_id).where(Package.id == package.id)
            )
        ) == member.id


async def test_someone_outside_the_workspace_cannot_receive_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, _, _ = await _people(session)
        outsider = await _user(session, "outsider")
        reference = _reference(owner)
        session.add(reference)
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "reference", reference.id, outsider, Principal(owner.id, False)
            )
        assert refused.value.status == 400
        assert "current member of this workspace" in str(refused.value)


async def test_an_agent_moves_with_a_new_key_its_new_owner_holds(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "helper")
        await session.commit()
        key = await session.get(ApiKey, agent.api_key_id)
        assert key is not None
        old_hash = key.key_hash

        done = await transfer_ownership(
            session,
            tenant_id=TENANT_ZERO_ID,
            kind="agent",
            resource_id=agent.id,
            new_owner_id=member.id,
            caller=Principal(owner.id, False),
            keyring=TEST_KEYRING,
        )
        await session.commit()

        assert done.retired_key_hash == old_hash
        await session.refresh(key)
        await session.refresh(agent)
        assert agent.owner_id == member.id
        assert key.user_id == member.id
        assert key.key_hash != old_hash


async def test_an_agent_using_its_owners_connections_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "helper")
        session.add(
            ServiceConnection(
                user_id=owner.id,
                service="github",
                status="active",
                consent="read",
                granted_scopes=[],
                account_id="1001",
                external_identity="owner",
                encrypted_secret="x",
                secret_revision=1,
            )
        )
        await session.flush()
        session.add(
            ServiceGrant(
                agent_id=agent.id,
                owner_id=owner.id,
                service="github",
                access="read",
                tool_mode="allow",
                tools=[],
                resources={},
                account_id="1001",
                created_by=owner.id,
            )
        )
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "agent", agent.id, member, Principal(owner.id, False)
            )
        assert refused.value.status == 409
        assert "github" in str(refused.value)
        owner_id, agent_id = owner.id, agent.id
        await session.rollback()
        assert (
            await session.scalar(select(Agent.owner_id).where(Agent.id == agent_id))
        ) == owner_id


async def test_an_agent_that_may_manage_agents_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "manager")
        agent.can_manage_agents = True
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "agent", agent.id, member, Principal(owner.id, False)
            )
        assert "manage its owner's agents" in str(refused.value)


async def test_a_template_name_the_new_owner_already_uses_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        mine = Template(
            owner_id=owner.id, name="same", description="", kind="room", content="x"
        )
        theirs = Template(
            owner_id=member.id, name="same", description="", kind="room", content="y"
        )
        session.add_all([mine, theirs])
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "template", mine.id, member, Principal(owner.id, False)
            )
        assert refused.value.status == 409
        assert "already has a template named same" in str(refused.value)


async def test_a_room_document_and_a_chat_are_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        chat = Room(
            transport_room_id=f"!{uuid.uuid4().hex}:test",
            name="Chat",
            description="",
            owner_id=owner.id,
            created_by=owner.id,
            metadata_={"chat_operation_id": "op"},
        )
        session.add(chat)
        await session.flush()
        document = Document(
            owner_id=owner.id,
            room_id=chat.id,
            read_visibility="public",
            write_visibility="private",
            name="notes",
            description="",
            instructions="",
            content="",
        )
        session.add(document)
        await session.commit()

        with pytest.raises(TransferRefused) as chat_refused:
            await _transfer(
                session, "room", chat.id, member, Principal(owner.id, False)
            )
        assert "chat can't be transferred" in str(chat_refused.value)
        with pytest.raises(TransferRefused) as document_refused:
            await _transfer(
                session, "document", document.id, member, Principal(owner.id, False)
            )
        assert "Only library documents" in str(document_refused.value)


async def test_an_unknown_kind_is_refused() -> None:
    with pytest.raises(TransferRefused) as refused:
        await transfer_ownership(
            None,  # type: ignore[arg-type]
            tenant_id=TENANT_ZERO_ID,
            kind="workspace",
            resource_id="x",
            new_owner_id="y",
            caller=Principal("z", True),
            keyring=TEST_KEYRING,
        )
    assert refused.value.status == 400


async def test_an_admin_may_not_take_someone_elses_package_for_themselves(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, _member, admin = await _people(session)
        package = Package(
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="private",
            name="kit",
            description="",
            instructions="",
        )
        session.add(package)
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "package", package.id, admin, Principal(admin.id, True)
            )
        assert "to yourself" in str(refused.value)


async def test_a_server_connectors_agent_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "connector-agent")
        agent.metadata_ = {"server_connector_id": "connector-1"}
        await session.commit()

        with pytest.raises(TransferRefused) as refused:
            await _transfer(
                session, "agent", agent.id, member, Principal(owner.id, False)
            )
        assert refused.value.status == 409
        assert "server connector" in str(refused.value)


async def test_an_agents_connection_rows_go_with_its_old_key(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Its connections authenticated with the old key; with their rows gone,
    every process that holds one ends it."""
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "connected")
        session.add(
            AgentConnectionRecord(
                id="conn-1",
                agent_id=agent.id,
                process_id="some-process",
                incarnation=1,
                scope="single",
                delivery_filter="addressed",
                spawn_capable=False,
                transport="websocket",
            )
        )
        await session.commit()

        await _transfer(session, "agent", agent.id, member, Principal(owner.id, False))
        await session.commit()

        assert (
            await session.scalar(
                select(AgentConnectionRecord.id).where(
                    AgentConnectionRecord.agent_id == agent.id
                )
            )
        ) is None


def _ownership_app(
    session_factory: async_sessionmaker[AsyncSession],
    caller: User,
    connections: AgentConnectionRegistry,
) -> FastAPI:
    async def _session_dep():
        async with session_factory() as session:
            yield session

    async def _sync_room(_tenant_id: str, _room_id: str) -> None:
        pass

    app = FastAPI()
    app.include_router(ownership_router)
    app.state.chat_service = SimpleNamespace(sync_room=_sync_room)
    overrides = app.dependency_overrides
    overrides[gw_deps.get_session] = _session_dep
    overrides[get_current_user] = lambda: caller
    overrides[get_tenant_is_admin] = lambda: False
    overrides[gw_deps.get_config] = lambda: SimpleNamespace(keyring=TEST_KEYRING)
    overrides[gw_deps.get_protocol] = lambda: SimpleNamespace(
        api_key_cache=SimpleNamespace(
            invalidate=lambda key_hash: None, invalidate_agent=lambda agent_id: None
        ),
        connections=connections,
    )
    return app


async def _open(connections: AgentConnectionRegistry, agent_id: str) -> AgentConnection:
    async with connections.slots(agent_id):
        async with connections.recorded(agent_id):
            return connections.open(
                agent_id=agent_id,
                connection_id="conn-1",
                scope="single",
                delivery_filter="addressed",
                spawn_capable=False,
                position={OWN_EVENTS: 0},
                declaration=ClientDeclaration(speaks=None),
                expected_generation=None,
            )


async def test_the_route_ends_the_agents_open_connections(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "live")
        await session.commit()
        agent_id, member_id = agent.id, member.id
    connections = AgentConnectionRegistry()
    conn = await _open(connections, agent_id)

    app = _ownership_app(session_factory, owner, connections)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/ownership/transfer",
            json={"kind": "agent", "id": agent_id, "new_owner_id": member_id},
        )
    assert response.status_code == 200, response.text
    assert conn.closure == KEY_REISSUED
    assert not connections.is_live(agent_id)


async def test_two_transfers_of_one_agent_take_turns(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The second waits for the first, then is judged on the owner the first
    left: its caller no longer owns the agent."""
    async with session_factory() as session:
        owner, first, second = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "contested")
        await session.commit()
        owner_id, first_id, agent_id = owner.id, first.id, agent.id

    async with session_factory() as one, session_factory() as two:
        await _transfer(one, "agent", agent_id, first, Principal(owner_id, False))
        racing = asyncio.create_task(
            _transfer(two, "agent", agent_id, second, Principal(owner_id, False))
        )
        await asyncio.sleep(_BLOCKED_SECONDS)
        assert not racing.done()
        await one.commit()
        with pytest.raises(TransferRefused) as refused:
            await racing
        assert refused.value.status == 403

    async with session_factory() as session:
        assert (
            await session.scalar(select(Agent.owner_id).where(Agent.id == agent_id))
        ) == first_id


async def test_a_transfer_waits_for_a_removal_of_its_new_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A removal holding the membership row: the transfer finds no member once
    it commits."""
    async with session_factory() as session:
        owner, member, _ = await _people(session)
        agent = await _agent(session, TENANT_ZERO_ID, owner, "pending")
        await session.commit()
        owner_id, member_id, agent_id = owner.id, member.id, agent.id

    async with session_factory() as removal, session_factory() as session:
        membership = await removal.get(
            TenantMember, (TENANT_ZERO_ID, member_id), with_for_update=True
        )
        await removal.delete(membership)
        await removal.flush()
        racing = asyncio.create_task(
            _transfer(session, "agent", agent_id, member, Principal(owner_id, False))
        )
        await asyncio.sleep(_BLOCKED_SECONDS)
        assert not racing.done()
        await removal.commit()
        with pytest.raises(TransferRefused) as refused:
            await racing
        assert refused.value.status == 400
        assert "current member" in str(refused.value)


async def test_a_removal_waits_for_a_transfer_to_the_member(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A transfer under way to the member: the removal, once it commits, finds
    the agent they now own and refuses."""
    await _make_tenant(session_factory, TENANT_A)
    owner_id = await _make_member(
        session_factory, name="giver", tenant_id=TENANT_A, role="owner"
    )
    member_id = await _make_member(
        session_factory, name="taker", tenant_id=TENANT_A, role="member"
    )
    agent_id, agent_name, _ = await _make_agent_with_key(
        session_factory, tenant_id=TENANT_A, owner_id=owner_id
    )

    async with tenant_session(session_factory, TENANT_A) as transfer:
        await transfer_ownership(
            transfer,
            tenant_id=TENANT_A,
            kind="agent",
            resource_id=agent_id,
            new_owner_id=member_id,
            caller=Principal(owner_id, False),
            keyring=TEST_KEYRING,
        )
        token = _token(owner_id, "giver@example.invalid", TENANT_A)
        async with _client(_app(session_factory), token) as client:
            racing = asyncio.create_task(
                client.delete(f"/tenants/{TENANT_A}/members/{member_id}")
            )
            await asyncio.sleep(_BLOCKED_SECONDS)
            assert not racing.done()
            await transfer.commit()
            response = await racing
    assert response.status_code == 409, response.text
    assert agent_name in response.json()["detail"]
    async with session_factory() as session:
        assert await session.get(TenantMember, (TENANT_A, member_id)) is not None
