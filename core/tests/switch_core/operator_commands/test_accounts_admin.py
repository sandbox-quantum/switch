"""`switch-accounts`, as an operator runs it: on the restricted role, bound
to nothing. Each change lands in the server's audit log with no actor and
`platform_operator_command` set."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core import accounts_admin
from switch_core.accounts.deletion import AccountDeletion
from switch_core.accounts_admin import (
    DeletionPlan,
    create_account,
    delete_account,
    grant_operator,
    list_accounts,
    plan_deletion,
    read_password,
    revoke_operator,
    run_delete,
    sign_out,
)
from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_OWNER_MARKER_META_KEY,
)
from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    ApiKey,
    AuditEvent,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    Room,
    ServerAuditEvent,
    ServiceConnection,
    Tenant,
    TenantMember,
    User,
)
from switch_core.gateway.invite_mail import AdminChangeEmail
from switch_core.operator_commands import CommandRefused
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.accounts.test_account_deletion import (
    ADMIN_EMAIL,
    _agent,
    _Broker,
    _deletion,
    _invitation,
)
from tests.switch_core.operator_commands.helpers import (
    RecordingMailer,
    email_of,
    make_organization,
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

    async def test_a_name_holding_a_hidden_character_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        with pytest.raises(CommandRefused, match="U\\+202E"):
            await create_account(
                rls_harness.restricted,
                email="fresh@example.invalid",
                name="report \u202eslrep.exe",
                password="correct-horse-battery-staple",
                operator=False,
            )

        assert await _server_events(rls_harness) == []

    def test_the_password_comes_from_a_file_without_its_line_ending(
        self, tmp_path: Path
    ) -> None:
        secret = tmp_path / "password"
        secret.write_text("correct horse battery\n")

        assert read_password(secret) == "correct horse battery"

    @pytest.mark.parametrize(
        ("make", "message"),
        [
            (lambda path: None, "Can't read the password file .*: No such file"),
            (lambda path: path.mkdir(), "Can't read the password file .*directory"),
            (
                lambda path: path.write_bytes(b"\xff\xfe\x00"),
                "The password file .* isn't UTF-8 text",
            ),
        ],
        ids=["missing", "a directory", "not text"],
    )
    def test_a_password_file_that_cant_be_read_is_refused_in_words(
        self, tmp_path: Path, make: Callable[[Path], object], message: str
    ) -> None:
        path = tmp_path / "password"
        make(path)

        with pytest.raises(CommandRefused, match=message):
            read_password(path)


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


class _MailerAfterTheFact(RecordingMailer):
    """Keeps, for each e-mail, whether the account was still there and how
    many of the command's connections were checked out as it was sent."""

    def __init__(self, rls_harness: RLSHarness, user_id: str) -> None:
        super().__init__()
        self._rls_harness = rls_harness
        self._user_id = user_id
        self.seen: list[tuple[str, bool, int]] = []

    async def send_admin_change(self, email: AdminChangeEmail) -> None:
        pool = self._rls_harness.restricted_engine.sync_engine.pool
        checked_out = pool.checkedout()  # type: ignore[attr-defined]
        exists = await _user(self._rls_harness, self._user_id) is not None
        self.seen.append((email.to, exists, checked_out))
        await super().send_admin_change(email)


async def test_an_org_admin_deleted_is_emailed_about_once_gone_holding_nothing(
    rls_harness: RLSHarness,
) -> None:
    made = await make_organization(
        rls_harness,
        people={
            "keeper": ("admin", "org_admin"),
            "leaving": ("member", "org_admin"),
        },
    )
    leaving, keeper = made.ids["leaving"], made.ids["keeper"]
    mailer = _MailerAfterTheFact(rls_harness, leaving)
    deletion, _, _ = _deletion(rls_harness.restricted, mailer)

    plan = await plan_deletion(deletion, rls_harness.restricted, email_of(leaving))
    await delete_account(deletion, rls_harness.restricted, plan)

    assert sorted(mailer.seen) == sorted(
        [(email_of(leaving), False, 0), (email_of(keeper), False, 0)]
    )
    async with rls_harness.owner() as session:
        [event] = await session.scalars(
            select(OrganizationAuditEvent).where(
                OrganizationAuditEvent.organization_id == made.organization_id
            )
        )
    assert (event.action, event.target_id, event.actor_user_id) == (
        OrganizationAuditAction.MEMBER_REMOVED,
        leaving,
        None,
    )
    assert event.details == {
        "role": "org_admin",
        "reason": "account_deleted",
        "platform_access": True,
        **COMMAND,
    }


class _Terminal:
    """Standard input, a terminal or not."""

    def __init__(self, tty: bool) -> None:
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


class _Operator:
    """Types `answer` at the prompt, and keeps what it was asked."""

    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.asked: list[str] = []

    def __call__(self, prompt: str) -> str:
        self.asked.append(prompt)
        return self.answer


def _never_asked(prompt: str) -> str:
    raise AssertionError(f"asked {prompt!r}")


@pytest.fixture
def terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.stdin", _Terminal(True))


@pytest.fixture
def no_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("sys.stdin", _Terminal(False))


async def _account_member_of_tenant_zero(rls_harness: RLSHarness, user_id: str) -> None:
    with tenant_scope(TENANT_ZERO_ID):
        async with rls_harness.owner() as session:
            session.add(
                TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user_id, role="member")
            )
            await session.commit()


async def _holds(
    rls_harness: RLSHarness, tenant_id: str, user_id: str, blocker: str
) -> None:
    """`user_id` comes to own an agent, a device or an open chat in
    `tenant_id`, each of which only a running server can remove."""
    with tenant_scope(tenant_id):
        async with rls_harness.owner() as session:
            owner = await session.get(User, user_id)
            assert owner is not None
            if blocker == "agent":
                await _agent(session, tenant_id, owner, "latecomer")
            elif blocker == "device":
                session.add(
                    AgentController(
                        tenant_id=tenant_id,
                        owner_id=user_id,
                        name="new laptop",
                        kind="console",
                    )
                )
            else:
                session.add(_room(tenant_id, owner, "Late chat", private=True))
            await session.commit()


async def _owns_an_agent(rls_harness: RLSHarness, owner: User, name: str) -> None:
    with tenant_scope(TENANT_ZERO_ID):
        async with rls_harness.owner() as session:
            await _agent(session, TENANT_ZERO_ID, owner, name)
            await session.commit()


class TestDeleteCommand:
    """`switch-accounts delete` as the operator sees it: what is connected,
    what blocks it, and the confirmation before anything is deleted."""

    async def test_it_says_everything_connected_to_the_account(
        self,
        rls_harness: RLSHarness,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        made = await make_organization(
            rls_harness,
            people={
                "keeper": ("admin", "org_admin"),
                "leaving": ("member", "org_admin"),
            },
        )
        tenant_id = made.tenant_id
        with tenant_scope(tenant_id):
            async with rls_harness.owner() as session:
                leaving = await session.get(User, made.ids["leaving"])
                assert leaving is not None
                await _agent(session, tenant_id, leaving, "helper")
                await _invitation(session, tenant_id, leaving)
                session.add_all(
                    [
                        AgentController(
                            tenant_id=tenant_id,
                            owner_id=leaving.id,
                            name="laptop",
                            kind="console",
                        ),
                        _room(tenant_id, leaving, "Welcome", private=True),
                        _room(tenant_id, leaving, "team", private=False),
                        ApiKey(
                            tenant_id=tenant_id,
                            user_id=leaving.id,
                            key_hash=uuid.uuid4().hex,
                            encrypted_key="sealed",
                            label="cli",
                            type="user",
                        ),
                        ServiceConnection(
                            tenant_id=tenant_id,
                            user_id=leaving.id,
                            service="github",
                            status="active",
                            consent="read",
                            granted_scopes=[],
                            account_id="1001",
                            external_identity="leaving",
                            encrypted_secret="sealed",
                            secret_revision=1,
                        ),
                    ]
                )
                await session.commit()
        monkeypatch.setattr("builtins.input", _never_asked)
        deletion, _, _ = _deletion(rls_harness.restricted)

        status = await run_delete(
            deletion,
            rls_harness.restricted,
            leaving.email,
            execute=False,
            yes=False,
        )

        out = capsys.readouterr().out.splitlines()
        assert status == 1
        for line in [
            f"Account {leaving.email} ({leaving.id}): Leaving",
            f"  Acme workspace ({tenant_id}), as admin",
            "Organizations it stops being an organization admin of, whose other "
            "admins are e-mailed: Acme",
            f"In Acme workspace ({tenant_id}):",
            "  Agents it owns (1): helper",
            "  Devices (1): laptop",
            "  Open chats (1): Welcome",
            "  API keys, deleted (2): cli, helper",
            "  Service connections, removed and signed out (1): github",
            "  Rooms it created or owns, which stay with no owner for the "
            "workspace's admins (1): team",
            f"  Passed to {email_of(made.ids['keeper'])}: 1 invitation(s)",
            "Nothing changed.",
        ]:
            assert line in out
        assert "sealed" not in "\n".join(out)

    async def test_a_blocked_deletion_lists_what_blocks_it_and_deletes_nothing(
        self,
        rls_harness: RLSHarness,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
        terminal: None,
    ) -> None:
        only_admin = await _account(rls_harness, "only-admin", workspace_role="admin")
        await _account(rls_harness, "colleague", workspace_role="member")
        await _owns_an_agent(rls_harness, only_admin, "helper")
        monkeypatch.setattr("builtins.input", _never_asked)
        deletion, _, _ = _deletion(rls_harness.restricted)

        dry_run = await run_delete(
            deletion, rls_harness.restricted, only_admin.email, execute=False, yes=False
        )
        capsys.readouterr()
        with pytest.raises(CommandRefused, match="What has to happen first"):
            await run_delete(
                deletion,
                rls_harness.restricted,
                only_admin.email,
                execute=True,
                yes=False,
            )

        out = capsys.readouterr().out
        assert dry_run == 1
        assert "Blocked. The account can't be deleted until this is done:" in out
        assert "  - You're the only admin of" in out
        assert "1 agent(s)" in out
        assert "transfer the agents to someone else" in " ".join(out.split())
        assert await _user(rls_harness, only_admin.id) is not None
        [event] = await _server_events(rls_harness)
        assert event.action == "user.deletion_refused"
        assert event.details is not None
        assert "only admin" in event.details["reason"]
        assert "only a running server" in event.details["reason"]

    @pytest.mark.parametrize(
        "typed",
        [
            "",
            "LEAVING@example.invalid",
            "leaving@example.invalid ",
            "keeper@example.invalid",
        ],
    )
    async def test_only_the_exact_email_typed_deletes(
        self,
        rls_harness: RLSHarness,
        monkeypatch: pytest.MonkeyPatch,
        terminal: None,
        typed: str,
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        leaving = await _account(rls_harness, "leaving", workspace_role="member")
        operator = _Operator(typed)
        monkeypatch.setattr("builtins.input", operator)
        deletion, _, _ = _deletion(rls_harness.restricted)

        with pytest.raises(CommandRefused, match="isn't the account's e-mail"):
            await run_delete(
                deletion, rls_harness.restricted, leaving.email, execute=True, yes=False
            )
        assert await _user(rls_harness, leaving.id) is not None
        assert await _server_events(rls_harness) == []

        operator.answer = leaving.email
        status = await run_delete(
            deletion, rls_harness.restricted, leaving.email, execute=True, yes=False
        )

        assert status == 0
        assert (
            operator.asked
            == [f"\nTo delete it, type the account's e-mail ({leaving.email}): "] * 2
        )
        assert await _user(rls_harness, leaving.id) is None
        [event] = await _server_events(rls_harness)
        assert event.action == "user.deleted"

    async def test_yes_deletes_without_asking(
        self,
        rls_harness: RLSHarness,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
        no_terminal: None,
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        leaving = await _account(rls_harness, "leaving", workspace_role="member")
        monkeypatch.setattr("builtins.input", _never_asked)
        deletion, _, _ = _deletion(rls_harness.restricted)

        status = await run_delete(
            deletion, rls_harness.restricted, leaving.email, execute=True, yes=True
        )

        assert status == 0
        assert f"Deleted the account {leaving.email}." in capsys.readouterr().out
        assert await _user(rls_harness, leaving.id) is None

    async def test_without_a_terminal_or_yes_it_refuses_rather_than_wait(
        self,
        rls_harness: RLSHarness,
        monkeypatch: pytest.MonkeyPatch,
        no_terminal: None,
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        leaving = await _account(rls_harness, "leaving", workspace_role="member")
        monkeypatch.setattr("builtins.input", _never_asked)
        deletion, _, _ = _deletion(rls_harness.restricted)

        with pytest.raises(CommandRefused, match="isn't a terminal.*--yes"):
            await run_delete(
                deletion, rls_harness.restricted, leaving.email, execute=True, yes=False
            )

        assert await _user(rls_harness, leaving.id) is not None
        assert await _server_events(rls_harness) == []

    async def test_without_execute_it_only_shows(
        self,
        rls_harness: RLSHarness,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
        terminal: None,
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        leaving = await _account(rls_harness, "leaving", workspace_role="member")
        monkeypatch.setattr("builtins.input", _never_asked)
        deletion, _, _ = _deletion(rls_harness.restricted)

        status = await run_delete(
            deletion, rls_harness.restricted, leaving.email, execute=False, yes=False
        )

        assert status == 0
        assert "Add --execute to delete it." in capsys.readouterr().out
        assert await _user(rls_harness, leaving.id) is not None

    async def test_what_changes_while_confirming_is_not_deleted(
        self,
        rls_harness: RLSHarness,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
        terminal: None,
    ) -> None:
        await _account(rls_harness, "keeper", workspace_role="admin")
        leaving = await _account(rls_harness, "leaving", workspace_role="member")
        monkeypatch.setattr("builtins.input", _Operator(leaving.email))
        planned = 0

        async def an_agent_arrives_meanwhile(
            deletion: AccountDeletion, session_factory: object, email: str
        ) -> DeletionPlan:
            nonlocal planned
            planned += 1
            if planned == 2:
                await _owns_an_agent(rls_harness, leaving, "latecomer")
            return await plan_deletion(deletion, rls_harness.restricted, email)

        monkeypatch.setattr(accounts_admin, "plan_deletion", an_agent_arrives_meanwhile)
        deletion, _, _ = _deletion(rls_harness.restricted)

        with pytest.raises(CommandRefused, match="Run it again"):
            await run_delete(
                deletion, rls_harness.restricted, leaving.email, execute=True, yes=False
            )

        out = capsys.readouterr().out
        assert "The account changed since it was shown." in out
        assert "  Agents it owns (1): latecomer" in out
        assert await _user(rls_harness, leaving.id) is not None

    @pytest.mark.parametrize("blocker", ["agent", "device", "chat"])
    async def test_a_blocker_made_in_another_workspace_after_the_plan_changes_nothing(
        self,
        rls_harness: RLSHarness,
        capsys: pytest.CaptureFixture[str],
        monkeypatch: pytest.MonkeyPatch,
        no_terminal: None,
        blocker: str,
    ) -> None:
        """With --yes the plan shown is the one deleted, so the command looks
        at every workspace again before it changes any: something only a
        running server can remove, made in the second workspace meanwhile,
        stops it before the first is left."""
        made = await make_organization(
            rls_harness,
            people={
                "keeper": ("admin", "org_admin"),
                "leaving": ("member", "org_admin"),
            },
        )
        leaving_id = made.ids["leaving"]
        await _account_member_of_tenant_zero(rls_harness, leaving_id)
        await _account(rls_harness, "zero-admin", workspace_role="admin")
        mailer = RecordingMailer()
        deletion, _, _ = _deletion(rls_harness.restricted, mailer)
        planned = 0

        async def a_blocker_arrives_meanwhile(
            deletion: AccountDeletion, session_factory: object, email: str
        ) -> DeletionPlan:
            nonlocal planned
            planned += 1
            plan = await plan_deletion(deletion, rls_harness.restricted, email)
            if planned == 1:
                await _holds(rls_harness, made.tenant_id, leaving_id, blocker)
            return plan

        monkeypatch.setattr(
            accounts_admin, "plan_deletion", a_blocker_arrives_meanwhile
        )
        monkeypatch.setattr("builtins.input", _never_asked)

        with pytest.raises(CommandRefused, match="Nothing was deleted"):
            await run_delete(
                deletion,
                rls_harness.restricted,
                email_of(leaving_id),
                execute=True,
                yes=True,
            )

        assert planned == 2
        assert "The account changed since it was shown." in capsys.readouterr().out
        assert await _user(rls_harness, leaving_id) is not None
        async with rls_harness.owner() as session:
            memberships = set(
                await session.scalars(
                    select(TenantMember.tenant_id).where(
                        TenantMember.user_id == leaving_id
                    )
                )
            )
            org_admin = await session.get(
                OrganizationMember, (made.organization_id, leaving_id)
            )
        assert memberships == {TENANT_ZERO_ID, made.tenant_id}
        assert org_admin is not None and org_admin.role == "org_admin"
        assert await _server_events(rls_harness) == []
        assert mailer.sent == []


def _room(tenant_id: str, owner: User, name: str, *, private: bool) -> Room:
    return Room(
        tenant_id=tenant_id,
        transport_room_id=f"!{uuid.uuid4().hex}:test",
        name=name,
        description=name,
        created_by=owner.id,
        owner_id=owner.id,
        read_visibility="private" if private else "public",
        write_visibility="private",
    )


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
    with pytest.raises(CommandRefused, match="failed partway"):
        await delete_account(deletion, rls_harness.restricted, plan)

    assert await _user(rls_harness, leaving.id) is not None
    [event] = await _server_events(rls_harness)
    assert (event.action, event.actor_user_id) == ("user.deletion_failed", None)
    assert event.details is not None
    assert event.details["platform_operator_command"] is True
    assert event.details["workspaces"] == 2
    assert len(event.details["workspaces_completed"]) == 1
