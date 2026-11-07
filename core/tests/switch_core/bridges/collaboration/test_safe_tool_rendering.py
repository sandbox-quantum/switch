"""Tests for tool detail rendering on Slack and neutral platforms with redaction and toggle support."""

from switch_core.bridges.collaboration.session.renderers.neutral import (
    _log_line,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    _plan_task,
)
from switch_core.db.stores.room_store import (
    tool_detail_enabled_in,
)
from switch_core.sessions.contract import Item, TurnUpsert


def _dummy_turn() -> TurnUpsert:
    return TurnUpsert.model_validate(
        {
            "type": "turn.upsert",
            "turn_id": "turn_123",
            "session_id": "sess_123",
            "room_id": "room_123",
            "agent_id": "agent_123",
            "revision": 1,
            "status": "completed",
            "input": {"prompt": "Run database check"},
            "created_at": "2026-11-07T12:00:00Z",
        }
    )


def test_slack_plan_task_redacts_secrets() -> None:
    item = Item.model_validate(
        {
            "item_id": "item_1",
            "turn_id": "turn_123",
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Query customer database",
            "text": "Connected using postgresql://app_user:db_secret_pass@db.local:5432/crm and key sk-ant-secret12345678901234567890",
            "attachments": [],
            "origin": None,
        }
    )
    task = _plan_task(item, show_tool_details=True)
    assert "details" in task
    elements = task["details"]["elements"][0]["elements"]
    detail_text = elements[0]["text"]
    assert "db_secret_pass" not in detail_text
    assert "sk-ant-secret" not in detail_text
    assert "[REDACTED: PASSWORD]" in detail_text


def test_slack_plan_task_respects_tool_detail_toggle() -> None:
    item = Item.model_validate(
        {
            "item_id": "item_2",
            "turn_id": "turn_123",
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Run build script",
            "text": "Completed successfully in 4.2s with exit code 0",
            "attachments": [],
            "origin": None,
        }
    )
    # When tool details are disabled, no details block should be rendered
    task_off = _plan_task(item, show_tool_details=False)
    assert "details" not in task_off

    # When tool details are enabled, details block is present
    task_on = _plan_task(item, show_tool_details=True)
    assert "details" in task_on


def test_neutral_log_line_redacts_secrets() -> None:
    item = Item.model_validate(
        {
            "item_id": "item_3",
            "turn_id": "turn_123",
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Fetch API config",
            "text": "Loaded GITHUB_TOKEN=ghp_123456789012345678901234567890123456 from env",
            "attachments": [],
            "origin": None,
        }
    )
    line = _log_line(item, escape=lambda s: s, show_tool_details=True)
    assert "ghp_1234567890" not in line
    assert "[REDACTED: GITHUB TOKEN]" in line


def test_neutral_log_line_respects_tool_detail_toggle() -> None:
    item = Item.model_validate(
        {
            "item_id": "item_4",
            "turn_id": "turn_123",
            "revision": 1,
            "kind": "tool-activity",
            "status": "completed",
            "title": "Execute pytest suite",
            "text": "12 tests passed in 0.45s",
            "attachments": [],
            "origin": None,
        }
    )
    line_off = _log_line(item, escape=lambda s: s, show_tool_details=False)
    assert "12 tests passed" not in line_off
    assert "Execute pytest suite" in line_off

    line_on = _log_line(item, escape=lambda s: s, show_tool_details=True)
    assert "12 tests passed" in line_on


def test_room_store_tool_detail_toggle() -> None:
    # Default is enabled (absent key)
    assert tool_detail_enabled_in(None) is True
    assert tool_detail_enabled_in({}) is True

    # Explicitly disabled
    assert tool_detail_enabled_in({"tool_detail_off": True}) is False

    # Explicitly enabled
    assert tool_detail_enabled_in({"tool_detail_off": None}) is True
