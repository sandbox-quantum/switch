"""`switch-accounts`, as an operator runs it: on the restricted role, bound
to nothing. Each change lands in the server's audit log with no actor and
`platform_operator_command` set."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.accounts.deletion import AccountDeletionIncomplete
from switch_core.accounts_admin import (
    create_account,
    delete_account,
    grant_operator,
    list_accounts,
    plan_deletion,
    read_password,
    revoke_operator,
    sign_out,
)
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_OWNER_MARKER_META_KEY,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Organization,
    ServerAuditEvent,
    Tenant,
    TenantMember,
    User,
)
from switch_core.operator_commands import CommandRefused
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.accounts.test_account_deletion import (
    ADMIN_EMAIL,
    _agent,
    _Broker,
    _deletion,
)

pytestmark = pytest.mark.no_ambient_tenant

COMMAND = {"platform_operator_command": True}


async def _account(
    rls_harness: RLSHarness,
    name: str,
    *,
    role: str = "user",
    workspace_role: str | None = None,
    email: str | None = None,
) -> User:
    with tenant_scope(TENANT_ZERO_ID):
        async with rls_harness.owner() as session:
            user = User(
                name=name,
                email=email or f"{name}@example.invalid",
                role=role,
                password_hash="unused",
            )
            session.add(user)
            await session.flush()
            if workspace_role is not None:
                session.add(
                    TenantMember(
                        tenant_id=TENANT_ZERO_ID, user_id=user.id, role=workspace_role
                    )
                )
            await session.commit()
            return user


async def _server_events(rls_harness: RLSHarness) -> list[ServerAuditEvent]:
    async with rls_harness.owner() as session:
        return list(
            await session.scalars(
                select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
            )
        )


async def _user(rls_harness: RLSHarness, user_id: str) -> User | None:
    async with rls_harness.owner() as session:
        return await session.get(User, user_id)


class TestList:
    async def test_every_account_or_only_the_operators(
        self, rls_harness: RLSHarness
    ) -> None:
        operator = await _account(rls_harness, "operator", role="admin")
        member = await _account(rls_harness, "member")

        everyone = await list_accounts(rls_harness.restricted, operators=False)
        operators = await list_accounts(rls_harness.restricted, operators=True)

        assert {user.id for user in everyone} == {operator.id, member.id}
        assert [user.id for user in operators] == [operator.id]


class TestCreate:
    async def test_an_account_in_no_workspace_audited(
        self, rls_harness: RLSHarness
    ) -> None:
        user = await create_account(
            rls_harness.restricted,
            email="  New.Person@Example.com ",
            name="New Person",
            password="correct horse battery",
            operator=False,
        )

        assert user.email == "new.person@example.com"
        assert user.role == "user"
        async with rls_harness.owner() as session:
            stored = await session.get(User, user.id)
            assert stored is not None and stored.password_hash
            assert stored.password_hash != "correct horse battery"
            memberships = await session.scalars(
                select(TenantMember).where(TenantMember.user_id == user.id)
            )
            assert list(memberships) == []
        [event] = await _server_events(rls_harness)
        assert (event.action, event.actor_user_id, event.target_id) == (
            "user.created",
            None,
            user.id,
        )
        assert event.details == {"role": "user", **COMMAND}

    async def test_an_operator(self, rls_harness: RLSHarness) -> None:
        user = await create_account(
            rls_harness.restricted,
            email="ops@example.com",
            name="Ops",
            password="correct horse battery",
            operator=True,
        )

        assert user.role == "admin"

    @pytest.mark.parametrize(
        ("email", "password", "message"),
        [
            ("TAKEN@example.invalid", "correct horse battery", "already has"),
            ("not an address", "correct horse battery", "not an e-mail"),
            ("fresh@example.invalid", "short", "password won't do"),
        ],
    )
    async def test_what_it_refuses(
        self, rls_harness: RLSHarness, email: str, password: str, message: str
    ) -> None:
        await _account(rls_harness, "taken")

        with pytest.raises(CommandRefused, match=message) as refused:
            await create_account(
                rls_harness.restricted,
                email=email,
                name="Someone",
                password=password,
                operator=False,
            )

        assert password not in str(refused.value)
        assert await _server_events(rls_harness) == []

    def test_the_password_comes_from_a_file_without_its_line_ending(
        self, tmp_path: Path
    ) -> None:
        secret = tmp_path / "password"
        secret.write_text("correct horse battery\n")

        assert read_password(secret) == "correct horse battery"


class TestSignOut:
    async def test_every_session_ends_audited(self, rls_harness: RLSHarness) -> None:
        user = await _account(rls_harness, "laptop-lost")

        await sign_out(rls_harness.restricted, "Laptop-Lost@example.invalid")

        stored = await _user(rls_harness, user.id)
        assert stored is not None and stored.session_version == 1
        [event] = await _server_events(rls_harness)
        assert (event.action, event.target_id, event.actor_user_id) == (
            "user.sessions_ended",
            user.id,
            None,
        )
        assert event.details == COMMAND

    async def test_an_unknown_email_is_refused(self, rls_harness: RLSHarness) -> None:
        with pytest.raises(CommandRefused, match="No account"):
            await sign_out(rls_harness.restricted, "nobody@example.invalid")


class TestOperators:
    async def test_granting_and_revoking_audited(self, rls_harness: RLSHarness) -> None:
        await _account(rls_harness, "admin", role="admin", email=ADMIN_EMAIL)
        user = await _account(rls_harness, "promoted")

        await grant_operator(rls_harness.restricted, user.email)
        granted = await _user(rls_harness, user.id)
        await revoke_operator(rls_harness.restricted, user.email, ADMIN_EMAIL)
        revoked = await _user(rls_harness, user.id)

        assert granted is not None and granted.role == "admin"
        assert revoked is not None and revoked.role == "user"
        # The database ends every session of an operator made a regular account.
        assert revoked.session_version == granted.session_version + 1
        assert [(e.action, e.details) for e in await _server_events(rls_harness)] == [
            ("user.promoted", {"from": "user", "to": "admin", **COMMAND}),
            ("user.demoted", {"from": "admin", "to": "user", **COMMAND}),
        ]

    async def test_the_administrator_account_stays_an_operator(
        self, rls_harness: RLSHarness
    ) -> None:
        await _account(rls_harness, "admin", role="admin", email=ADMIN_EMAIL)
        await _account(rls_harness, "other", role="admin")

        with pytest.raises(CommandRefused, match="GATEWAY_ADMIN_EMAIL"):
            await revoke_operator(rls_harness.restricted, ADMIN_EMAIL, ADMIN_EMAIL)

    async def test_the_last_operator_stays_one(self, rls_harness: RLSHarness) -> None:
        only = await _account(rls_harness, "only", role="admin")

        with pytest.raises(CommandRefused, match="only platform operator"):
            await revoke_operator(rls_harness.restricted, only.email, ADMIN_EMAIL)
        stored = await _user(rls_harness, only.id)
        assert stored is not None and stored.role == "admin"

    async def test_revoking_someone_who_is_not_one_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        await _account(rls_harness, "admin", role="admin", email=ADMIN_EMAIL)
        user = await _account(rls_harness, "regular")

        with pytest.raises(CommandRefused, match="not a platform operator"):
            await revoke_operator(rls_harness.restricted, user.email, ADMIN_EMAIL)

    async def test_the_service_account_is_never_made_one(
        self, rls_harness: RLSHarness
    ) -> None:
        robot = await _account(rls_harness, "robot")
        async with rls_harness.owner() as session:
            stored = await session.get(User, robot.id)
            assert stored is not None
            stored.metadata_ = {BOOTSTRAP_OWNER_MARKER_META_KEY: True}
            await session.commit()

        with pytest.raises(CommandRefused, match="service account"):
            await grant_operator(rls_harness.restricted, robot.email)


class TestDelete:
    async def test_an_account_is_deleted_as_the_dashboard_did_audited(
        self, rls_harness: RLSHarness
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        leaving = await _account(rls_harness, "leaving", workspace_role="member")
        deletion, _, _ = _deletion(rls_harness.restricted)

        plan = await plan_deletion(deletion, rls_harness.restricted, leaving.email)
        assert plan.refusal is None and plan.needs_the_server is None
        assert [w.id for w in plan.workspaces] == [TENANT_ZERO_ID]
        assert await _user(rls_harness, leaving.id) is not None

        await delete_account(deletion, rls_harness.restricted, plan)

        assert await _user(rls_harness, leaving.id) is None
        [event] = await _server_events(rls_harness)
        assert (event.action, event.actor_user_id, event.target_id) == (
            "user.deleted",
            None,
            leaving.id,
        )
        assert event.details == {"outcome": "deleted", "workspaces": 1, **COMMAND}
        with tenant_scope(TENANT_ZERO_ID):
            async with rls_harness.owner() as session:
                [left] = await session.scalars(
                    select(AuditEvent).where(AuditEvent.action == "account.deleted")
                )
        assert left.actor_user_id is None
        assert left.details is not None
        assert left.details["platform_operator_command"] is True

    async def test_an_account_owning_an_agent_is_refused_until_it_goes(
        self, rls_harness: RLSHarness
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        owner = await _account(rls_harness, "owner", workspace_role="member")
        with tenant_scope(TENANT_ZERO_ID):
            async with rls_harness.owner() as session:
                await _agent(session, TENANT_ZERO_ID, owner, "helper")
                await session.commit()
        deletion, _, _ = _deletion(rls_harness.restricted)

        plan = await plan_deletion(deletion, rls_harness.restricted, owner.email)
        assert plan.needs_the_server is not None
        assert "1 agent(s)" in plan.needs_the_server
        with pytest.raises(CommandRefused, match="only a running server"):
            await delete_account(deletion, rls_harness.restricted, plan)

        assert await _user(rls_harness, owner.id) is not None
        [event] = await _server_events(rls_harness)
        assert event.action == "user.deletion_refused"
        assert event.details is not None
        assert event.details["platform_operator_command"] is True

    async def test_what_the_account_deletion_refuses_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        only_admin = await _account(rls_harness, "only-admin", workspace_role="admin")
        await _account(rls_harness, "colleague", workspace_role="member")
        deletion, _, _ = _deletion(rls_harness.restricted)

        plan = await plan_deletion(deletion, rls_harness.restricted, only_admin.email)
        assert plan.refusal is not None and "only admin" in plan.refusal
        with pytest.raises(CommandRefused, match="only admin"):
            await delete_account(deletion, rls_harness.restricted, plan)

        assert await _user(rls_harness, only_admin.id) is not None


class _FailsOnSecondWorkspace(_Broker):
    def __init__(self) -> None:
        self.calls = 0

    async def remove_connections(self, _session: AsyncSession, _user_id: str) -> list:
        self.calls += 1
        if self.calls == 2:
            raise RuntimeError("the vendor is down")
        return []


async def test_a_deletion_that_fails_partway_is_recorded_with_what_it_finished(
    rls_harness: RLSHarness,
) -> None:
    """The first workspace commits on its own before the second fails, so the
    attempt lands in the server's audit log though the deletion's own event
    rolls back with the `users` row."""
    await _account(rls_harness, "keeper", workspace_role="admin")
    leaving = await _account(rls_harness, "leaving", workspace_role="member")
    with tenant_scope("second"):
        async with rls_harness.owner() as session:
            session.add(Organization(id="second", slug="second", name="Second"))
            await session.flush()
            session.add(
                Tenant(
                    id="second", slug="second", name="Second", organization_id="second"
                )
            )
            await session.flush()
            session.add(
                TenantMember(tenant_id="second", user_id=leaving.id, role="member")
            )
            await session.commit()
    deletion, _, _ = _deletion(rls_harness.restricted)
    deletion.broker = _FailsOnSecondWorkspace()  # type: ignore[assignment]

    plan = await plan_deletion(deletion, rls_harness.restricted, leaving.email)
    with pytest.raises(AccountDeletionIncomplete):
        await delete_account(deletion, rls_harness.restricted, plan)

    assert await _user(rls_harness, leaving.id) is not None
    [event] = await _server_events(rls_harness)
    assert (event.action, event.actor_user_id) == ("user.deletion_failed", None)
    assert event.details is not None
    assert event.details["platform_operator_command"] is True
    assert event.details["workspaces"] == 2
    assert len(event.details["workspaces_completed"]) == 1
