"""An organization's connector-app routes, against Postgres and fake vendors.

Only the organization's `org_admin`s reach them; a save is checked with the
vendor and stored only when the vendor accepts it; its workspaces use it at
once and the server's app no longer; and each change lands in the
organization's audit log.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG, with_access_profiles
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    TENANT_ZERO_ID,
    OrganizationAppCredential,
    OrganizationAuditEvent,
    OrganizationMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.organization_connector_apps import (
    router as organization_connector_apps_router,
)
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.fake_vendor import (
    STATIC_CLIENT_ID,
    STATIC_CLIENT_SECRET,
)
from tests.switch_core.gateway.test_connector_apps import (
    APPS,
    GOOGLE,
    PUBLIC,
    World,
    _github_body,
    _google_body,
    _tenant_id,
    _user,
)
from tests.switch_core.management.harness import cookies_for

ORGANIZATION_APPS = "/gateway/organizations/current/connector-apps"
CONNECTIONS = "/gateway/service-connections"
GOOGLE_SCOPE = "https://www.googleapis.com/auth/"


@pytest.fixture
async def world(session_factory) -> World:
    return World(session_factory, PUBLIC)


class _Recording(OrganizationApps):
    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.changes: list[tuple[str, str]] = []

    def changed(self, organization_id: str, service: str) -> None:
        self.changes.append((organization_id, service))
        super().changed(organization_id, service)


async def _install(world: World) -> _Recording:
    """The operator's routes and the organization's, with a broker that
    looks up the organization's apps."""
    apps = await world.install()
    organization_apps = _Recording(
        apps=apps, store=OrganizationAppCredentialStore(TEST_KEYRING)
    )
    server: ServiceBroker = world.harness.gateway_app.state.service_broker
    server._organization_apps = organization_apps
    world.harness.gateway_app.state.organization_apps = organization_apps
    world.harness.gateway_app.dependency_overrides[gw_deps.get_organization_store] = (
        lambda: OrganizationStore()
    )
    world.harness.gateway_app.include_router(organization_connector_apps_router)
    return organization_apps


async def _org_admin(
    session_factory: async_sessionmaker[AsyncSession], name: str
) -> User:
    user = await _user(session_factory, name)
    async with session_factory() as session:
        session.add(
            OrganizationMember(
                organization_id=TENANT_ZERO_ID, user_id=user.id, role="org_admin"
            )
        )
        await session.commit()
    return user


async def _rows(session_factory) -> list[OrganizationAppCredential]:
    async with session_factory() as session:
        return list(await session.scalars(select(OrganizationAppCredential)))


async def _audit(session_factory) -> list[OrganizationAuditEvent]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(OrganizationAuditEvent)
                .where(
                    OrganizationAuditEvent.action.like("organization.connector_app%")
                )
                .order_by(OrganizationAuditEvent.occurred_at)
            )
        )


async def _google(client, cookies: dict[str, str]) -> dict[str, object]:
    listed = await client.get(CONNECTIONS, cookies=cookies)
    assert listed.status_code == 200, listed.text
    [entry] = [
        entry for entry in listed.json()["connections"] if entry["slug"] == GOOGLE
    ]
    return entry


class TestOnlyOrgAdmins:
    async def test_workspace_admins_and_the_operator_are_refused(
        self, world: World, session_factory
    ) -> None:
        await _install(world)
        ws_admin = await _user(session_factory, "ws-admin", member_role="admin")
        operator = await _user(session_factory, "operator", role="admin")
        async with world.harness.client() as client:
            answers = [
                await call(cookies_for(someone))
                for someone in (ws_admin, operator)
                for call in (
                    lambda cookies: client.get(ORGANIZATION_APPS, cookies=cookies),
                    lambda cookies: client.put(
                        f"{ORGANIZATION_APPS}/{GOOGLE}",
                        json=_google_body(),
                        cookies=cookies,
                    ),
                    lambda cookies: client.post(
                        f"{ORGANIZATION_APPS}/{GOOGLE}/check", cookies=cookies
                    ),
                    lambda cookies: client.get(
                        f"{ORGANIZATION_APPS}/{GOOGLE}/impact",
                        params={"client_id": "x"},
                        cookies=cookies,
                    ),
                    lambda cookies: client.delete(
                        f"{ORGANIZATION_APPS}/{GOOGLE}", cookies=cookies
                    ),
                )
            ]
        assert [answer.status_code for answer in answers] == [403] * 10
        assert await _rows(session_factory) == []

    async def test_an_org_admin_reads_every_app_and_whether_the_server_has_one(
        self, world: World, session_factory
    ) -> None:
        await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        operator = await _user(session_factory, "operator", role="admin")
        async with world.harness.client() as client:
            before = await client.get(ORGANIZATION_APPS, cookies=cookies_for(admin))
            await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
            after = await client.get(ORGANIZATION_APPS, cookies=cookies_for(admin))
        assert before.status_code == 200, before.text
        assert before.json()["public_url"] == PUBLIC
        apps = {entry["slug"]: entry for entry in before.json()["apps"]}
        assert apps[GOOGLE]["source"] == "none"
        assert apps[GOOGLE]["server_app"] is False
        assert apps[GOOGLE]["redirect_uris"] == [
            f"{PUBLIC}/gateway/service-connections/{GOOGLE}/flows/callback"
        ]
        [google] = [e for e in after.json()["apps"] if e["slug"] == GOOGLE]
        assert google["source"] == "none"
        assert google["server_app"] is True

    async def test_the_scopes_listed_are_the_ones_the_server_chose(
        self, world: World, session_factory
    ) -> None:
        world.catalog = with_access_profiles(CATALOG, {GOOGLE: "drive-file"})
        await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        async with world.harness.client() as client:
            listed = await client.get(ORGANIZATION_APPS, cookies=cookies_for(admin))
        assert listed.status_code == 200, listed.text
        [google] = [e for e in listed.json()["apps"] if e["slug"] == GOOGLE]
        scopes = set(google["scopes"])
        assert f"{GOOGLE_SCOPE}drive.file" in scopes
        assert not {f"{GOOGLE_SCOPE}drive", f"{GOOGLE_SCOPE}drive.readonly"} & scopes


class TestSaving:
    async def test_a_checked_client_is_saved_audited_and_used_by_the_workspace(
        self, world: World, session_factory
    ) -> None:
        organization_apps = await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        cookies = cookies_for(admin)
        async with world.harness.client() as client:
            before = await _google(client, cookies)
            saved = await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
            )
            after = await _google(client, cookies)
        assert before["app_source"] == "server"
        assert before["configured"] is False
        assert saved.status_code == 200, saved.text
        entry = saved.json()
        assert entry["source"] == "saved"
        assert entry["client_id"] == STATIC_CLIENT_ID
        assert entry["secrets"]["client_secret"] == {
            "set": True,
            "last4": STATIC_CLIENT_SECRET[-4:],
        }
        assert entry["updated_by_name"] == "org-admin"
        assert STATIC_CLIENT_SECRET not in saved.text
        assert after["app_source"] == "organization"
        assert after["configured"] is True
        assert organization_apps.changes == [(TENANT_ZERO_ID, GOOGLE)]
        [row] = await _rows(session_factory)
        assert row.organization_id == TENANT_ZERO_ID
        [event] = await _audit(session_factory)
        assert event.action == OrganizationAuditAction.CONNECTOR_APP_SAVED
        assert event.actor_user_id == admin.id
        assert event.details == {
            "service": GOOGLE,
            "fields_changed": ["client_id", "client_secret"],
            "client_id": STATIC_CLIENT_ID,
        }

    async def test_a_refusal_stores_nothing(
        self, world: World, session_factory
    ) -> None:
        organization_apps = await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        async with world.harness.client() as client:
            answer = await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}",
                json=_google_body(client_secret="example-wrong-secret"),
                cookies=cookies_for(admin),
            )
        assert answer.status_code == 422
        assert answer.json()["field"] == "client_secret"
        assert await _rows(session_factory) == []
        assert await _audit(session_factory) == []
        assert organization_apps.changes == []

    async def test_another_client_id_needs_replace_and_keeps_none_of_the_old_secrets(
        self, world: World, session_factory
    ) -> None:
        await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        cookies = cookies_for(admin)
        async with world.harness.client() as client:
            assert (
                await client.put(
                    f"{ORGANIZATION_APPS}/{GOOGLE}",
                    json=_google_body(),
                    cookies=cookies,
                )
            ).status_code == 200
            world.google.client_id = "another-client-id"
            refused = await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}",
                json=_google_body(client_id="another-client-id"),
                cookies=cookies,
            )
            unnamed = await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}",
                json=_google_body(
                    client_id="another-client-id", client_secret=None, replace=True
                ),
                cookies=cookies,
            )
            switched = await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}",
                json=_google_body(client_id="another-client-id", replace=True),
                cookies=cookies,
            )
        assert refused.status_code == 409
        assert unnamed.status_code == 422
        assert unnamed.json()["detail"] == "Enter the client secret."
        assert switched.status_code == 200, switched.text
        [row] = await _rows(session_factory)
        assert row.client_id == "another-client-id"
        events = await _audit(session_factory)
        assert events[-1].details["previous_client_id"] == STATIC_CLIENT_ID

    async def test_the_saved_app_is_checked_again_on_request(
        self, world: World, session_factory
    ) -> None:
        await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        cookies = cookies_for(admin)
        async with world.harness.client() as client:
            nothing = await client.post(
                f"{ORGANIZATION_APPS}/{GOOGLE}/check", cookies=cookies
            )
            await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
            )
            checked = await client.post(
                f"{ORGANIZATION_APPS}/{GOOGLE}/check", cookies=cookies
            )
        assert nothing.status_code == 409
        assert checked.status_code == 200, checked.text
        assert checked.json()["ok"] is True

    async def test_a_check_keeps_what_github_says_and_follows_a_change(
        self, world: World, session_factory
    ) -> None:
        organization_apps = await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        cookies = cookies_for(admin)
        world.github.permissions = {"contents": "read", "pull_requests": "read"}

        async def github_entry(client) -> dict[str, object]:
            listed = await client.get(ORGANIZATION_APPS, cookies=cookies)
            assert listed.status_code == 200, listed.text
            [entry] = [e for e in listed.json()["apps"] if e["slug"] == "github"]
            return entry

        async with world.harness.client() as client:
            saved = await client.put(
                f"{ORGANIZATION_APPS}/github", json=_github_body(world), cookies=cookies
            )
            assert saved.status_code == 200, saved.text
            [before] = await _rows(session_factory)
            # Checked again unchanged, it stays read-only, and nothing is written.
            again = await client.post(
                f"{ORGANIZATION_APPS}/github/check", cookies=cookies
            )
            assert again.status_code == 200, again.text
            assert again.json()["ok"] is True
            [unchanged] = await _rows(session_factory)
            assert unchanged.updated_at == before.updated_at
            assert (await github_entry(client))["read_only"] is True
            assert organization_apps.changes == [(TENANT_ZERO_ID, "github")]
            assert len(await _audit(session_factory)) == 1

            # The App is given write at GitHub: the next check stores that,
            # and every process hears of it.
            world.github.permissions = {"contents": "write", "pull_requests": "write"}
            granted = await client.post(
                f"{ORGANIZATION_APPS}/github/check", cookies=cookies
            )
            assert granted.status_code == 200, granted.text
            assert (await github_entry(client))["read_only"] is False
            assert organization_apps.changes == [(TENANT_ZERO_ID, "github")] * 2

            # Permissions a save would refuse are not stored by a check.
            world.github.permissions = {"contents": "write"}
            refused = await client.post(
                f"{ORGANIZATION_APPS}/github/check", cookies=cookies
            )
            assert refused.status_code == 200, refused.text
            assert refused.json()["ok"] is False
        [row] = await _rows(session_factory)
        assert row.settings["permissions"] == {
            "contents": "write",
            "pull_requests": "write",
        }
        assert row.updated_by == admin.id
        assert organization_apps.changes == [(TENANT_ZERO_ID, "github")] * 2
        # The save, then one event for the check that stored a change.
        events = await _audit(session_factory)
        assert [event.action for event in events] == [
            OrganizationAuditAction.CONNECTOR_APP_SAVED
        ] * 2
        assert events[1].actor_user_id == admin.id
        assert events[1].details["fields_changed"] == ["permissions"]


class TestRemoving:
    async def test_removing_goes_back_to_the_servers_app(
        self, world: World, session_factory
    ) -> None:
        organization_apps = await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        operator = await _user(session_factory, "operator", role="admin")
        cookies = cookies_for(admin)
        async with world.harness.client() as client:
            await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
            await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}", json=_google_body(), cookies=cookies
            )
            during = await _google(client, cookies)
            removed = await client.delete(
                f"{ORGANIZATION_APPS}/{GOOGLE}", cookies=cookies
            )
            again = await client.delete(
                f"{ORGANIZATION_APPS}/{GOOGLE}", cookies=cookies
            )
            after = await _google(client, cookies)
        assert during["app_source"] == "organization"
        assert removed.status_code == 200, removed.text
        assert removed.json() == {
            "connected_members": 0,
            "workspaces": 0,
            "agent_grants": 0,
        }
        assert again.status_code == 404
        assert after["app_source"] == "server"
        assert after["configured"] is True
        assert await _rows(session_factory) == []
        assert organization_apps.changes == [
            (TENANT_ZERO_ID, GOOGLE),
            (TENANT_ZERO_ID, GOOGLE),
        ]
        events = await _audit(session_factory)
        assert [event.action for event in events] == [
            OrganizationAuditAction.CONNECTOR_APP_SAVED,
            OrganizationAuditAction.CONNECTOR_APP_REMOVED,
        ]
        assert events[-1].details == {"service": GOOGLE, "client_id": STATIC_CLIENT_ID}


async def _connected(session_factory, name: str, tenant: str, client_id: str) -> None:
    user = await _user(session_factory, name, tenant_id=tenant)
    async with session_factory() as session:
        tenant_id = await _tenant_id(session, tenant)
    async with tenant_session(session_factory, tenant_id) as session:
        await ServiceConnectionStore().save_connection(
            session,
            user_id=user.id,
            service=GOOGLE,
            consent="read",
            granted_scopes=[],
            account_id=f"account-{name}",
            external_identity=f"{name}@example.invalid",
            encrypted_secret=TEST_KEYRING.encrypt("{}"),
            oauth_client_id=client_id,
        )
        await session.commit()


class TestTheServersAppAlongside:
    async def test_the_server_counts_no_connection_made_through_an_organizations_app(
        self, world: World, session_factory
    ) -> None:
        await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        operator = await _user(session_factory, "operator", role="admin")
        async with world.harness.client() as client:
            await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
            world.google.client_id = "organization-client"
            saved = await client.put(
                f"{ORGANIZATION_APPS}/{GOOGLE}",
                json=_google_body(client_id="organization-client"),
                cookies=cookies_for(admin),
            )
            assert saved.status_code == 200, saved.text
            await _connected(session_factory, "ada", "default", "organization-client")
            await _connected(session_factory, "bo", "elsewhere", STATIC_CLIENT_ID)
            servers = await client.get(APPS, cookies=cookies_for(operator))
            impact = await client.get(
                f"{APPS}/{GOOGLE}/impact",
                params={"client_id": "another-client-id"},
                cookies=cookies_for(operator),
            )
            organizations = await client.get(
                ORGANIZATION_APPS, cookies=cookies_for(admin)
            )
        [server] = [a for a in servers.json()["apps"] if a["slug"] == GOOGLE]
        assert server["stale_connections"] == 0
        assert (server["connected_members"], server["workspaces"]) == (1, 1)
        assert impact.json() == {
            "connected_members": 1,
            "workspaces": 1,
            "agent_grants": 0,
        }
        [own] = [a for a in organizations.json()["apps"] if a["slug"] == GOOGLE]
        assert (own["connected_members"], own["workspaces"]) == (1, 1)

    async def test_a_server_app_switched_off_is_not_one_to_fall_back_to(
        self, world: World, session_factory
    ) -> None:
        await _install(world)
        admin = await _org_admin(session_factory, "org-admin")
        operator = await _user(session_factory, "operator", role="admin")
        broker: ServiceBroker = world.harness.gateway_app.state.service_broker
        async with world.harness.client() as client:
            await client.put(
                f"{APPS}/{GOOGLE}", json=_google_body(), cookies=cookies_for(operator)
            )
            serving = await client.get(ORGANIZATION_APPS, cookies=cookies_for(admin))
            # As DISABLED_SERVICES does: refused before any app is looked at.
            broker._disabled[GOOGLE] = "Google Workspace is switched off here."
            off = await client.get(ORGANIZATION_APPS, cookies=cookies_for(admin))

        def google(answer) -> dict:
            [entry] = [a for a in answer.json()["apps"] if a["slug"] == GOOGLE]
            return entry

        assert google(serving)["server_app"] is True
        assert google(off)["server_app"] is False
