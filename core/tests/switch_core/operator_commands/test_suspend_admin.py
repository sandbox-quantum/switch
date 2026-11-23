"""`switch-suspend`, as an operator runs it: from its argument parser through
`_run`, against this test's database as the restricted role a deployment
connects as. What a suspension does is covered by `accounts/test_suspension.py`;
this checks the command's wiring, what it prints and the status it exits
with."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import select

from switch_core import suspension_admin
from switch_core.config import SwitchConfig
from switch_core.db.audit import PLATFORM_OPERATOR_COMMAND
from switch_core.db.models import TENANT_ZERO_ID, Agent, ServerAuditEvent, User
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.operator_commands.helpers import command_config
from tests.switch_core.operator_commands.test_entry_points import (
    _member_of_tenant_zero,
)

pytestmark = pytest.mark.no_ambient_tenant


async def _suspend(config: SwitchConfig, *argv: str) -> int:
    return await suspension_admin._run(
        config, suspension_admin._parser().parse_args(argv)
    )


async def _server_events(rls_harness: RLSHarness) -> list[tuple[str, dict]]:
    async with rls_harness.owner() as session:
        return [
            (event.action, event.details)
            for event in await session.scalars(
                select(ServerAuditEvent).order_by(ServerAuditEvent.occurred_at)
            )
        ]


async def test_suspending_and_lifting_an_account(
    rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
) -> None:
    owner = await _member_of_tenant_zero(
        rls_harness, "owner", "member", owns_an_agent=True
    )
    config = command_config(rls_harness)

    status = await _suspend(config, "user", owner.email, "--reason", "Abuse report")

    assert status == 0
    report = json.loads(capsys.readouterr().out)
    assert report["user_id"] == owner.id and report["suspended"] is True
    assert len(report["agents"][TENANT_ZERO_ID]) == 1
    with tenant_scope(TENANT_ZERO_ID):
        async with rls_harness.owner() as session:
            user = await session.get(User, owner.id)
            agent = await session.scalar(
                select(Agent).where(Agent.owner_id == owner.id)
            )
    assert user is not None and user.suspended_by_role == "operator"
    assert agent is not None and agent.suspended_with_owner

    status = await _suspend(config, "show", owner.email)

    assert status == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["reason"] == "Abuse report" and shown["by_role"] == "operator"

    status = await _suspend(config, "user", owner.email, "--lift")

    assert status == 0
    assert json.loads(capsys.readouterr().out)["suspended"] is False
    events = await _server_events(rls_harness)
    assert [action for action, _ in events] == ["user.suspended", "user.unsuspended"]
    assert all(details[PLATFORM_OPERATOR_COMMAND] is True for _, details in events)


async def test_an_unknown_account_is_refused(
    rls_harness: RLSHarness, capsys: pytest.CaptureFixture[str]
) -> None:
    status = await _suspend(
        command_config(rls_harness),
        "user",
        "nobody@example.invalid",
        "--reason",
        "Abuse report",
    )

    assert status == 1
    assert capsys.readouterr().err == (
        "Refused: No account has the email nobody@example.invalid.\n"
    )
    assert await _server_events(rls_harness) == []
