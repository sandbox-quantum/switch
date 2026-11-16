"""An invitation grants at most what its maker could, and only while they
still can; what accepting one does for someone already in the workspace; and
the organization's record of who joined it.

Against real Postgres, with the app `test_tenant_api_routes.py` builds:
demoting or removing an admin revokes the invitations they made, accepting
one refuses an invitation whose maker no longer administers the workspace
(which covers those made before revoking them existed), an admin invitation
raises a member to admin, and the preview says what an invitation is to.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AuditEvent,
    Invitation,
    OrganizationAuditEvent,
    TenantMember,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.gateway.tenants import INVITATION_MAKER_GONE
from tests.switch_core.gateway.test_tenant_api_routes import (
    TENANT_A,
    TENANT_B,
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)


async def _mint(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    tenant_id: str,
    maker_id: str,
    role: str = "member",
    email: str | None = None,
    uses_remaining: int = 2,
) -> tuple[str, str]:
    async with tenant_session(session_factory, tenant_id) as session:
        invitation, token = await InvitationStore().create(
            session,
            role=role,
            email=email,
            expires_at=datetime.now(UTC) + timedelta(days=1),
            uses_remaining=uses_remaining,
            created_by=maker_id,
        )
        await session.commit()
        return invitation.id, token


async def _invitation(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, id_: str
) -> Invitation:
    async with tenant_session(session_factory, tenant_id) as session:
        invitation = await session.get(Invitation, id_)
        assert invitation is not None
        return invitation


async def _revocations(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> list[tuple[str | None, str | None, dict | None]]:
    async with tenant_session(session_factory, tenant_id) as session:
        rows = await session.execute(
            select(AuditEvent.actor_user_id, AuditEvent.target_id, AuditEvent.details)
            .where(AuditEvent.action == "invitation.revoked")
            .order_by(AuditEvent.occurred_at)
        )
        return [tuple(row) for row in rows.all()]  # type: ignore[misc]


async def _outsider(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> str:
    await _make_tenant(session_factory, TENANT_B)
    return await _make_member(
        session_factory, name=name, tenant_id=TENANT_B, role="member"
    )


class TestRevokedWithTheirStanding:
    async def test_demoting_an_admin_revokes_the_invitations_they_made(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_A, role="admin"
        )
        maker = await _make_member(
            session_factory, name="maker", tenant_id=TENANT_A, role="admin"
        )
        link_id, link = await _mint(
            session_factory, tenant_id=TENANT_A, maker_id=maker, role="admin"
        )
        addressed_id, _ = await _mint(
            session_factory,
            tenant_id=TENANT_A,
            maker_id=maker,
            email="someone@example.invalid",
        )
        kept_id, _ = await _mint(session_factory, tenant_id=TENANT_A, maker_id=owner)
        outsider = await _outsider(session_factory, "outsider")
        app = _app(session_factory)

        async with _client(
            app, _token(owner, "owner@example.invalid", TENANT_A)
        ) as client:
            demoted = await client.patch(
                f"/tenants/{TENANT_A}/members/{maker}", json={"role": "member"}
            )
        async with _client(
            app, _token(outsider, "outsider@example.invalid", TENANT_B)
        ) as client:
            accepted = await client.post("/invitations/accept", json={"token": link})

        assert demoted.status_code == 200, demoted.text
        assert accepted.status_code == 403, accepted.text
        assert "revoked" in accepted.json()["detail"]
        assert (await _invitation(session_factory, TENANT_A, link_id)).revoked_at
        assert (await _invitation(session_factory, TENANT_A, addressed_id)).revoked_at
        assert (
            await _invitation(session_factory, TENANT_A, kept_id)
        ).revoked_at is None
        assert sorted(await _revocations(session_factory, TENANT_A)) == sorted(
            [
                (owner, link_id, {"reason": "creator_demoted", "created_by": maker}),
                (
                    owner,
                    addressed_id,
                    {"reason": "creator_demoted", "created_by": maker},
                ),
            ]
        )

    async def test_removing_someone_revokes_the_invitations_they_made(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The audit's case: made as an admin, demoted, removed, and back in
        as an admin with their own link. Removal revokes it whatever their
        role was by then."""
        await _make_tenant(session_factory, TENANT_A)
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_A, role="admin"
        )
        maker = await _make_member(
            session_factory, name="maker", tenant_id=TENANT_A, role="member"
        )
        link_id, link = await _mint(
            session_factory, tenant_id=TENANT_A, maker_id=maker, role="admin"
        )
        app = _app(session_factory)

        async with _client(
            app, _token(owner, "owner@example.invalid", TENANT_A)
        ) as client:
            removed = await client.delete(f"/tenants/{TENANT_A}/members/{maker}")
        async with _client(app, _token(maker, "maker@example.invalid", None)) as client:
            back = await client.post("/invitations/accept", json={"token": link})

        assert removed.status_code == 200, removed.text
        assert back.status_code == 403, back.text
        assert (await _invitation(session_factory, TENANT_A, link_id)).revoked_at
        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, maker)) is None
            [details] = (
                await session.scalars(
                    select(AuditEvent.details).where(
                        AuditEvent.action == "member.removed",
                        AuditEvent.target_id == maker,
                    )
                )
            ).all()
        assert details is not None and details["invitations_revoked"] == 1

    async def test_an_invitation_whose_maker_no_longer_administers_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """One made before demotions revoked anything: the maker's standing
        is checked again when it is used."""
        await _make_tenant(session_factory, TENANT_A)
        maker = await _make_member(
            session_factory, name="maker", tenant_id=TENANT_A, role="admin"
        )
        link_id, link = await _mint(
            session_factory, tenant_id=TENANT_A, maker_id=maker, role="admin"
        )
        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, maker))
            assert membership is not None
            membership.role = "member"
            await session.commit()
        outsider = await _outsider(session_factory, "outsider")

        async with _client(
            _app(session_factory), _token(outsider, "outsider@example.invalid", None)
        ) as client:
            preview = await client.post("/invitations/preview", json={"token": link})
            accepted = await client.post("/invitations/accept", json={"token": link})

        assert preview.status_code == 403, preview.text
        assert accepted.status_code == 403, accepted.text
        assert accepted.json()["detail"] == INVITATION_MAKER_GONE
        async with session_factory() as session:
            assert await session.get(TenantMember, (TENANT_A, outsider)) is None
        assert (
            await _invitation(session_factory, TENANT_A, link_id)
        ).uses_remaining == 2

    async def test_the_platform_operators_invitations_keep_working(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        await _make_member(
            session_factory, name="owner", tenant_id=TENANT_A, role="admin"
        )
        operator = await _make_member(
            session_factory,
            name="operator",
            tenant_id=TENANT_ZERO_ID,
            role="member",
            user_role="admin",
        )
        _, link = await _mint(session_factory, tenant_id=TENANT_A, maker_id=operator)
        outsider = await _outsider(session_factory, "outsider")

        async with _client(
            _app(session_factory), _token(outsider, "outsider@example.invalid", None)
        ) as client:
            accepted = await client.post("/invitations/accept", json={"token": link})

        assert accepted.status_code == 200, accepted.text


class TestAcceptingWhenAlreadyIn:
    async def test_an_admin_invitation_raises_a_member_to_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_A, role="admin"
        )
        member = await _make_member(
            session_factory, name="member", tenant_id=TENANT_A, role="member"
        )
        link_id, link = await _mint(
            session_factory, tenant_id=TENANT_A, maker_id=owner, role="admin"
        )

        async with _client(
            _app(session_factory), _token(member, "member@example.invalid", TENANT_A)
        ) as client:
            response = await client.post("/invitations/accept", json={"token": link})

        assert response.status_code == 200, response.text
        assert response.json()["role"] == "admin"
        assert response.json()["already_member"] is False
        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, member))
            assert membership is not None and membership.role == "admin"
            [details] = (
                await session.scalars(
                    select(AuditEvent.details).where(
                        AuditEvent.action == "invitation.accepted"
                    )
                )
            ).all()
        assert details == {"role": "admin", "previous_role": "member"}
        assert (
            await _invitation(session_factory, TENANT_A, link_id)
        ).uses_remaining == 1

    async def test_an_invitation_at_or_below_your_role_changes_and_spends_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory, TENANT_A)
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_A, role="admin"
        )
        other_admin = await _make_member(
            session_factory, name="other-admin", tenant_id=TENANT_A, role="admin"
        )
        link_id, link = await _mint(
            session_factory, tenant_id=TENANT_A, maker_id=owner, role="member"
        )

        async with _client(
            _app(session_factory),
            _token(other_admin, "other-admin@example.invalid", TENANT_A),
        ) as client:
            response = await client.post("/invitations/accept", json={"token": link})

        assert response.status_code == 200, response.text
        assert response.json()["already_member"] is True
        assert response.json()["role"] == "admin"
        assert response.json()["name"] == TENANT_A
        async with session_factory() as session:
            membership = await session.get(TenantMember, (TENANT_A, other_admin))
            assert membership is not None and membership.role == "admin"
        assert (
            await _invitation(session_factory, TENANT_A, link_id)
        ).uses_remaining == 2


class TestPreview:
    async def test_it_says_the_workspace_organization_and_role_and_nothing_else(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_ZERO_ID, role="admin"
        )
        link_id, link = await _mint(
            session_factory, tenant_id=TENANT_ZERO_ID, maker_id=owner, role="admin"
        )
        outsider = await _outsider(session_factory, "outsider")

        async with _client(
            _app(session_factory), _token(outsider, "outsider@example.invalid", None)
        ) as client:
            response = await client.post("/invitations/preview", json={"token": link})

        assert response.status_code == 200, response.text
        assert response.json() == {
            "workspace_name": "Default",
            "organization_name": "Default",
            "role": "admin",
        }
        invitation = await _invitation(session_factory, TENANT_ZERO_ID, link_id)
        assert invitation.uses_remaining == 2

    async def test_an_unknown_token_or_someone_elses_invitation_says_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_ZERO_ID, role="admin"
        )
        _, addressed = await _mint(
            session_factory,
            tenant_id=TENANT_ZERO_ID,
            maker_id=owner,
            email="intended@example.invalid",
        )
        outsider = await _outsider(session_factory, "outsider")

        async with _client(
            _app(session_factory), _token(outsider, "outsider@example.invalid", None)
        ) as client:
            unknown = await client.post("/invitations/preview", json={"token": "nope"})
            elsewhere = await client.post(
                "/invitations/preview", json={"token": addressed}
            )

        assert unknown.status_code == 404, unknown.text
        assert elsewhere.status_code == 403, elsewhere.text
        assert "Default" not in elsewhere.text

    async def test_signed_out_it_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_ZERO_ID, role="admin"
        )
        _, link = await _mint(session_factory, tenant_id=TENANT_ZERO_ID, maker_id=owner)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=_app(session_factory)),
            base_url="http://test",
        ) as client:
            response = await client.post("/invitations/preview", json={"token": link})

        assert response.status_code == 401, response.text


async def _organization_joins(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[tuple[str, str | None, dict | None]]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        rows = await session.execute(
            select(
                OrganizationAuditEvent.action,
                OrganizationAuditEvent.target_id,
                OrganizationAuditEvent.details,
            ).order_by(OrganizationAuditEvent.occurred_at)
        )
        return [tuple(row) for row in rows.all()]  # type: ignore[misc]


class TestJoiningTheOrganizationIsRecorded:
    """Someone new to an organization, joining one of its workspaces, is
    written in the organization's audit log; someone already in it, joining
    another of its workspaces, is not new to it."""

    async def test_by_invitation(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_ZERO_ID, role="admin"
        )
        _, link = await _mint(
            session_factory, tenant_id=TENANT_ZERO_ID, maker_id=owner, role="member"
        )
        outsider = await _outsider(session_factory, "outsider")

        async with _client(
            _app(session_factory), _token(outsider, "outsider@example.invalid", None)
        ) as client:
            accepted = await client.post("/invitations/accept", json={"token": link})
            again = await client.post("/invitations/accept", json={"token": link})

        assert accepted.status_code == 200, accepted.text
        assert again.status_code == 200, again.text
        assert await _organization_joins(session_factory) == [
            (
                "organization.member_joined_by_invitation",
                outsider,
                {
                    "workspace": TENANT_ZERO_ID,
                    "workspace_name": "Default",
                    "role": "member",
                    "invited_by": owner,
                },
            )
        ]

    async def test_by_e_mail_domain(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_member(
            session_factory, name="owner", tenant_id=TENANT_ZERO_ID, role="admin"
        )
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await JoinDomainStore().add(
                session, domain="example.invalid", created_by=owner
            )
            await session.commit()
        outsider = await _outsider(session_factory, "outsider")

        async with _client(
            _app(session_factory), _token(outsider, "outsider@example.invalid", None)
        ) as client:
            joined = await client.post(f"/joinable-tenants/{TENANT_ZERO_ID}/join")

        assert joined.status_code == 200, joined.text
        assert await _organization_joins(session_factory) == [
            (
                "organization.member_joined_by_domain",
                outsider,
                {
                    "workspace": TENANT_ZERO_ID,
                    "workspace_name": "Default",
                    "role": "member",
                    "domain": "example.invalid",
                },
            )
        ]
