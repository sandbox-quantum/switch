"""Asana's catalog contract, independent of the shared OAuth opt-ins in #1340."""

from pathlib import Path

import yaml

CATALOG_DIR = (
    Path(__file__).resolve().parents[3] / "switch_core/connections/catalog/asana"
)


def test_asana_uses_the_official_mcp_server_and_static_oauth() -> None:
    entry = yaml.safe_load((CATALOG_DIR / "connection.yaml").read_text())
    assert entry["enabled"] is True
    assert entry["adapter"] == "oauth"
    assert entry["auth"]["oauth"] == {
        "registration": "static",
        "client_settings": "ASANA",
        "redirect": ["loopback"],
        "loopback_ports": [39231],
        "revocation_discovered": True,
    }
    assert entry["mcp"]["servers"] == [
        {"name": "asana", "url": "https://mcp.asana.com/v2/mcp"}
    ]
    assert entry["auth"]["identity"] == {
        "mcp_tool": "get_user",
        "account_id": "data.gid",
        "label": "data.name",
    }


def test_asana_consent_is_unscoped_and_write_capable() -> None:
    entry = yaml.safe_load((CATALOG_DIR / "connection.yaml").read_text())
    assert entry["access"] == {
        "unscoped": True,
        "read": {"scopes": []},
        "write": {"scopes": []},
    }
    assert entry["token"] == {"kind": "pass_through", "max_lifetime": 3600}
    assert entry["tools"] == {"mode": "pass_through"}


def test_asana_skill_covers_safe_task_workflow() -> None:
    skill = (CATALOG_DIR / "skill/SKILL.md").read_text()
    for phrase in (
        "search_objects",
        "get_tasks",
        "assignee",
        "due date",
        "Confirm",
        "permissions",
        "not as",
    ):
        assert phrase in skill
