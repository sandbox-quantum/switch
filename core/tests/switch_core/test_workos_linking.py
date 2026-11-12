"""What an operator links by hand when a server moves to the WorkOS
directory, against Postgres, on the restricted role row-level security
applies to; `owner` only arranges fixtures and reads results."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    OidcIdentity,
    Organization,
    OrganizationAuditEvent,
    User,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.workos_linking import LinkingError, link_accounts, link_organization
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


class _WorkOS:
    """Answers the two reads linking makes: organizations by id, users by
    address."""

    def __init__(
        self,
        organizations: dict[str, dict] | None = None,
        users: dict[str, list[dict]] | None = None,
    ) -> None:
        self.organizations = organizations or {}
        self.users = users or {}

    async def organization(self, workos_organization_id: str) -> dict:
        return self.organizations[workos_organization_id]

    async def users_with_email(self, email: str) -> list[dict]:
        return self.users.get(email, [])


async def _organization(session_factory, workos_organization_id: str | None) -> str:
    organization_id = _id("org")
    async with session_factory() as session:
        session.add(
            Organization(
                id=organization_id,
                slug=organization_id,
                name="Acme",
                workos_organization_id=workos_organization_id,
            )
        )
        await session.commit()
    return organization_id


async def _person(session_factory) -> User:
    user_id = _id("user")
    user = User(id=user_id, name=user_id, email=f"{user_id}@example.test", role="user")
    async with session_factory() as session:
        session.add(user)
        await session.commit()
    return user


async def _identities(session_factory, user_id: str) -> list[tuple[str | None, str]]:
    async with session_factory() as session:
        rows = await session.execute(
            select(OidcIdentity.iss, OidcIdentity.sub).where(
                OidcIdentity.user_id == user_id
            )
        )
        return [(iss, sub) for iss, sub in rows]


class TestLinkingAnOrganization:
    async def test_links_it_records_the_customer_and_audits_it(
        self, rls_harness: RLSHarness
    ) -> None:
        owner, restricted = rls_harness.owner, rls_harness.restricted
        organization_id = await _organization(owner, None)
        workos_id, customer = _id("org_workos"), _id("ten")
        workos = _WorkOS(
            organizations={workos_id: {"metadata": {"tenant_id": customer}}}
        )

        said = await link_organization(
            restricted,
            workos,  # type: ignore[arg-type]
            organization_id,
            workos_id,
        )

        assert "now follows" in said
        async with owner() as session:
            organization = await session.get(Organization, organization_id)
            [event] = await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == organization_id,
                    OrganizationAuditEvent.action
                    == OrganizationAuditAction.LINKED_TO_DIRECTORY,
                )
            )
        assert organization is not None
        assert organization.workos_organization_id == workos_id
        assert organization.customer_id == customer
        assert event.details == {
            "workos_organization_id": workos_id,
            "customer_id": customer,
        }

    async def test_linking_it_again_to_the_same_one_changes_nothing(
        self, rls_harness: RLSHarness
    ) -> None:
        workos_id = _id("org_workos")
        organization_id = await _organization(rls_harness.owner, workos_id)

        said = await link_organization(
            rls_harness.restricted,
            _WorkOS(organizations={workos_id: {}}),  # type: ignore[arg-type]
            organization_id,
            workos_id,
        )

        assert "already follows" in said

    async def test_an_organization_linked_elsewhere_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        organization_id = await _organization(rls_harness.owner, _id("org_workos"))
        other = _id("org_workos")

        with pytest.raises(LinkingError, match="already follows"):
            await link_organization(
                rls_harness.restricted,
                _WorkOS(organizations={other: {}}),  # type: ignore[arg-type]
                organization_id,
                other,
            )

    async def test_a_workos_organization_another_follows_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        workos_id = _id("org_workos")
        await _organization(rls_harness.owner, workos_id)
        organization_id = await _organization(rls_harness.owner, None)

        with pytest.raises(LinkingError, match="Another organization"):
            await link_organization(
                rls_harness.restricted,
                _WorkOS(organizations={workos_id: {}}),  # type: ignore[arg-type]
                organization_id,
                workos_id,
            )

    async def test_an_unknown_organization_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        workos_id = _id("org_workos")

        with pytest.raises(LinkingError, match="No organization"):
            await link_organization(
                rls_harness.restricted,
                _WorkOS(organizations={workos_id: {}}),  # type: ignore[arg-type]
                _id("org"),
                workos_id,
            )


class TestLinkingAccounts:
    async def test_reports_without_writing_then_links_with_apply(
        self, rls_harness: RLSHarness
    ) -> None:
        owner, restricted = rls_harness.owner, rls_harness.restricted
        issuer = f"https://{_id('auth')}.example.test"
        ada = await _person(owner)
        workos = _WorkOS(
            users={
                ada.email: [
                    {"id": "user_ADA", "email": ada.email, "email_verified": True}
                ]
            }
        )

        reported = await link_accounts(
            restricted,
            workos,  # type: ignore[arg-type]
            UserStore(),
            issuer,
            apply=False,
        )
        [mine] = [link for link in reported if link.user_id == ada.id]
        assert mine.outcome == "would link WorkOS user user_ADA"
        assert await _identities(owner, ada.id) == []

        applied = await link_accounts(
            restricted,
            workos,  # type: ignore[arg-type]
            UserStore(),
            issuer,
            apply=True,
        )
        [mine] = [link for link in applied if link.user_id == ada.id]
        assert mine.linked
        assert await _identities(owner, ada.id) == [(issuer, "user_ADA")]

        again = await link_accounts(
            restricted,
            workos,  # type: ignore[arg-type]
            UserStore(),
            issuer,
            apply=True,
        )
        assert ada.id not in {link.user_id for link in again}

    @pytest.mark.parametrize(
        ("workos_users", "outcome"),
        [
            ([], "no WorkOS user has this address"),
            (
                [
                    {"id": "user_A", "email_verified": True},
                    {"id": "user_B", "email_verified": True},
                ],
                "2 WorkOS users have this address",
            ),
            (
                [{"id": "user_A", "email_verified": False}],
                "WorkOS user user_A has not verified this address",
            ),
        ],
    )
    async def test_an_account_without_one_verified_match_is_left(
        self, rls_harness: RLSHarness, workos_users: list[dict], outcome: str
    ) -> None:
        owner = rls_harness.owner
        issuer = f"https://{_id('auth')}.example.test"
        ada = await _person(owner)
        workos = _WorkOS(
            users={ada.email: [{**user, "email": ada.email} for user in workos_users]}
        )

        links = await link_accounts(
            rls_harness.restricted,
            workos,  # type: ignore[arg-type]
            UserStore(),
            issuer,
            apply=True,
        )

        [mine] = [link for link in links if link.user_id == ada.id]
        assert mine.outcome == outcome
        assert not mine.linked
        assert await _identities(owner, ada.id) == []

    async def test_a_workos_user_linked_to_another_account_is_left(
        self, rls_harness: RLSHarness
    ) -> None:
        owner = rls_harness.owner
        issuer = f"https://{_id('auth')}.example.test"
        ada, bea = await _person(owner), await _person(owner)
        async with owner() as session:
            session.add(OidcIdentity(user_id=bea.id, iss=issuer, sub="user_ADA"))
            await session.commit()
        workos = _WorkOS(
            users={
                ada.email: [
                    {"id": "user_ADA", "email": ada.email, "email_verified": True}
                ]
            }
        )

        links = await link_accounts(
            rls_harness.restricted,
            workos,  # type: ignore[arg-type]
            UserStore(),
            issuer,
            apply=True,
        )

        [mine] = [link for link in links if link.user_id == ada.id]
        assert mine.outcome == f"WorkOS user user_ADA is linked to account {bea.id}"
        assert await _identities(owner, ada.id) == []
