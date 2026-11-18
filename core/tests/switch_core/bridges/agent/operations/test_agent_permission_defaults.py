"""Provider defaults apply only to new agents and preserve explicit approval choices."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent.operations import agent_management


@pytest.mark.parametrize(
    ("provider", "settings", "expected"),
    [
        ("cursor", {}, (False, True)),
        ("cursor", {"auto_approve": False}, (False, False)),
        ("cursor", {"auto_mode": False}, (False, False)),
        ("claude", {}, (True, False)),
    ],
)
async def test_new_agent_permission_defaults(monkeypatch, provider, settings, expected):
    create = AsyncMock(return_value={})
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
        agent_management, "_management", lambda: SimpleNamespace(create_agent=create)
    )
    monkeypatch.setattr(agent_management, "get_protocol", lambda: None)
    await agent_management.create_agent(
        name="helper",
        description="Help",
        machine="laptop",
        provider=provider,
        **settings,
    )
    created = create.await_args.args[2]
    assert (created.auto_mode, created.auto_approve) == expected
