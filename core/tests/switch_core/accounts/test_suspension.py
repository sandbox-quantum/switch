"""Suspending an agent or a person, and lifting it (`accounts/suspension.py`).

Against real Postgres: what the suspension writes, what the bearer middleware
then refuses, the connections it ends and the service tokens it queues, who
may lift it, and that lifting it lets the same credentials in again.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.suspension import (
    Suspender,
    SuspensionChanges,
    SuspensionEffects,
    SuspensionRefused,
    agent_suspender,
    person_suspender,
    suspend_agent,
    suspend_user,
    unsuspend_agent,
    unsuspend_user,
)
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.bridges.agent.protocol.agent_connections import (
    AGENT_SUSPENDED,
    KEY_REISSUED,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.config import SwitchConfig
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentConnectionRecord,
    AgentDefinition,
    ApiKey,
    AuditEvent,
    ServerAuditEvent,
    ServiceTokenIssuance,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agent_key_rotation import rotate_agent_key
from switch_core.gateway.auth import refuse_suspended_account
from switch_core.management.schemas import assignment_entry
from switch_core.tenant_context import tenant_scope
from tests.conftest import TEST_KEYRING
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user

TENANT = TENANT_ZERO_ID


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _agent(session: AsyncSession, name: str, owner: User) -> Agent:
    """An agent of `owner` whose key is the token `tok-<name>`."""
    agent = await add_agent(session, name=name, owner_id=owner.id)
    key = await session.get(ApiKey, agent.api_key_id)
    assert key is not None
    key.key_hash = _hash(f"tok-{name}")
    await session.flush()
    return agent


async def _registration_key(session: AsyncSession, owner: User, token: str) -> None:
    session.add(
        ApiKey(
            user_id=owner.id,
            key_hash=_hash(token),
            encrypted_key="enc",
            label="registration",
            type="registration",
        )
    )
    await session.flush()


def _middleware(
    session_factory: async_sessionmaker[AsyncSession], cache: ApiKeyCache
) -> tuple[BearerAuthMiddleware, list[str]]:
    reached: list[str] = []

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        reached.append(scope["path"])

    return (
        BearerAuthMiddleware(
            _app,
            agent_store=AgentStore(),
            api_key_store=ApiKeyStore(),
            api_key_cache=cache,
            session_factory=session_factory,
        ),
        reached,
    )


async def _dispatch(mw: BearerAuthMiddleware, token: str, path: str) -> list[dict]:
    async def receive() -> dict:
        return {"type": "http.request"}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    await mw(
        {
            "type": "http",
            "path": path,
            "headers": [(b"authorization", f"Bearer {token}".encode())],
        },
        receive,
        send,
    )
    return sent


def _refusal(sent: list[dict]) -> tuple[int, str]:
    return sent[0]["status"], json.loads(sent[1]["body"])["error"]["code"]


class _Management:
    def __init__(self) -> None:
        self.changed: list[tuple[str, list[str], dict[str, int]]] = []
        self.disconnected: list[str] = []

    async def agents_suspension_changed(
        self,
        session: AsyncSession,
        tenant_id: str,
        agent_ids: list[str],
        revisions: dict[str, int],
    ) -> None:
        self.changed.append((tenant_id, agent_ids, revisions))

    def owner_suspended(self, controller_ids: list[str]) -> None:
        self.disconnected.extend(controller_ids)


def _effects(
    session_factory: async_sessionmaker[AsyncSession],
    registry: AgentConnectionRegistry,
    cache: ApiKeyCache,
    management: _Management,
) -> SuspensionEffects:
    return SuspensionEffects(
        session_factory=session_factory,
        connections=registry,
        api_key_cache=cache,
        broker=None,
        management=management,
    )


def _open(registry: AgentConnectionRegistry, agent_id: str) -> Any:
    return registry.open(
        agent_id=agent_id,
        connection_id=f"conn-{agent_id}",
        scope="single",
        delivery_filter="addressed",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=None),
        expected_generation=None,
    )


async def _record_connection(session: AsyncSession, agent_id: str) -> None:
    await AgentConnectionStore().record_open(
        session,
        tenant_id=TENANT,
        connection_id=f"conn-{agent_id}",
        agent_id=agent_id,
        process_id="process-1",
        incarnation=1,
        scope="single",
        delivery_filter="addressed",
        spawn_capable=False,
        transport="websocket",
        speaks=None,
        accepts=None,
    )


def _issuance(agent: Agent) -> ServiceTokenIssuance:
    return ServiceTokenIssuance(
        grant_id="grant-1",
        agent_id=agent.id,
        owner_id=agent.owner_id,
        service="github",
        principal="agent_key",
        permissions={},
        resources={},
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        token_sha256="sha",
        encrypted_token="enc-token",
        revoke_requested=False,
        attempts=0,
    )


async def _apply(
    session_factory: async_sessionmaker[AsyncSession],
    effects: SuspensionEffects,
    changes: SuspensionChanges,
) -> None:
    await effects.committed(changes)


class TestSuspendingAnAgent:
    async def test_its_connections_close_and_its_next_request_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await _agent(session, "helper", owner)
            await _record_connection(session, agent.id)
            session.add(_issuance(agent))
            await session.commit()
        registry = AgentConnectionRegistry()
        conn = _open(registry, agent.id)
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw, reached = _middleware(session_factory, cache)
        post = f"/agents/{agent.id}/ops/post_message"
        assert await _dispatch(mw, "tok-helper", post) == []
        assert cache.get(_hash("tok-helper")) is not None
        management = _Management()

        async with session_factory() as session:
            changes = await suspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=owner.id, role="owner"),
                reason="its key leaked",
            )
            await session.commit()
        with tenant_scope(TENANT):
            await _effects(session_factory, registry, cache, management).committed(
                changes
            )

        assert conn.closure == AGENT_SUSPENDED
        assert not registry.is_live(agent.id)
        assert cache.get(_hash("tok-helper")) is None
        assert _refusal(await _dispatch(mw, "tok-helper", post)) == (
            403,
            "agent_suspended",
        )
        assert reached == [post]
        assert management.changed == [(TENANT, [agent.id], {})]
        async with session_factory() as session:
            stored = await session.get(Agent, agent.id, populate_existing=True)
            assert stored is not None
            assert stored.suspended_at is not None
            assert stored.suspended_reason == "its key leaked"
            assert stored.suspended_by == owner.id
            assert stored.suspended_by_role == "owner"
            assert not await session.scalar(
                select(AgentConnectionRecord.id).where(
                    AgentConnectionRecord.agent_id == agent.id
                )
            )
            issuance = await session.scalar(
                select(ServiceTokenIssuance).where(
                    ServiceTokenIssuance.agent_id == agent.id
                )
            )
            assert issuance is not None and issuance.revoke_requested is True
            event = await session.scalar(
                select(AuditEvent).where(AuditEvent.action == "agent.suspended")
            )
            assert event is not None
            assert event.target_id == agent.id
            assert event.details == {"reason": "its key leaked", "by_role": "owner"}

    async def test_it_stays_a_member_of_its_rooms_and_its_device_stops_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Suspension freezes rather than removes: its definition, and the
        state its owner set, stay as they were, and only what its device is
        told changes."""
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await _agent(session, "helper", owner)
            row = AgentDefinition(
                agent_id=agent.id,
                owner_id=owner.id,
                controller_id=None,
                revision=3,
                desired_state="running",
                definition={"provider": "claude-code"},
            )
            session.add(row)
            await session.flush()
            await suspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=owner.id, role="owner"),
                reason="pause",
            )
            await session.commit()
            assert assignment_entry(row, agent, workspace_archived=False)[
                "desired_state"
            ] == ("stopped")
            assert row.desired_state == "running"

            await unsuspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=owner.id, role="owner"),
            )
            await session.commit()
            assert (
                assignment_entry(row, agent, workspace_archived=False)["desired_state"]
                == "running"
            )

    async def test_lifting_it_lets_the_same_key_in_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await _agent(session, "helper", owner)
            await suspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=owner.id, role="admin"),
                reason="check",
            )
            await session.commit()
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw, reached = _middleware(session_factory, cache)
        path = f"/agents/{agent.id}/ops"
        assert _refusal(await _dispatch(mw, "tok-helper", path))[0] == 403
        assert cache.get(_hash("tok-helper")) is None

        async with session_factory() as session:
            changes = await unsuspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=owner.id, role="admin"),
            )
            await session.commit()

        assert changes == SuspensionChanges(
            suspended=False, agents={TENANT: [agent.id]}, revisions={}, controllers={}
        )
        assert await _dispatch(mw, "tok-helper", path) == []
        assert reached == [path]

    async def test_suspending_it_twice_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await _agent(session, "helper", owner)
            by = Suspender(user_id=owner.id, role="owner")
            await suspend_agent(
                session, tenant_id=TENANT, agent_id=agent.id, by=by, reason="a"
            )
            with pytest.raises(SuspensionRefused) as refused:
                await suspend_agent(
                    session, tenant_id=TENANT, agent_id=agent.id, by=by, reason="b"
                )
        assert refused.value.status == 409

    async def test_a_reason_is_required(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await _agent(session, "helper", owner)
            with pytest.raises(SuspensionRefused) as refused:
                await suspend_agent(
                    session,
                    tenant_id=TENANT,
                    agent_id=agent.id,
                    by=Suspender(user_id=owner.id, role="owner"),
                    reason="  ",
                )
        assert refused.value.status == 400


class TestWhoMayLiftIt:
    async def test_a_workspace_admin_cannot_lift_the_operators_suspension(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            admin = await add_user(session, name="admin")
            agent = await _agent(session, "helper", owner)
            await suspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=None, role="operator"),
                reason="legal hold",
            )
            await session.commit()
            agent_id = agent.id
            for by in (
                Suspender(user_id=admin.id, role="admin"),
                Suspender(user_id=owner.id, role="owner"),
            ):
                with pytest.raises(SuspensionRefused) as refused:
                    await unsuspend_agent(
                        session, tenant_id=TENANT, agent_id=agent_id, by=by
                    )
                assert refused.value.status == 403
                assert "the server's operator" in str(refused.value)
                await session.rollback()
            await unsuspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent_id,
                by=Suspender(user_id=None, role="operator"),
            )
            await session.commit()
            stored = await session.get(Agent, agent_id, populate_existing=True)
            assert stored is not None and stored.suspended_at is None

    async def test_the_owner_cannot_lift_an_admins_suspension(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            admin = await add_user(session, name="admin")
            agent = await _agent(session, "helper", owner)
            await suspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=agent.id,
                by=Suspender(user_id=admin.id, role="admin"),
                reason="misbehaving",
            )
            with pytest.raises(SuspensionRefused) as refused:
                await unsuspend_agent(
                    session,
                    tenant_id=TENANT,
                    agent_id=agent.id,
                    by=Suspender(user_id=owner.id, role="owner"),
                )
        assert refused.value.status == 403

    def test_only_the_owner_an_admin_or_the_operator_may_suspend_an_agent(
        self,
    ) -> None:
        assert agent_suspender(
            caller_id="u", is_operator=False, is_admin=False, owner_id="u"
        ) == Suspender(user_id="u", role="owner")
        assert agent_suspender(
            caller_id="a", is_operator=False, is_admin=True, owner_id="u"
        ) == Suspender(user_id="a", role="admin")
        assert agent_suspender(
            caller_id="o", is_operator=True, is_admin=True, owner_id="u"
        ) == Suspender(user_id="o", role="operator")
        with pytest.raises(SuspensionRefused) as refused:
            agent_suspender(
                caller_id="x", is_operator=False, is_admin=False, owner_id="u"
            )
        assert refused.value.status == 403


async def _workspace(session: AsyncSession, tenant_id: str) -> None:
    session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
    await session.flush()


async def _join(session: AsyncSession, tenant_id: str, user: User, role: str) -> None:
    session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role=role))
    await session.flush()


class TestSuspendingAPerson:
    async def test_their_keys_sessions_and_agents_are_refused_until_it_is_lifted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await add_user(session, name="person")
            await _join(session, TENANT, person, "member")
            await _agent(session, "first", person)
            second = await _agent(session, "second", person)
            await _registration_key(session, person, "reg-person")
            await session.commit()
            version = person.session_version
        async with session_factory() as session:
            # Suspended on its own first: it stays so when its owner's is lifted.
            await suspend_agent(
                session,
                tenant_id=TENANT,
                agent_id=second.id,
                by=Suspender(user_id=person.id, role="owner"),
                reason="separately",
            )
            await session.commit()
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw, _ = _middleware(session_factory, cache)
        assert await _dispatch(mw, "tok-first", "/agents/x/ops") == []

        done = await suspend_user(
            session_factory,
            user_id=person.id,
            by=Suspender(user_id=None, role="operator"),
            reason="account compromised",
        )
        registry = AgentConnectionRegistry()
        with tenant_scope(TENANT):
            await _effects(session_factory, registry, cache, _Management()).committed(
                done.changes
            )

        assert done.changed is True
        first_id = done.changes.agents[TENANT][0]
        assert done.changes.agents == {TENANT: [first_id]}
        assert _refusal(await _dispatch(mw, "tok-first", "/agents/x/ops")) == (
            403,
            "agent_suspended",
        )
        assert _refusal(await _dispatch(mw, "reg-person", "/agents/register")) == (
            403,
            "account_suspended",
        )
        async with session_factory() as session:
            stored = await session.get(User, person.id, populate_existing=True)
            assert stored is not None
            assert stored.session_version == version + 1
            assert stored.suspended_by_role == "operator"
            with pytest.raises(HTTPException) as refused:
                refuse_suspended_account(stored)
            assert refused.value.status_code == 403
            first = await session.get(Agent, first_id, populate_existing=True)
            assert first is not None and first.suspended_with_owner is True
            assert await session.scalar(
                select(ServerAuditEvent.id).where(
                    ServerAuditEvent.action == "user.suspended",
                    ServerAuditEvent.target_id == person.id,
                )
            )
            assert await session.scalar(
                select(AuditEvent.id).where(
                    AuditEvent.action == "user.suspended",
                    AuditEvent.target_id == person.id,
                )
            )

        lifted = await unsuspend_user(
            session_factory,
            user_id=person.id,
            by=Suspender(user_id=None, role="operator"),
        )

        assert lifted.changes.agents == {TENANT: [first_id]}
        assert await _dispatch(mw, "tok-first", "/agents/x/ops") == []
        assert await _dispatch(mw, "reg-person", "/agents/register") == []
        assert _refusal(await _dispatch(mw, "tok-second", "/agents/x/ops")) == (
            403,
            "agent_suspended",
        )
        async with session_factory() as session:
            stored = await session.get(User, person.id, populate_existing=True)
            assert stored is not None and stored.suspended_at is None
            refuse_suspended_account(stored)

    async def test_an_agent_suspended_with_its_owner_is_not_lifted_on_its_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await add_user(session, name="person")
            agent = await _agent(session, "helper", person)
            await session.commit()
        await suspend_user(
            session_factory,
            user_id=person.id,
            by=Suspender(user_id=None, role="operator"),
            reason="hold",
        )
        async with session_factory() as session:
            with pytest.raises(SuspensionRefused) as refused:
                await unsuspend_agent(
                    session,
                    tenant_id=TENANT,
                    agent_id=agent.id,
                    by=Suspender(user_id=None, role="operator"),
                )
        assert refused.value.status == 409

    async def test_a_workspace_admin_cannot_lift_the_operators_suspension(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            person = await add_user(session, name="person")
            admin = await add_user(session, name="admin")
            await _join(session, TENANT, person, "member")
            await _join(session, TENANT, admin, "admin")
            await session.commit()
        await suspend_user(
            session_factory,
            user_id=person.id,
            by=Suspender(user_id=None, role="operator"),
            reason="legal hold",
        )
        by = await person_suspender(
            session_factory, UserStore(), caller=admin, target_id=person.id
        )
        assert by == Suspender(user_id=admin.id, role="admin")

        with pytest.raises(SuspensionRefused) as refused:
            await unsuspend_user(session_factory, user_id=person.id, by=by)

        assert refused.value.status == 403
        async with session_factory() as session:
            stored = await session.get(User, person.id, populate_existing=True)
            assert stored is not None and stored.suspended_at is not None

    async def test_an_admin_of_only_some_of_their_workspaces_may_not_suspend_them(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            await _workspace(session, "other-workspace")
            person = await add_user(session, name="person")
            admin = await add_user(session, name="admin")
            await _join(session, TENANT, person, "member")
            await _join(session, TENANT, admin, "admin")
            await session.commit()
        async with tenant_session(session_factory, "other-workspace") as session:
            await _join(session, "other-workspace", person, "member")
            await session.commit()

        with pytest.raises(SuspensionRefused) as refused:
            await person_suspender(
                session_factory, UserStore(), caller=admin, target_id=person.id
            )

        assert refused.value.status == 403

    async def test_nobody_suspends_themselves_and_only_the_operator_the_operator(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            operator = await add_user(session, name="operator", role="admin")
            admin = await add_user(session, name="admin")
            await _join(session, TENANT, operator, "admin")
            await _join(session, TENANT, admin, "admin")
            await session.commit()

        with pytest.raises(SuspensionRefused) as own:
            await person_suspender(
                session_factory, UserStore(), caller=admin, target_id=admin.id
            )
        with pytest.raises(SuspensionRefused) as theirs:
            await person_suspender(
                session_factory, UserStore(), caller=admin, target_id=operator.id
            )

        assert own.value.status == 400
        assert theirs.value.status == 403


class TestRotatingAnAgentsKey:
    async def test_the_old_key_is_refused_and_its_connections_closed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await _agent(session, "helper", owner)
            await _record_connection(session, agent.id)
            await session.commit()
        registry = AgentConnectionRegistry()
        conn = _open(registry, agent.id)
        cache = ApiKeyCache(ttl_seconds=5, max_entries=8)
        mw, reached = _middleware(session_factory, cache)
        path = f"/agents/{agent.id}/ops"
        assert await _dispatch(mw, "tok-helper", path) == []

        async with session_factory() as session:
            rotated = await rotate_agent_key(
                agent.id,
                session=session,
                user=owner,
                is_admin=False,
                protocol=cast(
                    AgentCore,
                    SimpleNamespace(api_key_cache=cache, connections=registry),
                ),
                config=cast(SwitchConfig, SimpleNamespace(keyring=TEST_KEYRING)),
            )

        assert conn.closure == KEY_REISSUED
        assert (await _dispatch(mw, "tok-helper", path))[0]["status"] == 401
        assert await _dispatch(mw, rotated.api_key, path) == []
        assert reached == [path, path]
        async with session_factory() as session:
            assert not await session.scalar(
                select(AgentConnectionRecord.id).where(
                    AgentConnectionRecord.agent_id == agent.id
                )
            )
            event = await session.scalar(
                select(AuditEvent).where(AuditEvent.action == "agent.key_rotated")
            )
            assert event is not None and event.target_id == agent.id

    async def test_someone_else_may_not_rotate_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            other = await add_user(session, name="other")
            agent = await _agent(session, "helper", owner)
            await session.commit()
            with pytest.raises(HTTPException) as refused:
                await rotate_agent_key(
                    agent.id,
                    session=session,
                    user=other,
                    is_admin=False,
                    protocol=cast(AgentCore, SimpleNamespace()),
                    config=cast(SwitchConfig, SimpleNamespace(keyring=TEST_KEYRING)),
                )
        assert refused.value.status_code == 403
