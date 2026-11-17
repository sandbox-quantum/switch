"""`switch-promote-org-admin`, as an operator runs it: on the restricted
role row-level security applies to, bound to nothing."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import OrganizationAuditEvent, OrganizationMember
from switch_core.db.session_scope import organization_session
from switch_core.operator_commands import CommandRefused
from switch_core.organization_admin_notices import OrganizationAdminNotices
from switch_core.promote_org_admin import plan_promotion, promote
from tests.conftest import RLSHarness
from tests.switch_core.operator_commands.helpers import (
    DASHBOARD,
    RecordingMailer,
    email_of,
    make_organization,
)

pytestmark = pytest.mark.no_ambient_tenant

REASON = "Its only admin left the company"


async def _role(
    rls_harness: RLSHarness, organization_id: str, user_id: str
) -> str | None:
    async with organization_session(rls_harness.owner, organization_id) as session:
        member = await session.get(OrganizationMember, (organization_id, user_id))
        return None if member is None else member.role


async def _events(
    rls_harness: RLSHarness, organization_id: str
) -> list[OrganizationAuditEvent]:
    async with organization_session(rls_harness.owner, organization_id) as session:
        return list(
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == organization_id
                )
            )
        )


async def test_a_member_is_made_org_admin_audited_and_the_admins_told(
    rls_harness: RLSHarness,
) -> None:
    made = await make_organization(
        rls_harness,
        people={"ada": ("admin", "org_admin"), "bob": ("member", "member")},
    )
    mailer = RecordingMailer()
    restricted = rls_harness.restricted
    bob_email = email_of(made.ids["bob"])

    promotion = await plan_promotion(restricted, made.slug, bob_email, REASON)
    await promote(
        restricted,
        OrganizationAdminNotices(restricted, mailer, DASHBOARD),
        promotion,
        REASON,
    )

    assert (
        await _role(rls_harness, made.organization_id, made.ids["bob"]) == "org_admin"
    )
    [event] = await _events(rls_harness, made.organization_id)
    assert event.action == OrganizationAuditAction.ROLE_CHANGED
    assert event.actor_user_id is None
    assert event.target_id == made.ids["bob"]
    assert event.details == {
        "from": "member",
        "to": "org_admin",
        "reason": REASON,
        "platform_access": True,
        "platform_operator_command": True,
    }
    assert sorted(email.to for email in mailer.sent) == sorted(
        [email_of(made.ids["ada"]), bob_email]
    )
    assert {email.reason for email in mailer.sent} == {REASON}
    assert {email.subject for email in mailer.sent} == {
        "Bob was made an organization admin of Acme"
    }


async def test_someone_in_none_of_its_workspaces_is_refused_and_told_to_invite(
    rls_harness: RLSHarness,
) -> None:
    made = await make_organization(
        rls_harness,
        people={"ada": ("admin", "org_admin"), "cy": (None, None)},
    )

    with pytest.raises(CommandRefused, match="Invite them"):
        await plan_promotion(
            rls_harness.restricted,
            made.organization_id,
            email_of(made.ids["cy"]),
            REASON,
        )

    assert await _role(rls_harness, made.organization_id, made.ids["cy"]) is None
    assert await _events(rls_harness, made.organization_id) == []


async def test_without_execute_nothing_changes(rls_harness: RLSHarness) -> None:
    """The plan is all a dry run makes: it reads, and writes nothing."""
    made = await make_organization(
        rls_harness,
        people={"ada": ("admin", "org_admin"), "bob": ("member", "member")},
    )

    promotion = await plan_promotion(
        rls_harness.restricted,
        made.organization_id,
        email_of(made.ids["bob"]),
        REASON,
    )

    assert promotion.current_role == "member"
    assert promotion.workspaces == ["Acme workspace"]
    assert await _role(rls_harness, made.organization_id, made.ids["bob"]) == "member"
    assert await _events(rls_harness, made.organization_id) == []


@pytest.mark.parametrize(
    ("person", "reason", "message"),
    [
        ("ada", REASON, "already an organization admin"),
        ("bob", "   ", "--reason must say why"),
    ],
)
async def test_what_it_refuses(
    rls_harness: RLSHarness, person: str, reason: str, message: str
) -> None:
    made = await make_organization(
        rls_harness,
        people={"ada": ("admin", "org_admin"), "bob": ("member", "member")},
    )

    with pytest.raises(CommandRefused, match=message):
        await plan_promotion(
            rls_harness.restricted, made.slug, email_of(made.ids[person]), reason
        )


async def test_an_unknown_organization_is_refused(rls_harness: RLSHarness) -> None:
    made = await make_organization(rls_harness, people={"bob": ("member", "member")})

    with pytest.raises(CommandRefused, match="No organization here"):
        await plan_promotion(
            rls_harness.restricted, "no-such-org", email_of(made.ids["bob"]), REASON
        )
