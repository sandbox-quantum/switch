"""Provider defaults apply only to new agents and preserve explicit approval
choices; a bypass default still waits for the owner, as any bypass does."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent.operations import agent_management


@pytest.mark.parametrize(
    ("provider", "settings", "expected", "held"),
    [
        ("cursor", {}, (False, True), True),
        ("cursor", {"auto_approve": False}, (False, False), False),
        ("cursor", {"auto_mode": False}, (False, False), False),
        ("claude", {}, (True, False), False),
    ],
)
async def test_new_agent_permission_defaults(
    monkeypatch, provider, settings, expected, held
):
    create = AsyncMock(return_value={})
    hold = AsyncMock(return_value={"status": "awaiting_confirmation"})
    placement = SimpleNamespace(workspaces_dir=None, machine_id="laptop")
    monkeypatch.setattr(
        agent_management,
        "permitted_to_manage",
        AsyncMock(
            return_value=SimpleNamespace(
                tenant_id="workspace", owner=SimpleNamespace(id="owner")
            )
        ),
    )
    monkeypatch.setattr(
        agent_management,
        "_management",
        lambda: SimpleNamespace(
            create_agent=create, check_new_agent=AsyncMock(return_value=placement)
        ),
    )
    monkeypatch.setattr(agent_management, "get_protocol", lambda: None)
    monkeypatch.setattr(agent_management, "get_agent_id", lambda: "asker")
    monkeypatch.setattr(
        agent_management, "require_connected_room", AsyncMock(return_value="room")
    )
    monkeypatch.setattr(agent_management, "hold_new_agent", hold)
    monkeypatch.setattr(agent_management, "record_new_agent_by_agent", AsyncMock())
    await agent_management.create_agent(
        name="helper",
        description="Help",
        machine="laptop",
        provider=provider,
        **settings,
    )
    if held:
        create.assert_not_awaited()
        spec = hold.await_args.kwargs["spec"]
        assert hold.await_args.kwargs["confirming"] == ("auto_approve",)
    else:
        hold.assert_not_awaited()
        spec = create.await_args.args[2]
    assert (spec.auto_mode, spec.auto_approve) == expected
