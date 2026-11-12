"""What `switch-purge-organization` tells the operator once a purge is done:
what was done outside Switch, what is left there by hand, and what backups
still hold."""

from __future__ import annotations

import pytest

from switch_core.accounts.organization_purge import Account, PurgeOutcome, PurgePlan
from switch_core.accounts.purge_elsewhere import ElsewhereOutcome, WorkOSLeftover
from switch_core.accounts.workos_offboarding import Membership, WorkOSSteps
from switch_core.purge_organization import BACKUPS_NOTE, _print_outcome

ALICE = Account(
    id="u-alice",
    email="alice@example.test",
    identities=(("https://auth.test", "user_alice"),),
    kept_because=None,
)


def _plan() -> PurgePlan:
    return PurgePlan(
        organization_id="org-1",
        slug="acme",
        name="Acme",
        workos_organization_id="org_acme",
        customer_id=None,
        resuming=False,
        workspaces=[],
        accounts=[ALICE],
        machines=[],
        detached_machines=[],
        removed_machines=["m-1"],
        workos_users={"user_alice": "u-alice"},
        trust_sessions=["room-1", "room-2"],
        refusals=[],
    )


def test_the_receipt_lists_what_was_done_outside_and_what_backups_keep(
    capsys: pytest.CaptureFixture[str],
) -> None:
    outcome = PurgeOutcome(
        finished=True,
        deleted_accounts=[ALICE],
        revoked_sign_ins=2,
        ended_installs=["slack T1"],
    )
    elsewhere = ElsewhereOutcome(
        workos=WorkOSSteps(
            memberships=[Membership("om_1", "user_alice", "org_acme")],
            users_deleted=["user_alice"],
            organization_deleted=True,
        ),
        workos_leftover=None,
        trust_configured=True,
        trust_deleted=2,
    )

    _print_outcome(_plan(), outcome, elsewhere)

    out = capsys.readouterr().out
    assert "revoked at their vendors by this run: 2" in out
    assert "slack T1" in out
    assert "instance and disk: m-1" in out
    assert "Removed membership om_1 of user user_alice in org_acme" in out
    assert "Deleted user user_alice (alice@example.test)" in out
    assert "Deleted organization org_acme" in out
    assert "Switch Trust: 2 of 2 room session(s) deleted." in out
    assert BACKUPS_NOTE in out and "37 days" in BACKUPS_NOTE


def test_without_a_workos_key_the_receipt_says_workos_was_not_cleaned(
    capsys: pytest.CaptureFixture[str],
) -> None:
    elsewhere = ElsewhereOutcome(
        workos=None,
        workos_leftover=WorkOSLeftover(
            organization="org_acme", users=["user_alice"], memberships_only=[]
        ),
        trust_configured=False,
    )

    _print_outcome(_plan(), PurgeOutcome(finished=True), elsewhere)

    out = capsys.readouterr().out
    assert "WorkOS: NOT CLEANED" in out
    assert "user user_alice (alice@example.test)" in out
    assert "Switch Trust: not configured on this server" in out
    assert elsewhere.left_by_hand and not elsewhere.failed
