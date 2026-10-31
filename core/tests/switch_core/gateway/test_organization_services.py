"""An organization's switch per service, for every workspace in it, through
the real gateway on Postgres.

Locked, it is out of every workspace admin's reach; unlocked, it is the
default each workspace may override; cleared, the organization has no say.
Where a change leaves a service off, what it was issued is withdrawn in each
workspace, as a workspace admin's switch does.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.app_credentials import ConnectorApps
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    organization_locked,
)
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    OrganizationAuditEvent,
    OrganizationMember,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.organization_services import (
    router as organization_services_router,
)
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import FakeVendor
from tests.switch_core.connections.service_harness import (
    STORE,
    agent_with_key,
    build_service_harness,
)
from tests.switch_core.gateway.test_workspace_services import (
    _granted,
    _issuance,
    _issuances,
    _person,
)
from tests.switch_core.management.harness import Harness, add_member, cookies_for

ORGANIZATION = "/gateway/organizations/current/services"
WORKSPACE = "/gateway/workspace/services"
# A second workspace of tenant zero's organization.
SIBLING = "tenant-organization-services-sibling"


@pytest.fixture
def vendor() -> FakeVendor:
    return FakeVendor()


@pytest.fixture
async def harness(
    session_factory: async_sessionmaker[AsyncSession], vendor: FakeVendor
) -> Harness:
    """Services gated per workspace, with organizations' say in force: the
    broker holds organizations' apps (none saved), as with
    `organization_connector_apps` on."""
    harness, broker = build_service_harness(
        session_factory, vendor, workspace_gate=True
    )
    organization_apps = OrganizationApps(
        apps=cast(ConnectorApps, SimpleNamespace(specs={})),
        store=OrganizationAppCredentialStore(TEST_KEYRING),
    )
    broker._organization_apps = organization_apps
    broker._organization_settings = True
    harness.gateway_app.state.organization_apps = organization_apps
    harness.gateway_app.dependency_overrides[gw_deps.get_organization_store] = lambda: (
        OrganizationStore()
    )
    harness.gateway_app.include_router(organization_services_router)
    async with session_factory() as session:
        session.add(
            Tenant(
                id=SIBLING, slug=SIBLING, name="Sibling", organization_id=TENANT_ZERO_ID
            )
        )
        await session.commit()
    return harness


async def _org_admin(session_factory: async_sessionmaker[AsyncSession]) -> User:
    user = await _person(session_factory, "org-admin", member_role=None)
    async with session_factory() as session:
        session.add(
            OrganizationMember(
                organization_id=TENANT_ZERO_ID, user_id=user.id, role="org_admin"
            )
        )
        await session.commit()
    return user


async def _call(harness: Harness, user: User, method: str, path: str, body=None):
    async with harness.client() as client:
        return await client.request(method, path, json=body, cookies=cookies_for(user))


def _by_slug(response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {service["slug"]: service for service in response.json()["services"]}


async def _events(session_factory) -> list[OrganizationAuditEvent]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(OrganizationAuditEvent)
                .where(OrganizationAuditEvent.action.like("organization.service_%"))
                .order_by(OrganizationAuditEvent.occurred_at)
            )
        )


class TestWhoMayCall:
    async def test_a_workspace_owner_is_refused(self, harness: Harness) -> None:
        owner = await _person(harness.session_factory, "owner", member_role="owner")
        answers = [
            await _call(harness, owner, "GET", ORGANIZATION),
            await _call(
                harness,
                owner,
                "PUT",
                f"{ORGANIZATION}/github",
                {"enabled": False, "locked": True},
            ),
            await _call(harness, owner, "DELETE", f"{ORGANIZATION}/github"),
        ]
        assert [answer.status_code for answer in answers] == [403] * 3

    async def test_an_unknown_service_is_not_found(self, harness: Harness) -> None:
        admin = await _org_admin(harness.session_factory)
        answer = await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/no-such-service",
            {"enabled": True, "locked": False},
        )
        assert answer.status_code == 404


class TestLocked:
    async def test_off_and_locked_keeps_it_out_of_every_workspace(
        self, harness: Harness, vendor: FakeVendor, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        ada = await add_member(session_factory, "ada")
        agent_id, _ = await agent_with_key(session_factory, ada, "builder")
        github = await _granted(session_factory, ada, agent_id, "github")
        async with session_factory() as session:
            session.add(_issuance(github, ada.id, "github", "ghs_here"))
            await session.commit()
        async with tenant_session(session_factory, SIBLING) as session:
            session.add(
                _issuance(None, ada.id, "github", "ghs_elsewhere", tenant_id=SIBLING)
            )
            await session.commit()
        # The workspace admin had it on.
        assert (
            await _call(
                harness,
                workspace_admin,
                "PUT",
                f"{WORKSPACE}/github",
                {"enabled": True},
            )
        ).status_code == 200

        locked = await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": False, "locked": True},
        )
        listed = await _call(harness, workspace_admin, "GET", WORKSPACE)
        refused = await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": True}
        )
        organization = await _call(harness, admin, "GET", ORGANIZATION)

        assert locked.status_code == 200, locked.text
        assert locked.json()["warning"] is None
        assert sorted(vendor.revoked) == ["ghs_elsewhere", "ghs_here"]
        assert (await _issuances(session_factory, SIBLING))[
            "ghs_elsewhere"
        ].encrypted_token is None
        github_here = _by_slug(listed)["github"]
        assert github_here["enabled"] is False
        assert github_here["organization_locked"] is True
        assert refused.status_code == 409
        assert "locked off" in refused.json()["detail"]
        assert organization.json()["workspaces"] == 2
        github_above = _by_slug(organization)["github"]
        assert github_above["setting"] == {"enabled": False, "locked": True}
        assert github_above["workspaces_on"] == 0
        assert github_above["updated_by_name"] == "org-admin"
        [event] = await _events(session_factory)
        assert event.action == OrganizationAuditAction.SERVICE_SET
        assert event.details == {
            "service": "github",
            "enabled": False,
            "locked": True,
            "previous": None,
        }

    async def test_the_refusal_names_the_organization(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": False, "locked": True},
        )
        broker: ServiceBroker = harness.gateway_app.state.service_broker
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            with pytest.raises(ServiceError) as refused:
                await broker.require_workspace_enabled(session, "github")
        assert refused.value.message == organization_locked("GitHub", enabled=False)


class TestUnlocked:
    async def test_it_is_the_default_each_workspace_may_override(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        on = await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": True, "locked": False},
        )
        before = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))
        switched = await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": False}
        )
        after = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))
        organization = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))

        assert on.status_code == 200, on.text
        assert before["github"] == {
            **before["github"],
            "enabled": True,
            "organization_locked": False,
        }
        assert switched.status_code == 200, switched.text
        assert after["github"]["enabled"] is False
        # On in the sibling, which never switched it, off here.
        assert organization["github"]["workspaces_on"] == 1


class TestClearing:
    async def test_clearing_gives_up_the_organizations_say(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": True, "locked": True},
        )
        cleared = await _call(harness, admin, "DELETE", f"{ORGANIZATION}/github")
        again = await _call(harness, admin, "DELETE", f"{ORGANIZATION}/github")
        listed = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))
        organization = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))

        assert cleared.status_code == 200, cleared.text
        assert again.status_code == 404
        # Back to the workspace's default: off, in a workspace made since
        # services started off.
        assert listed["github"]["enabled"] is False
        assert listed["github"]["organization_locked"] is False
        assert organization["github"]["setting"] is None
        events = await _events(session_factory)
        assert [event.action for event in events] == [
            OrganizationAuditAction.SERVICE_SET,
            OrganizationAuditAction.SERVICE_CLEARED,
        ]
        assert events[-1].details == {
            "service": "github",
            "previous": {"enabled": True, "locked": True},
        }


async def _connected_in(session_factory, user: User, tenant_id: str) -> None:
    async with tenant_session(session_factory, tenant_id) as session:
        await STORE.save_connection(
            session,
            user_id=user.id,
            service="github",
            consent="write",
            granted_scopes=[],
            account_id=f"account-{tenant_id}",
            external_identity=user.name,
            encrypted_secret=TEST_KEYRING.encrypt("{}"),
            oauth_client_id=None,
        )
        await session.commit()


class TestWithdrawingSafely:
    async def test_nothing_is_saved_when_a_workspace_cannot_be_prepared(
        self, harness: Harness, session_factory, monkeypatch
    ) -> None:
        admin = await _org_admin(session_factory)
        broker: ServiceBroker = harness.gateway_app.state.service_broker
        queue = broker.queue_revocation

        async def failing_in_the_sibling(session, *conditions):
            if require_tenant_id() == SIBLING:
                raise RuntimeError("the database went away")
            await queue(session, *conditions)

        monkeypatch.setattr(broker, "queue_revocation", failing_in_the_sibling)
        answer = await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": False, "locked": True},
        )
        organization = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))

        assert answer.status_code == 503
        assert "nothing was changed" in answer.json()["detail"]
        assert organization["github"]["setting"] is None
        assert await _events(session_factory) == []

    async def test_a_workspace_failing_afterwards_is_named_and_the_rest_carry_on(
        self, harness: Harness, vendor: FakeVendor, session_factory, monkeypatch
    ) -> None:
        admin = await _org_admin(session_factory)
        ada = await add_member(session_factory, "ada")
        agent_id, _ = await agent_with_key(session_factory, ada, "builder")
        github = await _granted(session_factory, ada, agent_id, "github")
        async with session_factory() as session:
            session.add(_issuance(github, ada.id, "github", "ghs_here"))
            await session.commit()
        broker: ServiceBroker = harness.gateway_app.state.service_broker
        revoke = broker.revoke_withdrawn

        async def failing_in_the_sibling(session, conditions):
            if require_tenant_id() == SIBLING:
                raise RuntimeError("the vendor went away")
            return await revoke(session, conditions)

        monkeypatch.setattr(broker, "revoke_withdrawn", failing_in_the_sibling)
        answer = await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": False, "locked": True},
        )

        assert answer.status_code == 200, answer.text
        assert "Sibling" in answer.json()["warning"]
        assert vendor.revoked == ["ghs_here"]
        assert answer.json()["setting"] == {"enabled": False, "locked": True}

    async def test_the_same_setting_twice_is_recorded_once(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        for _ in range(2):
            answer = await _call(
                harness,
                admin,
                "PUT",
                f"{ORGANIZATION}/github",
                {"enabled": True, "locked": True},
            )
            assert answer.status_code == 200, answer.text
        assert len(await _events(session_factory)) == 1


class TestWhatThePagesSay:
    async def test_a_person_connected_in_two_workspaces_is_one_person(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        ada = await add_member(session_factory, "ada")
        await _connected_in(session_factory, ada, TENANT_ZERO_ID)
        await _connected_in(session_factory, ada, SIBLING)
        organization = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))
        assert organization["github"]["connected_members"] == 1

    async def test_a_service_off_on_the_server_is_on_nowhere(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": True, "locked": True},
        )
        broker: ServiceBroker = harness.gateway_app.state.service_broker
        broker._disabled["github"] = "GitHub is switched off on this server."
        github = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))["github"]
        assert github["workspaces_on"] == 0
        assert github["server_switched_off"] == "GitHub is switched off on this server."

    async def test_a_locked_switch_is_credited_to_the_organization(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": True}
        )
        await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": False, "locked": True},
        )
        github = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))[
            "github"
        ]
        assert github["enabled"] is False
        assert github["updated_by_name"] == "org-admin"

    async def test_an_unlocked_setting_reaches_a_workspace_once_it_drops_its_own(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": False}
        )
        await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": True, "locked": False},
        )
        before = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))
        organization = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))
        dropped = await _call(harness, workspace_admin, "DELETE", f"{WORKSPACE}/github")
        after = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))

        assert before["github"]["enabled"] is False
        assert before["github"]["workspace_set"] is True
        assert organization["github"]["workspaces_set_own"] == 1
        assert organization["github"]["workspaces_on"] == 1
        assert dropped.status_code == 200, dropped.text
        assert dropped.json()["enabled"] is True
        assert after["github"]["enabled"] is True
        assert after["github"]["workspace_set"] is False
