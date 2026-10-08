"""Boot's tenant-isolation check, and how far `DB_REQUIRE_RESTRICTED_ROLE=false`
may relax it.

The opt-out exists for a single-tenant deployment that has not created its
runtime role yet. The owner engine stands in for such a deployment: it is a
superuser, so the restricted-role check refuses it.
"""

from __future__ import annotations

import pytest
from sqlalchemy import insert, text

from switch_core.config import SwitchConfig
from switch_core.db.models import Tenant
from switch_core.db.runtime_role import RuntimeRoleError
from switch_core.main import _check_tenant_isolation
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


def _config(*, require_restricted_role: bool) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[call-arg]
        db_host="db",
        db_port="5432",
        db_user="postgres",
        db_name="switch",
        db_password="placeholder",  # gitleaks:allow
        id_server_name="switch.local",
        agent_registration_token="token",
        secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        gateway_admin_email="admin@example.com",
        gateway_admin_password="placeholder",  # gitleaks:allow
        db_require_restricted_role=require_restricted_role,
    )


async def test_an_unrestricted_connection_is_refused_by_default(
    rls_harness: RLSHarness,
) -> None:
    with pytest.raises(RuntimeRoleError):
        await _check_tenant_isolation(
            _config(require_restricted_role=True), rls_harness.owner_engine
        )


async def test_opting_out_is_allowed_with_one_workspace(
    rls_harness: RLSHarness,
) -> None:
    assert not await _check_tenant_isolation(
        _config(require_restricted_role=False), rls_harness.owner_engine
    )


async def test_opting_out_is_refused_once_a_second_workspace_exists(
    rls_harness: RLSHarness,
) -> None:
    async with rls_harness.owner_engine.begin() as conn:
        await conn.execute(
            insert(Tenant.__table__).values(id="tenant-two", slug="two", name="Two")
        )

    with pytest.raises(RuntimeRoleError, match="2 workspaces"):
        await _check_tenant_isolation(
            _config(require_restricted_role=False), rls_harness.owner_engine
        )


async def test_a_restricted_connection_reports_isolation(
    rls_harness: RLSHarness,
) -> None:
    assert await _check_tenant_isolation(
        _config(require_restricted_role=True), rls_harness.restricted_engine
    )


async def test_opting_out_survives_a_role_boot_could_not_grant(
    rls_harness: RLSHarness,
) -> None:
    """No DB_OWNER_USER, so boot never granted the runtime role the lookups.
    The role check names that; counting workspaces through a lookup the role
    cannot run must not turn it into a permission-denied crash."""
    role = rls_harness.restricted_engine.url.username
    async with rls_harness.owner_engine.begin() as conn:
        await conn.execute(
            text(f'REVOKE EXECUTE ON FUNCTION all_tenant_ids() FROM "{role}"')
        )

    assert not await _check_tenant_isolation(
        _config(require_restricted_role=False), rls_harness.restricted_engine
    )
