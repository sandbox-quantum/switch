"""Organizations' connector apps and service settings, against Postgres.

Every assertion goes through `rls_harness.restricted`, the role the policies
apply to; `owner` only arranges fixtures. The merging of secrets is shared
with the server's store and tested there
(`test_service_app_credential_store.py`).
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Organization,
    OrganizationAppCredential,
    OrganizationServiceSetting,
    Tenant,
    User,
)
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.db.stores.organization_service_store import OrganizationServiceStore
from switch_core.db.stores.service_app_credential_store import MissingSecretsError
from tests.conftest import TEST_KEYRING, RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

APPS = OrganizationAppCredentialStore(TEST_KEYRING)
SERVICES = OrganizationServiceStore()
GITHUB_SECRETS = frozenset({"client_secret", "private_key"})


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _organization(owner: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    """An organization with one workspace."""
    organization_id, tenant_id = _id("org"), _id("tenant")
    async with owner() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="O"))
        await session.flush()
        session.add(
            Tenant(
                id=tenant_id, slug=tenant_id, name="W", organization_id=organization_id
            )
        )
        await session.commit()
    return organization_id, tenant_id


async def _user(owner: async_sessionmaker[AsyncSession]) -> str:
    async with owner() as session:
        user = User(name="admin", email=f"{_id('admin')}@example.invalid", role="user")
        session.add(user)
        await session.commit()
        return user.id


async def _save(
    session: AsyncSession,
    organization_id: str,
    user_id: str,
    secrets: dict[str, str],
) -> OrganizationAppCredential:
    return await APPS.save(
        session,
        organization_id=organization_id,
        service="github",
        client_id="example-client-id",
        settings={"slug": "example-app"},
        secrets=secrets,
        secret_names=GITHUB_SECRETS,
        updated_by=user_id,
    )


class TestAppCredentials:
    async def test_saved_encrypted_and_read_back(self, rls_harness: RLSHarness) -> None:
        organization_id, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, organization_id) as s:
            await _save(
                s, organization_id, admin, {"client_secret": "a", "private_key": "k"}
            )
            await s.commit()

        async with organization_session(rls_harness.restricted, organization_id) as s:
            row = await APPS.get(s, organization_id, "github")
            assert row is not None
            assert row.encrypted_secrets.startswith(TEST_KEYRING.current_prefix())
            assert "private_key" not in row.encrypted_secrets
            assert APPS.secrets(row) == {"client_secret": "a", "private_key": "k"}
            assert row.updated_by == admin

    async def test_a_partial_save_keeps_the_other_secret(
        self, rls_harness: RLSHarness
    ) -> None:
        organization_id, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, organization_id) as s:
            await _save(
                s, organization_id, admin, {"client_secret": "a", "private_key": "k"}
            )
            await s.commit()
        async with organization_session(rls_harness.restricted, organization_id) as s:
            row = await _save(s, organization_id, admin, {"client_secret": "b"})
            await s.commit()
            assert APPS.secrets(row) == {"client_secret": "b", "private_key": "k"}

    async def test_a_first_save_needs_every_secret(
        self, rls_harness: RLSHarness
    ) -> None:
        organization_id, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, organization_id) as s:
            with pytest.raises(MissingSecretsError):
                await _save(s, organization_id, admin, {"client_secret": "a"})

    async def test_a_workspace_sees_its_own_organizations_app_only(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, tenant_a = await _organization(rls_harness.owner)
        org_b, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        for organization_id in (org_a, org_b):
            async with organization_session(
                rls_harness.restricted, organization_id
            ) as s:
                await _save(
                    s,
                    organization_id,
                    admin,
                    {"client_secret": "a", "private_key": "k"},
                )
                await s.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as s:
            assert await APPS.get(s, org_a, "github") is not None
            assert await APPS.get(s, org_b, "github") is None
            visible = await s.scalars(select(OrganizationAppCredential.organization_id))
            assert set(visible) == {org_a}

    async def test_another_organizations_app_cannot_be_written(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, _ = await _organization(rls_harness.owner)
        org_b, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, org_a) as s:
            with pytest.raises(DBAPIError):
                await _save(s, org_b, admin, {"client_secret": "a", "private_key": "k"})

    async def test_remove_returns_the_row_and_leaves_none(
        self, rls_harness: RLSHarness
    ) -> None:
        organization_id, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, organization_id) as s:
            await _save(
                s, organization_id, admin, {"client_secret": "a", "private_key": "k"}
            )
            await s.commit()
        async with organization_session(rls_harness.restricted, organization_id) as s:
            removed = await APPS.remove(s, organization_id, "github")
            await s.commit()
            assert removed is not None and removed.client_id == "example-client-id"
            assert await APPS.list_all(s, organization_id) == {}
            assert await APPS.remove(s, organization_id, "github") is None

    async def test_deleting_the_account_that_saved_it_clears_updated_by(
        self, rls_harness: RLSHarness
    ) -> None:
        organization_id, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, organization_id) as s:
            await _save(
                s, organization_id, admin, {"client_secret": "a", "private_key": "k"}
            )
            await SERVICES.set(
                s, organization_id, "github", enabled=False, locked=True, user_id=admin
            )
            await s.commit()
        async with rls_harness.owner() as s:
            await s.execute(delete(User).where(User.id == admin))
            await s.commit()

        async with organization_session(rls_harness.restricted, organization_id) as s:
            row = await APPS.get(s, organization_id, "github")
            setting = (await SERVICES.list_settings(s, organization_id))["github"]
            assert row is not None and row.updated_by is None
            assert json.loads(TEST_KEYRING.decrypt(row.encrypted_secrets))
            assert setting.updated_by is None


class TestServiceSettings:
    async def test_set_overwrites_and_clear_gives_up_the_say(
        self, rls_harness: RLSHarness
    ) -> None:
        organization_id, tenant_id = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        async with organization_session(rls_harness.restricted, organization_id) as s:
            await SERVICES.set(
                s, organization_id, "github", enabled=True, locked=False, user_id=admin
            )
            await SERVICES.set(
                s, organization_id, "github", enabled=False, locked=True, user_id=admin
            )
            await s.commit()

        async with tenant_session(rls_harness.restricted, tenant_id) as s:
            settings = await SERVICES.list_settings(s, organization_id)
            assert {
                service: (setting.enabled, setting.locked)
                for service, setting in settings.items()
            } == {"github": (False, True)}

        async with organization_session(rls_harness.restricted, organization_id) as s:
            assert await SERVICES.clear(s, organization_id, "github") is True
            assert await SERVICES.clear(s, organization_id, "github") is False
            await s.commit()
            assert await SERVICES.list_settings(s, organization_id) == {}

    async def test_a_workspace_sees_its_own_organizations_settings_only(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, tenant_a = await _organization(rls_harness.owner)
        org_b, _ = await _organization(rls_harness.owner)
        admin = await _user(rls_harness.owner)
        for organization_id in (org_a, org_b):
            async with organization_session(
                rls_harness.restricted, organization_id
            ) as s:
                await SERVICES.set(
                    s,
                    organization_id,
                    "github",
                    enabled=True,
                    locked=True,
                    user_id=admin,
                )
                await s.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as s:
            assert await SERVICES.list_settings(s, org_b) == {}
            visible = await s.scalars(
                select(OrganizationServiceSetting.organization_id)
            )
            assert set(visible) == {org_a}
