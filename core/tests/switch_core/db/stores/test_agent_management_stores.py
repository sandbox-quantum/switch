"""The agent-management stores against Postgres.

The conditional updates are the part worth pinning: each transition's
precondition is in its `UPDATE`, so a stale status report, a spent
enrollment code or a claimed operation cannot be overwritten by a request
that lost a race. Also the tenant filter every read carries, and the
`ON DELETE SET NULL` that keeps a deleted credential from orphaning its
controller row.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    ApiKey,
    Tenant,
    User,
)
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.agent_route_harness import add_agent

CONTROLLERS = AgentControllerStore()
DEFINITIONS = AgentDefinitionStore()
OPERATIONS = AgentControllerOperationStore()
API_KEYS = ApiKeyStore()
NOW = datetime(2026, 1, 1, tzinfo=UTC)


async def _user(session: AsyncSession, name: str = "ada") -> User:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    return user


async def _key(session: AsyncSession, owner: User, key_type: str, hash_: str) -> ApiKey:
    key = ApiKey(
        user_id=owner.id,
        key_hash=hash_,
        encrypted_key="",
        label="k",
        type=key_type,
    )
    await API_KEYS.create(session, key)
    return key


async def _controller(
    session: AsyncSession, owner: User, hash_: str = "controller-hash"
) -> AgentController:
    key = await _key(session, owner, "controller", hash_)
    return await CONTROLLERS.create(
        session,
        owner_id=owner.id,
        name="box",
        description=None,
        kind="daemon",
        platform={"os": "linux", "arch": "x64", "os_version": "6"},
        version="0.1.0",
        public_key=None,
        api_key_id=key.id,
    )


class TestControllers:
    async def test_create_defaults_and_lookup(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            controller = await _controller(session, owner)
            await session.commit()
            assert controller.assignment_revision == 0
            assert controller.status_seq is None
            found = await CONTROLLERS.get_by_api_key(
                session, TENANT_ZERO_ID, controller.api_key_id or ""
            )
            assert found is not None and found.id == controller.id
            assert [
                c.id
                for c in await CONTROLLERS.list_for_owner(
                    session, TENANT_ZERO_ID, owner.id
                )
            ] == [controller.id]

    async def test_name_and_description_are_edited_alone(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            controller = await _controller(session, owner)
            await session.commit()
            assert controller.description is None
            described = await CONTROLLERS.update_details(
                session, TENANT_ZERO_ID, controller.id, {"description": "Office"}
            )
            assert (described.name, described.description) == ("box", "Office")
            renamed = await CONTROLLERS.update_details(
                session, TENANT_ZERO_ID, controller.id, {"name": "laptop"}
            )
            assert (renamed.name, renamed.description) == ("laptop", "Office")
            with pytest.raises(ValueError, match="Not editable"):
                await CONTROLLERS.update_details(
                    session, TENANT_ZERO_ID, controller.id, {"kind": "ec2"}
                )
            with pytest.raises(LookupError):
                await CONTROLLERS.update_details(
                    session, "store-tenant-b", controller.id, {"name": "x"}
                )

    async def test_reads_name_their_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(Tenant(id="store-tenant-b", slug="b", name="b"))
            owner = await _user(session)
            controller = await _controller(session, owner)
            await session.commit()
            assert (
                await CONTROLLERS.get(session, "store-tenant-b", controller.id) is None
            )
            assert (
                await CONTROLLERS.list_for_owner(session, "store-tenant-b", owner.id)
                == []
            )

    async def test_the_revision_bumps_atomically(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            controller = await _controller(session, await _user(session))
            first = await CONTROLLERS.bump_assignment_revision(
                session, TENANT_ZERO_ID, controller.id
            )
            second = await CONTROLLERS.bump_assignment_revision(
                session, TENANT_ZERO_ID, controller.id
            )
            assert (first, second) == (1, 2)
            with pytest.raises(LookupError):
                await CONTROLLERS.bump_assignment_revision(
                    session, TENANT_ZERO_ID, "missing"
                )

    async def test_status_is_stored_only_when_newer(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            controller = await _controller(session, await _user(session))

            async def record(seq: int) -> bool:
                return await CONTROLLERS.record_status(
                    session,
                    TENANT_ZERO_ID,
                    controller.id,
                    seq=seq,
                    status={"seq": seq},
                    version="0.2.0",
                    platform={"os": "macos", "arch": "arm64", "os_version": "15"},
                    seen_at=NOW,
                )

            assert await record(3)
            assert not await record(3)
            assert not await record(2)
            assert await record(4)
            await session.commit()
            refreshed = await CONTROLLERS.get(session, TENANT_ZERO_ID, controller.id)
            await session.refresh(refreshed)
            assert refreshed is not None
            assert refreshed.status == {"seq": 4}
            assert refreshed.status_seq == 4
            assert refreshed.version == "0.2.0"
            assert refreshed.platform == {
                "os": "macos",
                "arch": "arm64",
                "os_version": "15",
            }

    async def test_deleting_the_credential_detaches_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Removing a member deletes every key they hold, a controller's
        included; the controller row must survive that, credential-less."""
        async with session_factory() as session:
            controller = await _controller(session, await _user(session))
            await session.commit()
            await API_KEYS.delete(session, controller.api_key_id or "")
            await session.commit()
            await session.refresh(controller)
            assert controller.api_key_id is None

    async def test_the_kind_is_checked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            key = await _key(session, owner, "controller", "h")
            with pytest.raises(IntegrityError, match="ck_agent_controllers_kind"):
                await CONTROLLERS.create(
                    session,
                    owner_id=owner.id,
                    name="box",
                    description=None,
                    kind="mainframe",
                    platform=None,
                    version=None,
                    public_key=None,
                    api_key_id=key.id,
                )


class TestEnrollmentCodes:
    async def test_a_code_is_consumed_once_and_not_after_expiry(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            live = await _key(session, owner, "controller_enrollment", "live")
            stale = await _key(session, owner, "controller_enrollment", "stale")
            await CONTROLLERS.create_enrollment_code(
                session,
                owner_id=owner.id,
                api_key_id=live.id,
                expires_at=NOW + timedelta(minutes=10),
                hosted_machine_id=None,
            )
            await CONTROLLERS.create_enrollment_code(
                session,
                owner_id=owner.id,
                api_key_id=stale.id,
                expires_at=NOW - timedelta(seconds=1),
                hosted_machine_id=None,
            )
            first = await CONTROLLERS.consume_enrollment_code(
                session, TENANT_ZERO_ID, live.id, NOW
            )
            second = await CONTROLLERS.consume_enrollment_code(
                session, TENANT_ZERO_ID, live.id, NOW
            )
            expired = await CONTROLLERS.consume_enrollment_code(
                session, TENANT_ZERO_ID, stale.id, NOW
            )
            assert first is not None and first.used_at == NOW
            assert second is None
            assert expired is None


class TestDefinitions:
    async def test_create_update_list_and_cascade(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            controller = await _controller(session, owner)
            agent = await add_agent(session, name="managed", owner_id=owner.id)
            row = await DEFINITIONS.create(
                session,
                agent_id=agent.id,
                owner_id=owner.id,
                controller_id=controller.id,
                desired_state="running",
                definition={"provider": "claude"},
            )
            assert row.revision == 1
            updated = await DEFINITIONS.update(
                session,
                TENANT_ZERO_ID,
                agent.id,
                controller_id=None,
                desired_state="stopped",
                definition={"provider": "claude", "model": "m"},
            )
            assert updated.revision == 2
            assert updated.controller_id is None
            assert (
                await DEFINITIONS.list_for_controller(
                    session, TENANT_ZERO_ID, controller.id
                )
                == []
            )
            [(listed, listed_agent)] = await DEFINITIONS.list_for_owner(
                session, TENANT_ZERO_ID, owner.id
            )
            assert listed.agent_id == listed_agent.id == agent.id

            await session.delete(agent)
            await session.flush()
            session.expunge_all()
            assert (
                await DEFINITIONS.get_for_agent(session, TENANT_ZERO_ID, agent.id)
                is None
            )

    async def test_one_definition_per_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            agent = await add_agent(session, name="managed", owner_id=owner.id)
            await DEFINITIONS.create(
                session,
                agent_id=agent.id,
                owner_id=owner.id,
                controller_id=None,
                desired_state="stopped",
                definition={"provider": "claude"},
            )
            with pytest.raises(IntegrityError, match="uq_agent_definitions_agent"):
                await DEFINITIONS.create(
                    session,
                    agent_id=agent.id,
                    owner_id=owner.id,
                    controller_id=None,
                    desired_state="stopped",
                    definition={"provider": "claude"},
                )


class TestOperations:
    async def test_claim_lease_complete(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            controller = await _controller(session, owner)
            operation = await OPERATIONS.create(
                session,
                controller_id=controller.id,
                agent_id=None,
                kind="provider.recheck",
                params={"provider": "claude"},
                created_by=owner.id,
            )
            lease = NOW + timedelta(minutes=5)
            claimed = await OPERATIONS.claim(
                session, TENANT_ZERO_ID, operation.id, now=NOW, lease_expires_at=lease
            )
            assert claimed is not None and claimed.state == "claimed"
            assert (
                await OPERATIONS.claim(
                    session,
                    TENANT_ZERO_ID,
                    operation.id,
                    now=NOW,
                    lease_expires_at=lease,
                )
                is None
            )
            assert (
                await OPERATIONS.list_offered(
                    session, TENANT_ZERO_ID, controller.id, NOW
                )
                == []
            )
            later = lease + timedelta(seconds=1)
            assert [
                o.id
                for o in await OPERATIONS.list_offered(
                    session, TENANT_ZERO_ID, controller.id, later
                )
            ] == [operation.id]
            done = await OPERATIONS.complete(
                session,
                TENANT_ZERO_ID,
                operation.id,
                state="succeeded",
                result={"outcome": "succeeded"},
            )
            assert done is not None and done.lease_expires_at is None
            assert (
                await OPERATIONS.complete(
                    session,
                    TENANT_ZERO_ID,
                    operation.id,
                    state="failed",
                    result={"outcome": "failed"},
                )
                is None
            )

    async def test_cancel_and_expire_touch_only_open_operations(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            controller = await _controller(session, owner)
            agent = await add_agent(session, name="managed", owner_id=owner.id)

            async def op(agent_id: str | None) -> str:
                created = await OPERATIONS.create(
                    session,
                    controller_id=controller.id,
                    agent_id=agent_id,
                    kind="agent.restart" if agent_id else "provider.recheck",
                    params={},
                    created_by=owner.id,
                )
                return created.id

            for_agent = await op(agent.id)
            machine = await op(None)
            cancelled = await OPERATIONS.cancel_open(
                session, TENANT_ZERO_ID, controller_id=controller.id, agent_id=agent.id
            )
            assert cancelled == [for_agent]
            expired = await OPERATIONS.expire_overdue(
                session,
                TENANT_ZERO_ID,
                controller.id,
                datetime.now(UTC) + timedelta(minutes=1),
            )
            assert expired == [machine]

    async def test_the_state_is_checked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _user(session)
            controller = await _controller(session, owner)
            operation = await OPERATIONS.create(
                session,
                controller_id=controller.id,
                agent_id=None,
                kind="provider.recheck",
                params={},
                created_by=owner.id,
            )
            operation.state = "lost"
            with pytest.raises(
                IntegrityError, match="ck_agent_controller_operations_state"
            ):
                await session.flush()


@pytest.mark.no_ambient_tenant
async def test_a_write_with_no_tenant_bound_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    with tenant_scope(TENANT_ZERO_ID):
        async with session_factory() as session:
            owner = await _user(session)
            key = await _key(session, owner, "controller", "h")
            await session.commit()
    async with session_factory() as session:
        with pytest.raises(Exception, match="no tenant is bound"):
            await CONTROLLERS.create(
                session,
                owner_id=owner.id,
                name="box",
                description=None,
                kind="daemon",
                platform=None,
                version=None,
                public_key=None,
                api_key_id=key.id,
            )
