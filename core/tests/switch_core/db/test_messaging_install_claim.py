"""One external workspace belongs to one tenant, and the database is what says so.

Inbound events from the Switch messaging app arrive over a public endpoint
carrying a workspace id and nothing else — no tenant, no credential of ours.
`tenant_of_messaging_install` turns that workspace into a tenant, and the whole
of why it can is that `messaging_installs` makes `(platform,
external_workspace_id)` unique across the deployment. Two tenants holding the
same workspace would be an event with two possible destinations and a lookup
that refuses rather than picking; every message from that workspace would stop.

So the constraint is the routing guarantee, and it is asserted here through the
restricted role rather than through the owner, because the interesting part is
what row-level security does *not* do to it. A unique index is enforced against
rows the policy hides, which is the behaviour this needs and is easy to assume
the other way round: the second tenant cannot read the first tenant's row and
is still refused the insert.

That refusal discloses one bit — some tenant holds this workspace — to a caller
who could already name it. That is deliberate, and the alternative is worse: a
silent second claim, discovered when a customer's messages start arriving in
somebody else's rooms.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from switch_core.db.models import MessagingInstall, Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.tenant_lookup import tenant_of_messaging_install
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


class _Fixture:
    def __init__(self) -> None:
        self.tenant_a: str = ""
        self.tenant_b: str = ""
        self.user_id: str = ""
        self.workspace: str = ""


async def _two_tenants_and_a_workspace(owner: async_sessionmaker) -> _Fixture:
    fixture = _Fixture()
    suffix = uuid.uuid4().hex[:8]
    fixture.tenant_a = f"tenant-a-{suffix}"
    fixture.tenant_b = f"tenant-b-{suffix}"
    fixture.workspace = f"T-{suffix}"

    async with owner() as session:
        for tenant_id in (fixture.tenant_a, fixture.tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        user = User(name="installer", email=f"{suffix}@example.test", role="user")
        session.add(user)
        await session.flush()
        fixture.user_id = user.id
        await session.commit()
    return fixture


def _install(fixture: _Fixture, tenant_id: str) -> MessagingInstall:
    return MessagingInstall(
        tenant_id=tenant_id,
        platform="slack",
        external_workspace_id=fixture.workspace,
        encrypted_bot_token="ciphertext",
        scopes="chat:write",
        status="active",
        installed_by_user_id=fixture.user_id,
    )


async def test_a_second_tenant_cannot_claim_a_claimed_workspace(
    rls_harness: RLSHarness,
) -> None:
    fixture = await _two_tenants_and_a_workspace(rls_harness.owner)

    async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
        session.add(_install(fixture, fixture.tenant_a))
        await session.commit()

    with pytest.raises(IntegrityError) as raised:
        async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
            session.add(_install(fixture, fixture.tenant_b))
            await session.commit()
    assert "uq_messaging_installs_workspace" in str(raised.value)


async def test_the_claiming_tenant_still_cannot_see_the_row_it_collided_with(
    rls_harness: RLSHarness,
) -> None:
    """The measurement that makes the test above mean something.

    If tenant B could read tenant A's install, the constraint would be
    redundant with an ordinary application-level check. It cannot, so the
    constraint is the only thing standing between two claims on one workspace.
    """
    fixture = await _two_tenants_and_a_workspace(rls_harness.owner)

    async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
        session.add(_install(fixture, fixture.tenant_a))
        await session.commit()

    async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
        visible = (
            await session.execute(
                select(MessagingInstall.id).where(
                    MessagingInstall.external_workspace_id == fixture.workspace
                )
            )
        ).scalars()
        assert list(visible) == []


async def test_the_same_workspace_on_another_platform_is_a_separate_claim(
    rls_harness: RLSHarness,
) -> None:
    """Uniqueness is on the pair. Two platforms minting the same string is a
    coincidence, not a conflict, and refusing the second install would take a
    customer's Teams workspace away because somebody's Slack workspace shares
    an id."""
    fixture = await _two_tenants_and_a_workspace(rls_harness.owner)

    async with tenant_session(rls_harness.restricted, fixture.tenant_a) as session:
        session.add(_install(fixture, fixture.tenant_a))
        await session.commit()

    async with tenant_session(rls_harness.restricted, fixture.tenant_b) as session:
        install = _install(fixture, fixture.tenant_b)
        install.platform = "teams"
        session.add(install)
        await session.commit()

    assert (
        await tenant_of_messaging_install(
            rls_harness.restricted, "slack", fixture.workspace
        )
        == fixture.tenant_a
    )
    assert (
        await tenant_of_messaging_install(
            rls_harness.restricted, "teams", fixture.workspace
        )
        == fixture.tenant_b
    )
