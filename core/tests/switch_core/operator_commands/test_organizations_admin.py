"""`switch-orgs list`, as an operator runs it: on the restricted role, bound
to nothing."""

from __future__ import annotations

import pytest

from switch_core.db.models import TENANT_ZERO_ID
from switch_core.organizations_admin import (
    WorkspaceListing,
    list_organizations,
    print_organizations,
)
from tests.conftest import RLSHarness
from tests.switch_core.operator_commands.helpers import email_of, make_organization

pytestmark = pytest.mark.no_ambient_tenant


async def test_every_organization_with_its_admins_and_workspaces(
    rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
) -> None:
    made = await make_organization(
        rls_harness,
        people={
            "ada": ("admin", "org_admin"),
            # An organization admin with no membership row is on the roster.
            "bob": (None, "org_admin"),
            "cy": ("member", "member"),
        },
    )

    listings = await list_organizations(rls_harness.restricted)

    by_id = {listing.id: listing for listing in listings}
    assert set(by_id) == {TENANT_ZERO_ID, made.organization_id}
    acme = by_id[made.organization_id]
    assert (acme.slug, acme.name) == (made.slug, "Acme")
    assert acme.admins == sorted([email_of(made.ids["ada"]), email_of(made.ids["bob"])])
    assert acme.workspaces == [
        WorkspaceListing(
            id=made.tenant_id, name="Acme workspace", people=3, archived=False
        )
    ]
    print_organizations(listings)
    printed = capsys.readouterr().out
    assert f"Acme (slug {made.slug}, id {made.organization_id})" in printed
    assert f"{made.tenant_id}  Acme workspace  (3 people)" in printed
    assert "2 organization(s)" in printed
