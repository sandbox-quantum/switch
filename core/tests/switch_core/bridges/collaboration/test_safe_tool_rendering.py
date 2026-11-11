"""Unit tests for safe tool input and output rendering in collaboration bridges.

Verifies:
- Secrets (OpenAI, GitHub, AWS, DB URIs, Bearer tokens, etc.) are masked.
- Custom secrets list is supported and redacted.
- Large output is truncated with an explicit omission notice.
- `show_tool_details=False` suppresses tool detail disclosure.
"""

from __future__ import annotations

import json
from typing import Literal

from switch_core.bridges.collaboration.session.renderers import Markup
from switch_core.bridges.collaboration.session.renderers.neutral import (
    activity_log,
    render_tool_detail,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    render_activity,
    render_activity_plan,
    render_activity_stream,
    render_activity_text,
)
from switch_core.sessions.contract import Item, TurnUpsert


def dummy_escape(text: str) -> str:
    return text


def _make_turn(
    turn_id: str = "turn_123",
    status: Literal["queued", "running", "completed", "interrupted", "error"] = "running",
) -> TurnUpsert:
    return TurnUpsert(
        type="turn.upsert",
        turn_id=turn_id,
        command_id="cmd_123",
        status=status,
    )


def _make_item(
    item_id: str,
    turn_id: str = "turn_123",
    kind: Literal["user-message", "assistant-message", "tool-activity"] = "tool-activity",
    status: Literal["in-progress", "completed", "failed", "declined"] = "completed",
    title: str = "tool",
    text: str = "",
) -> Item:
    return Item(
        item_id=item_id,
        turn_id=turn_id,
        revision=1,
        kind=kind,
        status=status,
        title=title,
        text=text,
        attachments=[],
        origin=None,
    )


def test_slack_render_activity_redacts_api_keys_and_passwords() -> None:
    turn = _make_turn(status="completed")
    secret_key = "sk-" + "proj-abc123def456ghi789jkl012mno345pqr678stu901vwx"
    db_uri = "postgres://admin:SuperSecretPass123!@db.internal.net:5432/prod"
    raw_output = f"Executed query with key={secret_key} on {db_uri}."

    tool_item = _make_item(
        item_id="item_tool_1",
        turn_id=turn.turn_id,
        title="db_query",
        text=raw_output,
    )

    msg = render_activity([tool_item], turn)
    rendered_json = json.dumps(msg.blocks)

    # Assert secret values are NOT leaked in blocks
    assert secret_key not in rendered_json
    assert "SuperSecretPass123!" not in rendered_json

    # Assert redaction placeholders ARE present
    assert "[REDACTED: API KEY]" in rendered_json
    assert "[REDACTED: PASSWORD]" in rendered_json
    assert (
        "postgres://admin:[REDACTED: PASSWORD]@db.internal.net:5432/prod"
        in rendered_json
    )


def test_slack_render_activity_plan_redacts_secrets() -> None:
    turn = _make_turn(status="running")
    gh_token = "ghp_" + "123456789012345678901234567890123456"
    raw_output = f"Cloning repo using token: {gh_token}"

    tool_item = _make_item(
        item_id="item_tool_2",
        turn_id=turn.turn_id,
        status="in-progress",
        title="git_clone",
        text=raw_output,
    )

    msg = render_activity_plan([tool_item], turn)
    rendered_json = json.dumps(msg.blocks)

    assert gh_token not in rendered_json
    assert "[REDACTED: GITHUB TOKEN]" in rendered_json


def test_slack_render_activity_stream_redacts_secrets() -> None:
    turn = _make_turn(status="running")
    aws_key = "AKIA" + "IOSFODNN7EXAMPLE"
    raw_output = f"Deploying to S3 with access key: {aws_key}"

    tool_item = _make_item(
        item_id="item_tool_3",
        turn_id=turn.turn_id,
        title="aws_s3_sync",
        text=raw_output,
    )

    streamed = render_activity_stream([tool_item], turn)
    rendered_json = json.dumps(streamed.blocks)

    assert aws_key not in rendered_json
    assert "[REDACTED: AWS KEY]" in rendered_json


def test_slack_render_activity_respects_show_tool_details_false() -> None:
    turn = _make_turn(status="completed")
    tool_item = _make_item(
        item_id="item_tool_4",
        turn_id=turn.turn_id,
        title="bash_exec",
        text="rm -rf /tmp/cache && echo done",
    )

    # When show_tool_details is False
    msg_hidden = render_activity([tool_item], turn, show_tool_details=False)
    plan_block = next(b for b in msg_hidden.blocks if b.get("type") == "plan")
    task_card = plan_block["tasks"][0]
    assert "details" not in task_card

    # When show_tool_details is True
    msg_shown = render_activity([tool_item], turn, show_tool_details=True)
    plan_block_shown = next(b for b in msg_shown.blocks if b.get("type") == "plan")
    task_card_shown = plan_block_shown["tasks"][0]
    assert "details" in task_card_shown
    assert (
        "rm -rf /tmp/cache"
        in task_card_shown["details"]["elements"][0]["elements"][0]["text"]
    )


def test_slack_custom_secrets_redaction() -> None:
    turn = _make_turn(status="completed")
    custom_secret = "ACME-INTERNAL-MASTER-KEY-999"
    tool_item = _make_item(
        item_id="item_tool_5",
        turn_id=turn.turn_id,
        title="vault_read",
        text=f"Fetched secret: {custom_secret}",
    )

    msg = render_activity(
        [tool_item],
        turn,
        custom_secrets=[custom_secret],
    )
    rendered_json = json.dumps(msg.blocks)
    assert custom_secret not in rendered_json
    assert "[REDACTED]" in rendered_json


def test_slack_render_activity_text_redacts_secrets() -> None:
    turn = _make_turn(status="completed")
    secret = "sk-ant-" + "api03-abcdef123456789012345678901234567890"
    tool_item = _make_item(
        item_id="item_tool_6",
        turn_id=turn.turn_id,
        title="anthropic_call",
        text=f"Sent payload with key {secret}",
    )

    text = render_activity_text([tool_item], turn)
    assert secret not in text
    assert "[REDACTED: API KEY]" in text


def test_neutral_activity_log_redacts_secrets() -> None:
    turn = _make_turn(status="completed")
    secret_jwt = (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ."
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    )
    tool_item = _make_item(
        item_id="item_tool_7",
        turn_id=turn.turn_id,
        title="curl_auth",
        text=f"Authorization: Bearer {secret_jwt}",
    )

    log = activity_log(
        [tool_item],
        turn,
        escape=dummy_escape,
        limit=2000,
        markup=Markup(),
        elapsed_seconds=None,
        heading=True,
    )

    assert secret_jwt not in log
    assert "[REDACTED: JWT]" in log


def test_neutral_activity_log_suppresses_details_when_disabled() -> None:
    turn = _make_turn(status="completed")
    tool_item = _make_item(
        item_id="item_tool_8",
        turn_id=turn.turn_id,
        title="query_analytics",
        text="SELECT user_id, email FROM users WHERE active = true",
    )

    log_hidden = activity_log(
        [tool_item],
        turn,
        escape=dummy_escape,
        limit=2000,
        markup=Markup(),
        elapsed_seconds=None,
        heading=False,
        show_tool_details=False,
    )
    assert "SELECT user_id" not in log_hidden
    assert "query_analytics" in log_hidden

    log_shown = activity_log(
        [tool_item],
        turn,
        escape=dummy_escape,
        limit=2000,
        markup=Markup(),
        elapsed_seconds=None,
        heading=False,
        show_tool_details=True,
    )
    assert "SELECT user_id" in log_shown


def test_neutral_render_tool_detail_redaction_and_truncation() -> None:
    secret = "sk-1234567890abcdef1234567890abcdef12"
    long_content = "X" * 3000 + f" with secret: {secret}"

    tool_item = _make_item(
        item_id="item_tool_9",
        turn_id="turn_abc",
        title="large_download",
        text=long_content,
    )

    rendered = render_tool_detail(
        tool_item,
        escape=dummy_escape,
        limit=500,
    )

    assert secret not in rendered
    assert "[truncated:" in rendered
    assert len(rendered) <= 600  # header + truncated content
