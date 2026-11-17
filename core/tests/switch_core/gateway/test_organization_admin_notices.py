"""Someone who stops being an organization's `org_admin` is e-mailed about to
every `org_admin` of it and to themselves, once the change commits; with no
relay configured, a warning says nobody was; a send that fails fails
nothing (`organization_admin_notices.py`)."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import OrganizationMember, Tenant, TenantMember
from switch_core.db.session_scope import tenant_session
from switch_core.gateway.invite_mail import (
    AdminChangeEmail,
    InviteEmail,
    InviteEmailFailed,
)
from switch_core.organization_admin_notices import (
    AdminChange,
    AdminChangeKind,
    OrganizationAdminNotices,
    Person,
    describe,
)
from tests.switch_core.gateway.test_organization_routes import (
    DASHBOARD,
    _app,
    _client,
    _name,
    _organization_events,
    _workspace,
)
from tests.switch_core.pool_checkouts import PoolCheckouts


class _RecordingMailer:
    def __init__(self) -> None:
        self.sent: list[AdminChangeEmail] = []

    async def send_invitation(self, invite: InviteEmail) -> None:
        raise AssertionError("no invitation is sent here")

    async def send_admin_change(self, email: AdminChangeEmail) -> None:
        self.sent.append(email)


class _FailingMailer(_RecordingMailer):
    async def send_admin_change(self, email: AdminChangeEmail) -> None:
        raise InviteEmailFailed("relay refused the message")


class SentAfter:
    """Notes when an app under test has sent its response, for a fake to ask
    while it is called."""

    def __init__(self) -> None:
        self.responded = False

    def wrap(self, app: Any) -> Any:
        async def asgi(scope: Any, receive: Any, send: Any) -> None:
            async def noting(message: Any) -> None:
                await send(message)
                if message["type"] == "http.response.body" and not message.get(
                    "more_body", False
                ):
                    self.responded = True

            await app(scope, receive, noting)

        return asgi


class WatchedMailer(_RecordingMailer):
    """Keeps each e-mail's recipient, whether the response had gone when it
    was sent, and how many connections the request held then."""

    def __init__(self, response: SentAfter, pool_checkouts: PoolCheckouts) -> None:
        super().__init__()
        self._response = response
        self._pool_checkouts = pool_checkouts
        self.seen: list[tuple[str, bool, int]] = []

    async def send_admin_change(self, email: AdminChangeEmail) -> None:
        self.seen.append(
            (email.to, self._response.responded, self._pool_checkouts.held_now())
        )
        await super().send_admin_change(email)


class _BrokenMailer(_RecordingMailer):
    """Fails with something other than the relay's own refusal."""

    async def send_admin_change(self, email: AdminChangeEmail) -> None:
        raise ConnectionResetError("connection reset by peer")


def _email(name: str) -> str:
    return f"{name}@example.invalid"


async def _three_admins(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str]:
    ada, bob, cy = _name("ada"), _name("bob"), _name("cy")
    tenant_id = await _workspace(
        session_factory,
        {
            ada: ("admin", "org_admin"),
            bob: ("member", "org_admin"),
            cy: ("member", "org_admin"),
        },
    )
    return tenant_id, ada, bob, cy


async def _organization_role(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, user_id: str
) -> str | None:
    async with tenant_session(session_factory, tenant_id) as session:
        tenant = await session.get(Tenant, tenant_id)
        assert tenant is not None
        member = await session.get(
            OrganizationMember, (tenant.organization_id, user_id)
        )
        return None if member is None else member.role


class TestDemoting:
    async def test_each_org_admin_and_the_person_demoted_are_emailed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant_id, ada, bob, cy = await _three_admins(session_factory)
        mailer = _RecordingMailer()

        async with _client(_app(session_factory, mailer=mailer), ada, tenant_id) as c:
            response = await c.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        assert response.status_code == 200, response.text
        assert sorted(email.to for email in mailer.sent) == sorted(
            _email(name) for name in (ada, bob, cy)
        )
        email = mailer.sent[0]
        assert email.subject == f"{bob} is no longer an organization admin of Acme"
        assert email.summary == (
            f"{ada} ({_email(ada)}) made {bob} ({_email(bob)}) a member of Acme, "
            "so they are no longer an organization admin there."
        )
        assert email.audit_log_link == f"{DASHBOARD}/settings/org/audit-log"
        assert email.reason is None
        [event] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.ROLE_CHANGED
        )
        assert (event.actor_user_id, event.target_id) == (ada, bob)

    async def test_stepping_down_says_they_did_it_themselves(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant_id, ada, bob, cy = await _three_admins(session_factory)
        mailer = _RecordingMailer()

        async with _client(_app(session_factory, mailer=mailer), bob, tenant_id) as c:
            response = await c.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        assert response.status_code == 200, response.text
        assert sorted(email.to for email in mailer.sent) == sorted(
            _email(name) for name in (ada, bob, cy)
        )
        assert {email.summary for email in mailer.sent} == {
            f"{bob} ({_email(bob)}) stepped down as an organization admin of Acme."
        }

    async def test_granting_org_admin_emails_nobody(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        mailer = _RecordingMailer()

        async with _client(_app(session_factory, mailer=mailer), ada, tenant_id) as c:
            response = await c.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert response.status_code == 200, response.text
        assert mailer.sent == []


class TestRemoving:
    async def test_removing_an_org_admin_emails_each_admin_and_them(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        tenant_id, ada, bob, cy = await _three_admins(session_factory)
        async with tenant_session(session_factory, tenant_id) as session:
            await session.delete(await session.get(TenantMember, (tenant_id, bob)))
            await session.commit()
        mailer = _RecordingMailer()

        async with _client(_app(session_factory, mailer=mailer), ada, tenant_id) as c:
            response = await c.delete(f"/organizations/current/members/{bob}")

        assert response.status_code == 200, response.text
        assert sorted(email.to for email in mailer.sent) == sorted(
            _email(name) for name in (ada, bob, cy)
        )
        assert {email.summary for email in mailer.sent} == {
            f"{ada} ({_email(ada)}) removed {bob} ({_email(bob)}) from Acme, "
            "where they were an organization admin."
        }
        [event] = await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.MEMBER_REMOVED
        )
        assert event.target_id == bob
        assert event.details is not None and event.details["role"] == "org_admin"

    async def test_removing_a_member_emails_nobody(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        async with tenant_session(session_factory, tenant_id) as session:
            await session.delete(await session.get(TenantMember, (tenant_id, bob)))
            await session.commit()
        mailer = _RecordingMailer()

        async with _client(_app(session_factory, mailer=mailer), ada, tenant_id) as c:
            response = await c.delete(f"/organizations/current/members/{bob}")

        assert response.status_code == 200, response.text
        assert mailer.sent == []


class TestAfterTheResponse:
    """The e-mails go out once the response has been sent, and while they
    do the request holds no connection: a slow relay holds up nobody's
    pool."""

    async def test_a_demotion(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        tenant_id, ada, bob, cy = await _three_admins(session_factory)
        response = SentAfter()
        mailer = WatchedMailer(response, pool_checkouts)
        app = pool_checkouts.wrap(response.wrap(_app(session_factory, mailer=mailer)))

        async with _client(app, ada, tenant_id) as c:
            demoted = await c.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        assert demoted.status_code == 200, demoted.text
        assert sorted(mailer.seen) == sorted(
            (_email(name), True, 0) for name in (ada, bob, cy)
        )

    async def test_a_removal(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        pool_checkouts: PoolCheckouts,
    ) -> None:
        tenant_id, ada, bob, cy = await _three_admins(session_factory)
        async with tenant_session(session_factory, tenant_id) as session:
            await session.delete(await session.get(TenantMember, (tenant_id, bob)))
            await session.commit()
        response = SentAfter()
        mailer = WatchedMailer(response, pool_checkouts)
        app = pool_checkouts.wrap(response.wrap(_app(session_factory, mailer=mailer)))

        async with _client(app, ada, tenant_id) as c:
            removed = await c.delete(f"/organizations/current/members/{bob}")

        assert removed.status_code == 200, removed.text
        assert sorted(mailer.seen) == sorted(
            (_email(name), True, 0) for name in (ada, bob, cy)
        )


class TestWithoutEmail:
    async def test_no_relay_sends_nothing_and_warns_once(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        tenant_id, ada, bob, _cy = await _three_admins(session_factory)

        with caplog.at_level(logging.WARNING, "switch_core.organization_admin_notices"):
            async with _client(_app(session_factory), ada, tenant_id) as c:
                response = await c.patch(
                    f"/organizations/current/members/{bob}", json={"role": "member"}
                )

        assert response.status_code == 200, response.text
        warnings = [
            record
            for record in caplog.records
            if record.name == "switch_core.organization_admin_notices"
        ]
        assert len(warnings) == 1
        assert warnings[0].levelno == logging.WARNING
        assert "not e-mailed" in warnings[0].getMessage()
        assert await _organization_role(session_factory, tenant_id, bob) == "member"
        assert await _organization_events(
            session_factory, tenant_id, OrganizationAuditAction.ROLE_CHANGED
        )

    async def test_a_send_that_fails_leaves_the_change_made(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        tenant_id, ada, bob, _cy = await _three_admins(session_factory)

        with caplog.at_level(logging.ERROR, "switch_core.organization_admin_notices"):
            async with _client(
                _app(session_factory, mailer=_FailingMailer()), ada, tenant_id
            ) as c:
                response = await c.patch(
                    f"/organizations/current/members/{bob}", json={"role": "member"}
                )

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "member"
        assert await _organization_role(session_factory, tenant_id, bob) == "member"
        errors = [
            record
            for record in caplog.records
            if record.name == "switch_core.organization_admin_notices"
            and record.levelno == logging.ERROR
        ]
        # One for each of the three people told.
        assert len(errors) == 3

    async def test_any_failure_sending_leaves_the_change_made(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        tenant_id, ada, bob, _cy = await _three_admins(session_factory)

        with caplog.at_level(logging.ERROR, "switch_core.organization_admin_notices"):
            async with _client(
                _app(session_factory, mailer=_BrokenMailer()), ada, tenant_id
            ) as c:
                response = await c.patch(
                    f"/organizations/current/members/{bob}", json={"role": "member"}
                )

        assert response.status_code == 200, response.text
        assert await _organization_role(session_factory, tenant_id, bob) == "member"
        errors = [
            record
            for record in caplog.records
            if record.name == "switch_core.organization_admin_notices"
            and record.levelno == logging.ERROR
        ]
        assert len(errors) == 3

    async def test_a_failure_reading_who_to_tell_is_logged_with_ids_not_raised(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        mailer = _RecordingMailer()
        notices = OrganizationAdminNotices(session_factory, mailer, DASHBOARD)
        change = AdminChange(
            organization_id="org-gone",
            kind=AdminChangeKind.DEMOTED,
            target=_person("bob"),
            actor=_person("ada"),
            reason=None,
        )

        with caplog.at_level(logging.ERROR, "switch_core.organization_admin_notices"):
            await notices.send(change)

        assert mailer.sent == []
        [error] = [
            record
            for record in caplog.records
            if record.name == "switch_core.organization_admin_notices"
        ]
        assert error.levelno == logging.ERROR
        message = error.getMessage()
        assert "org-gone" in message and "bob" in message and "demoted" in message
        assert "@" not in message


def _person(name: str) -> Person:
    return Person(name, name.title(), _email(name))


@pytest.mark.parametrize(
    ("kind", "actor", "summary"),
    [
        (
            AdminChangeKind.ACCOUNT_DELETED,
            "bob",
            "Bob (bob@example.invalid) deleted their Switch account, so they are "
            "no longer an organization admin of Acme.",
        ),
        (
            AdminChangeKind.ACCOUNT_DELETED,
            "ada",
            "Ada (ada@example.invalid) deleted the Switch account of Bob "
            "(bob@example.invalid), so they are no longer an organization admin "
            "of Acme.",
        ),
        (
            AdminChangeKind.ACCOUNT_DELETED,
            None,
            "A platform operator, with a server command, deleted the Switch "
            "account of Bob (bob@example.invalid), so they are no longer an "
            "organization admin of Acme.",
        ),
        (
            AdminChangeKind.LEFT,
            "bob",
            "Bob (bob@example.invalid) left Acme, where they were an organization "
            "admin.",
        ),
        (
            AdminChangeKind.PROMOTED_BY_OPERATOR,
            None,
            "A platform operator, with a server command, made Bob "
            "(bob@example.invalid) an organization admin of Acme, without an "
            "organization admin doing so.",
        ),
    ],
)
def test_each_change_says_who_did_what_to_whom(
    kind: AdminChangeKind, actor: str | None, summary: str
) -> None:
    change = AdminChange(
        organization_id="org",
        kind=kind,
        target=_person("bob"),
        actor=None if actor is None else _person(actor),
        reason=None,
    )

    assert describe(change, "Acme")[1] == summary
