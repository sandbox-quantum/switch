"""An organization's switch per service, for every workspace in it, through
the real gateway on Postgres.

Locked, it is out of every workspace admin's reach; unlocked, it is the
default each workspace may override; cleared, the organization has no say.
Where a change leaves a service off, what it was issued is withdrawn in each
workspace, as a workspace admin's switch does.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import cast

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.app_credentials import ConnectorApps
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    organization_locked,
)
from switch_core.connections.maintenance import maintain_once
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    ServiceConnection,
    Tenant,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_service_store import (
    OrganizationServiceStore,
    hold_setting,
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
    async def test_a_workspace_admin_is_refused(self, harness: Harness) -> None:
        ws_admin = await _person(
            harness.session_factory, "ws-admin", member_role="admin"
        )
        answers = [
            await _call(harness, ws_admin, "GET", ORGANIZATION),
            await _call(
                harness,
                ws_admin,
                "PUT",
                f"{ORGANIZATION}/github",
                {"enabled": False, "locked": True},
            ),
            await _call(harness, ws_admin, "DELETE", f"{ORGANIZATION}/github"),
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
        catalogue = await _call(harness, ada, "GET", "/gateway/service-connections")

        assert locked.status_code == 200, locked.text
        assert locked.json()["warning"] is None
        # A member's own catalogue says it is off, and whose say that is.
        assert catalogue.status_code == 200, catalogue.text
        [github_mine] = [
            entry
            for entry in catalogue.json()["connections"]
            if entry["slug"] == "github"
        ]
        assert (
            github_mine["workspace_enabled"],
            github_mine["organization_locked"],
            github_mine["decided_by"],
        ) == (False, True, "organization_locked")
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

    async def test_unlocking_on_withdraws_where_the_workspace_had_it_off(
        self, harness: Harness, vendor: FakeVendor, session_factory
    ) -> None:
        """Locked on overrode a workspace's own switch of off; unlocked, that
        switch is in force again, and what was issued under the lock goes."""
        admin = await _org_admin(session_factory)
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        assert (
            await _call(
                harness,
                workspace_admin,
                "PUT",
                f"{WORKSPACE}/github",
                {"enabled": False},
            )
        ).status_code == 200
        await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": True, "locked": True},
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

        unlocked = await _call(
            harness,
            admin,
            "PUT",
            f"{ORGANIZATION}/github",
            {"enabled": True, "locked": False},
        )

        assert unlocked.status_code == 200, unlocked.text
        # Off here by the workspace's own switch; on in the sibling.
        assert vendor.revoked == ["ghs_here"]


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
    async def test_a_workspace_that_cannot_be_reached_is_finished_by_the_upkeep(
        self, harness: Harness, vendor: FakeVendor, session_factory, monkeypatch
    ) -> None:
        """The setting commits first: a workspace whose tokens could not be
        queued is named, and the next upkeep pass queues and revokes them."""
        admin = await _org_admin(session_factory)
        ada = await add_member(session_factory, "ada")
        async with tenant_session(session_factory, SIBLING) as session:
            session.add(
                _issuance(None, ada.id, "github", "ghs_elsewhere", tenant_id=SIBLING)
            )
            await session.commit()
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

        assert answer.status_code == 200, answer.text
        assert "Sibling" in answer.json()["warning"]
        assert organization["github"]["setting"] == {"enabled": False, "locked": True}
        assert len(await _events(session_factory)) == 1
        assert vendor.revoked == []

        monkeypatch.undo()
        await maintain_once(session_factory, broker, prune=False)

        assert vendor.revoked == ["ghs_elsewhere"]

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
    async def test_each_service_comes_with_what_its_card_shows(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        github = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))["github"]
        assert (github["category"], github["description"]) == (
            "Source control",
            "Clone, branch, push and open pull requests in the repository you grant.",
        )

    async def test_a_person_connected_in_two_workspaces_is_one_person(
        self, harness: Harness, session_factory
    ) -> None:
        admin = await _org_admin(session_factory)
        ada = await add_member(session_factory, "ada")
        await _connected_in(session_factory, ada, TENANT_ZERO_ID)
        await _connected_in(session_factory, ada, SIBLING)
        organization = _by_slug(await _call(harness, admin, "GET", ORGANIZATION))
        assert organization["github"]["connected_members"] == 1

    async def test_a_connection_that_needs_reconnecting_is_not_counted(
        self, harness: Harness, vendor: FakeVendor, session_factory
    ) -> None:
        """Counted as the workspace page counts: one made through an app since
        replaced reaches nothing until reconnected."""
        admin = await _org_admin(session_factory)
        ada = await add_member(session_factory, "ada")
        bob = await add_member(session_factory, "bob")
        await _connected_in(session_factory, ada, TENANT_ZERO_ID)
        await _connected_in(session_factory, bob, SIBLING)
        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            await session.execute(
                update(ServiceConnection)
                .where(ServiceConnection.user_id == ada.id)
                .values(oauth_client_id="old-client")
            )
            await session.commit()
        vendor.client_id = "new-client"
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


class TestTheWorkspacesList:
    """What the workspace's own list says of its organization's say: which
    setting decides each service, who made it, and what may change here."""

    async def test_names_the_organization(
        self, harness: Harness, session_factory
    ) -> None:
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        async with session_factory() as session:
            name = await session.scalar(
                select(Organization.name).where(Organization.id == TENANT_ZERO_ID)
            )
        assert name is not None
        listed = await _call(harness, workspace_admin, "GET", WORKSPACE)
        assert listed.json()["organization_name"] == name

    async def test_an_unlocked_default_is_named_and_credited_to_the_organization(
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
            {"enabled": True, "locked": False},
        )
        github = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))[
            "github"
        ]
        assert {
            key: github[key]
            for key in (
                "enabled",
                "decided_by",
                "organization_default",
                "updated_by_name",
                "can_change",
            )
        } == {
            "enabled": True,
            "decided_by": "organization_default",
            "organization_default": True,
            "updated_by_name": "org-admin",
            "can_change": True,
        }
        assert github["updated_at"] is not None

    async def test_the_workspaces_own_choice_keeps_the_default_to_go_back_to(
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
            {"enabled": True, "locked": False},
        )
        await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": False}
        )
        github = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))[
            "github"
        ]
        assert (
            github["enabled"],
            github["decided_by"],
            github["organization_default"],
            github["updated_by_name"],
        ) == (False, "workspace", True, "workspace-admin")

    async def test_locked_may_be_changed_here_by_nobody(
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
        for caller in (workspace_admin, admin):
            listed = await _call(harness, caller, "GET", WORKSPACE)
            github = _by_slug(listed)["github"]
            assert listed.json()["can_change"] is True
            assert (
                github["decided_by"],
                github["organization_default"],
                github["can_change"],
            ) == ("organization_locked", None, False)
            switched = await _call(
                harness, caller, "PUT", f"{WORKSPACE}/github", {"enabled": False}
            )
            assert switched.status_code == 409, switched.text

    async def test_clearing_the_workspaces_own_is_refused_while_locked(
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
        cleared = await _call(harness, workspace_admin, "DELETE", f"{WORKSPACE}/github")
        github = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))[
            "github"
        ]

        assert cleared.status_code == 409, cleared.text
        assert cleared.json()["detail"] == organization_locked("GitHub", enabled=False)
        # Kept for when the organization unlocks it.
        assert github["workspace_set"] is True

    async def test_clearing_what_the_workspace_never_set_is_not_found_locked_or_not(
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
            {"enabled": False, "locked": True},
        )
        cleared = await _call(harness, workspace_admin, "DELETE", f"{WORKSPACE}/github")
        assert cleared.status_code == 404, cleared.text
        assert cleared.json()["detail"] == (
            "This workspace has no switch of its own for GitHub."
        )

    @pytest.mark.parametrize(
        ("method", "body"), [("PUT", {"enabled": False}), ("DELETE", None)]
    )
    async def test_a_lock_made_while_a_switch_is_under_way_is_the_one_it_meets(
        self, harness: Harness, session_factory, method: str, body
    ) -> None:
        """The organization locking it waits for no read: the switch waits
        for the organization, and then meets its lock."""
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        org_admin = await _person(session_factory, "org-admin", member_role=None)
        await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": True}
        )
        async with session_factory() as locking:
            await hold_setting(locking, TENANT_ZERO_ID, "github")
            switching = asyncio.create_task(
                _call(harness, workspace_admin, method, f"{WORKSPACE}/github", body)
            )
            await asyncio.sleep(0.5)
            assert not switching.done()
            await OrganizationServiceStore().set(
                locking,
                TENANT_ZERO_ID,
                "github",
                enabled=True,
                locked=True,
                updated_by=org_admin.id,
            )
            await locking.commit()
        answered = await asyncio.wait_for(switching, timeout=10)
        github = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))[
            "github"
        ]

        assert answered.status_code == 409, answered.text
        assert (github["workspace_set"], github["decided_by"]) == (
            True,
            "organization_locked",
        )

    async def test_a_service_off_on_the_server_says_so_whatever_its_switch(
        self, harness: Harness, session_factory
    ) -> None:
        workspace_admin = await _person(
            session_factory, "workspace-admin", member_role="admin"
        )
        await _call(
            harness, workspace_admin, "PUT", f"{WORKSPACE}/github", {"enabled": True}
        )
        broker: ServiceBroker = harness.gateway_app.state.service_broker
        broker._disabled["github"] = "GitHub is switched off on this server."
        github = _by_slug(await _call(harness, workspace_admin, "GET", WORKSPACE))[
            "github"
        ]
        assert (
            github["enabled"],
            github["unavailable_code"],
            github["unavailable_reason"],
        ) == (True, "switched_off", "GitHub is switched off on this server.")
