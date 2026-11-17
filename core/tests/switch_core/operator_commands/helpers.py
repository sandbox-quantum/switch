"""Fixtures the platform operator's command tests share: an organization
made through the superuser connection, a mailer that keeps what it is asked
to send, and the configuration a command reads where switch-core runs."""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass

from switch_core.config import SwitchConfig
from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.gateway.invite_mail import AdminChangeEmail, InviteEmail
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.accounts.test_account_deletion import ADMIN_EMAIL

DASHBOARD = "https://dashboard.example.invalid"


def command_config(rls_harness: RLSHarness) -> SwitchConfig:
    """What a command reads from the environment where switch-core runs,
    pointed at this test's database as its restricted role, the role a
    deployment runs as. The keys are the suite's own (`TEST_KEYRING`), so
    what the tests sealed opens."""
    url = rls_harness.restricted_engine.url
    assert url.host and url.port and url.username and url.password and url.database
    return SwitchConfig(
        db_host=url.host,
        db_port=str(url.port),
        db_user=url.username,
        db_password=url.password,
        db_name=url.database,
        id_server_name="switch.test",
        agent_registration_token=secrets.token_urlsafe(16),
        secret_keys="test:" + "column-encryption-secret" * 2,
        gateway_admin_email=ADMIN_EMAIL,
        gateway_admin_password=secrets.token_urlsafe(16),
    )


class RecordingMailer:
    def __init__(self) -> None:
        self.sent: list[AdminChangeEmail] = []

    async def send_invitation(self, invite: InviteEmail) -> None:
        raise AssertionError("no invitation is sent here")

    async def send_admin_change(self, email: AdminChangeEmail) -> None:
        self.sent.append(email)


@dataclass(frozen=True)
class Made:
    organization_id: str
    slug: str
    tenant_id: str
    # Each person's user id, by the name they were made with.
    ids: dict[str, str]


def email_of(name: str) -> str:
    return f"{name}@example.invalid"


async def make_organization(
    rls_harness: RLSHarness,
    *,
    people: dict[str, tuple[str | None, str | None]],
    name: str = "Acme",
) -> Made:
    """An organization with one workspace, and `people` (name -> (workspace
    role, organization role), None for no row of that kind)."""
    suffix = uuid.uuid4().hex[:8]
    organization_id, tenant_id = f"org-{suffix}", f"tenant-{suffix}"
    slug = f"acme-{suffix}"
    ids: dict[str, str] = {}
    with tenant_scope(tenant_id):
        async with rls_harness.owner() as session:
            session.add(Organization(id=organization_id, slug=slug, name=name))
            await session.flush()
            session.add(
                Tenant(
                    id=tenant_id,
                    slug=slug,
                    name=f"{name} workspace",
                    organization_id=organization_id,
                )
            )
            for person, (workspace_role, organization_role) in people.items():
                user = User(
                    id=f"{person}-{suffix}",
                    name=person.title(),
                    email=email_of(f"{person}-{suffix}"),
                    role="user",
                )
                session.add(user)
                await session.flush()
                ids[person] = user.id
                if workspace_role is not None:
                    session.add(
                        TenantMember(
                            tenant_id=tenant_id, user_id=user.id, role=workspace_role
                        )
                    )
                if organization_role is not None:
                    session.add(
                        OrganizationMember(
                            organization_id=organization_id,
                            user_id=user.id,
                            role=organization_role,
                        )
                    )
            await session.commit()
    return Made(organization_id, slug, tenant_id, ids)
