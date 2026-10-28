"""Golden payloads for what the Slack adapter sends to the Slack Web API.

Slack is not exercised end to end, so these pin its outbound rendering at the
boundary instead: every Web API call the adapter makes in a scenario is
recorded, in order, with its exact keyword arguments, and compared byte for
byte against a checked-in JSON file under `golden/slack/<case>.json`.

A mismatch fails with a unified diff. When a change to the rendering is
intended, regenerate the files and review the diff they produce in git:

    SWITCH_UPDATE_GOLDEN=1 uv run --project core pytest -c core/pyproject.toml \\
        core/tests/switch_core/bridges/collaboration/test_slack_outbound_golden.py

Golden files are only ever written with that variable set to `1`; a missing
file fails like a mismatch does. The fake client issues message timestamps
from a counter and uploaded bytes are recorded as base64, so nothing in a
payload depends on the clock or on the run.
"""

from __future__ import annotations

import base64
import difflib
import json
import os
from pathlib import Path
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.adapter import (
    AgentPresentation,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import OutboundAttachment
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.sessions.contract import Item, TurnUpsert

from .slack_fakes import FakeResponse

GOLDEN_DIR = Path(__file__).parent / "golden" / "slack"
UPDATE_ENV = "SWITCH_UPDATE_GOLDEN"

CHANNEL = "C0GENERAL"
DM_CHANNEL = "D0DIRECT"
THREAD_TS = "1700000000.000100"
TURN = "turn-1"

PRESENTATIONS = {
    "scout": AgentPresentation(display_name="Scout", icon_url=None),
    "reviewer": AgentPresentation(
        display_name="Reviewer <QA> & *co*",
        icon_url="https://images.example.com/reviewer.png",
    ),
    "wide-icon": AgentPresentation(
        display_name=None,
        icon_url="https://images.example.com/" + "a" * 260 + ".png",
    ),
}


class _RecordingWebClient:
    """Records every Web API call the adapter makes, in the order it makes them."""

    def __init__(self, *, upload_error: str | None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._upload_error = upload_error
        self._ts = 0

    def _record(self, method: str, kwargs: dict[str, Any]) -> None:
        self.calls.append({"method": method, "kwargs": kwargs})

    def _next_ts(self) -> str:
        self._ts += 1
        return f"1800000000.{self._ts:06d}"

    async def chat_postMessage(self, **kwargs: Any) -> FakeResponse:
        self._record("chat.postMessage", kwargs)
        return FakeResponse({"ok": True, "ts": self._next_ts()})

    async def chat_update(self, **kwargs: Any) -> FakeResponse:
        self._record("chat.update", kwargs)
        return FakeResponse({"ok": True})

    async def chat_delete(self, **kwargs: Any) -> FakeResponse:
        self._record("chat.delete", kwargs)
        return FakeResponse({"ok": True})

    async def chat_startStream(self, **kwargs: Any) -> FakeResponse:
        self._record("chat.startStream", kwargs)
        return FakeResponse({"ok": True, "ts": self._next_ts()})

    async def chat_appendStream(self, **kwargs: Any) -> FakeResponse:
        self._record("chat.appendStream", kwargs)
        return FakeResponse({"ok": True})

    async def chat_stopStream(self, **kwargs: Any) -> FakeResponse:
        self._record("chat.stopStream", kwargs)
        return FakeResponse({"ok": True})

    async def files_upload_v2(self, **kwargs: Any) -> FakeResponse:
        self._record("files.upload_v2", kwargs)
        if self._upload_error is not None:
            raise SlackApiError(
                self._upload_error, FakeResponse({"error": self._upload_error})
            )
        channel = kwargs["channel"]
        share = {channel: [{"ts": self._next_ts()}]}
        return FakeResponse({"ok": True, "files": [{"shares": {"public": share}}]})


async def _presentation(name: str) -> AgentPresentation | None:
    return PRESENTATIONS.get(name)


def _adapter(
    *, third_party_avatars: bool, upload_error: str | None
) -> tuple[SlackAdapter, _RecordingWebClient]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test-token",
            app_token="xapp-test-token",
            workspace_id="T0TEAM",
        )
    )
    adapter.set_tenant_id("tenant-1")
    adapter.set_third_party_avatars(third_party_avatars)
    adapter.set_agent_presentation_resolver(_presentation)
    client = _RecordingWebClient(upload_error=upload_error)
    adapter._web_client = client  # type: ignore[assignment]
    adapter._team_id = "T0TEAM"
    adapter._channel_type_cache[CHANNEL] = "channel"
    return adapter, client


def _jsonable(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"$bytes_base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    return value


def _assert_golden(case: str, calls: list[dict[str, Any]]) -> None:
    path = GOLDEN_DIR / f"{case}.json"
    actual = (
        json.dumps(_jsonable(calls), indent=2, sort_keys=True, ensure_ascii=False)
        + "\n"
    )
    if os.environ.get(UPDATE_ENV) == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(actual, encoding="utf-8")
        return
    regenerate = (
        f"If the change is intended, regenerate with {UPDATE_ENV}=1 and review "
        "the golden diff (see this module's docstring)."
    )
    if not path.exists():
        pytest.fail(f"No golden file {path}. {regenerate}", pytrace=False)
    expected = path.read_text(encoding="utf-8")
    if actual != expected:
        diff = "".join(
            difflib.unified_diff(
                expected.splitlines(keepends=True),
                actual.splitlines(keepends=True),
                fromfile=f"golden/slack/{case}.json",
                tofile="actual",
            )
        )
        pytest.fail(
            f"Slack outbound payloads for {case!r} differ from the golden file.\n"
            f"{diff}\n{regenerate}",
            pytrace=False,
        )


async def _relay(
    adapter: SlackAdapter,
    channel_id: str,
    sender: str,
    body: str,
    thread_root_id: str | None,
) -> str | None:
    """Send an agent's room message the way the bridge core relays one."""
    return await adapter.send_message(
        channel_id, sender, adapter.translate_outbound(body), thread_root_id
    )


def _turn(status: str) -> TurnUpsert:
    return TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": TURN, "status": status, "commandId": None}
    )


def _tool(item_id: str, title: str, status: str) -> Item:
    return Item.model_validate(
        {
            "itemId": item_id,
            "turnId": TURN,
            "revision": 1,
            "kind": "tool-activity",
            "status": status,
            "title": title,
            "text": "",
            "attachments": [],
            "origin": None,
        }
    )


async def test_agent_identity() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)

    await _relay(adapter, CHANNEL, "scout", "Generated face, display name.", None)
    await _relay(adapter, CHANNEL, "reviewer", "Own icon, marked-up name.", None)
    await _relay(adapter, CHANNEL, "wide-icon", "Icon URL over Slack's limit.", None)
    await _relay(adapter, CHANNEL, "jane", "Not an agent: lettered badge.", None)

    _assert_golden("agent_identity", client.calls)


async def test_agent_identity_without_third_party_avatars() -> None:
    adapter, client = _adapter(third_party_avatars=False, upload_error=None)

    await _relay(adapter, CHANNEL, "scout", "No generated face.", None)
    await _relay(adapter, CHANNEL, "reviewer", "Own icon kept.", None)
    await _relay(adapter, CHANNEL, "jane", "No lettered badge.", None)

    _assert_golden("agent_identity_without_third_party_avatars", client.calls)


async def test_mentions() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    adapter.prime_mention_targets({"doe.jane": "U0JANE", "app-bot": "B0BOT"})
    adapter._agent_group_ids["reviewer"] = "S0REVIEWER"

    await _relay(
        adapter,
        CHANNEL,
        "scout",
        "@doe.jane please look, cc @reviewer and @nobody. Not @app-bot.",
        None,
    )
    await _relay(
        adapter,
        CHANNEL,
        "scout",
        "Defused: @channel, @here, <!here>, [all](!channel). "
        "In code: `@doe.jane` and\n```\n@reviewer @channel\n```",
        None,
    )
    await adapter.send_message(
        CHANNEL,
        "scout",
        adapter.render_room_wide_mention("@everyone deploy starts in **5 minutes**"),
        None,
        room_wide_mention=True,
    )

    _assert_golden("mentions", client.calls)


async def test_threads() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    adapter._channel_type_cache[DM_CHANNEL] = "im"
    adapter._last_user_message_ts[DM_CHANNEL] = "1700000000.000200"

    root = await _relay(adapter, CHANNEL, "scout", "Thread root.", None)
    await _relay(adapter, CHANNEL, "scout", "Reply under a message ref.", root)
    await _relay(adapter, CHANNEL, "scout", "Reply under a bare ts.", THREAD_TS)
    await _relay(adapter, DM_CHANNEL, "scout", "DM reply, auto-threaded.", None)
    await adapter.send_message(
        DM_CHANNEL,
        "scout",
        adapter.render_room_wide_mention("@everyone not threaded"),
        None,
        room_wide_mention=True,
    )
    await adapter.admin_message(CHANNEL, "A **notice** in a thread.", root)

    _assert_golden("threads", client.calls)


async def test_markdown_to_mrkdwn() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    body = "\n".join(
        [
            "# Release **notes**",
            "## Changes",
            "* first item with **bold** and ~~struck~~ text",
            "+ second item with _italic_ and a [link](https://example.com/a)",
            "- dash item stays as written",
            "  * nested item",
            "![diagram](https://example.com/d.png)",
            "",
            "---",
            "",
            "Inline `code with **stars**` and a <tag> & ampersand.",
            "```python",
            "def f(x):",
            "    return x ** 2  # **not bold** [not](a link)",
            "```",
        ]
    )

    await _relay(adapter, CHANNEL, "scout", body, None)

    _assert_golden("markdown_to_mrkdwn", client.calls)


async def test_long_message_is_one_post() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    body = "\n".join(
        f"Line {index:03d}: " + "lorem ipsum dolor sit amet " * 3 for index in range(60)
    )
    assert len(body) > 4000

    await _relay(adapter, CHANNEL, "scout", body, None)

    _assert_golden("long_message", client.calls)


async def test_attachments() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    files = [
        OutboundAttachment(filename="a.txt", mimetype="text/plain", data=b"alpha"),
        OutboundAttachment(filename="b.csv", mimetype="text/csv", data=b"x,y\n1,2\n"),
    ]

    await adapter.send_attachment(
        CHANNEL,
        "reviewer",
        "plot.png",
        "image/png",
        b"\x89PNG-bytes",
        caption="The **plot**, @doe.jane",
        thread_root_id=f"{CHANNEL}:{THREAD_TS}",
    )
    await adapter.send_attachment(
        CHANNEL, "scout", "notes.md", "text/markdown", b"# notes", None, None
    )
    await adapter.send_attachments(
        CHANNEL, "scout", files, "Two **files**", f"{CHANNEL}:{THREAD_TS}"
    )
    await adapter.send_attachments(CHANNEL, "scout", files, None, None)

    _assert_golden("attachments", client.calls)


async def test_attachment_upload_failure() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error="upload_failed")

    await adapter.send_attachment(
        CHANNEL,
        "scout",
        "plot.png",
        "image/png",
        b"bytes",
        caption="the plot",
        thread_root_id=f"{CHANNEL}:{THREAD_TS}",
    )

    _assert_golden("attachment_upload_failure", client.calls)


async def test_status_card_and_edits() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    running = TurnActivity(
        items=[_tool("i1", "Read README.md", "completed")],
        turn=_turn("running"),
        elapsed_seconds=12.0,
        status_only=True,
        publication_token="tok-status",
        notify_external_id="U0OWNER",
    )
    completed = TurnActivity(
        items=[_tool("i1", "Read README.md", "completed")],
        turn=_turn("completed"),
        elapsed_seconds=75.0,
        status_only=True,
        publication_token="tok-status",
        notify_external_id="U0OWNER",
    )

    ref = await adapter.post_rich(CHANNEL, "scout", running, None)
    await adapter.update_rich(CHANNEL, "scout", ref, completed, None)

    _assert_golden("status_card", client.calls)


async def test_activity_plan_posted_and_edited() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    items = [
        _tool("i1", "Read README.md", "completed"),
        _tool("i2", "Run `pytest`", "in-progress"),
    ]
    running = TurnActivity(
        items=items,
        turn=_turn("running"),
        elapsed_seconds=5.0,
        publication_token="tok-plan",
        interrupt_turn_id=TURN,
    )
    completed = TurnActivity(
        items=[items[0], _tool("i2", "Run `pytest`", "completed")],
        turn=_turn("completed"),
        elapsed_seconds=42.0,
        publication_token="tok-plan",
    )

    ref = await adapter.post_rich(CHANNEL, "scout", running, None)
    await adapter.update_rich(CHANNEL, "scout", ref, completed, None)

    _assert_golden("activity_plan", client.calls)


async def test_activity_streamed_in_a_thread() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    adapter._thread_requester[(CHANNEL, THREAD_TS)] = "U0ASKER"
    thread = f"{CHANNEL}:{THREAD_TS}"
    running = TurnActivity(
        items=[_tool("i1", "Read README.md", "in-progress")],
        turn=_turn("running"),
        elapsed_seconds=3.0,
        interrupt_turn_id=TURN,
    )
    completed = TurnActivity(
        items=[_tool("i1", "Read README.md", "completed")],
        turn=_turn("completed"),
        elapsed_seconds=9.0,
    )

    ref = await adapter.post_rich(CHANNEL, "scout", running, thread)
    await adapter.update_rich(CHANNEL, "scout", ref, completed, thread)

    _assert_golden("activity_stream", client.calls)


async def test_thinking_indicator() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)
    adapter._last_thread_ts[CHANNEL] = THREAD_TS

    await adapter.send_typing(CHANNEL, "scout", True)
    await adapter.send_typing(CHANNEL, "scout", True)
    await adapter.send_typing(CHANNEL, "scout", False)

    _assert_golden("thinking_indicator", client.calls)


async def test_admin_message() -> None:
    adapter, client = _adapter(third_party_avatars=True, upload_error=None)

    await adapter.admin_message(
        CHANNEL,
        "**Agents in this room:**\n* @scout — see [docs](https://example.com/docs)",
        None,
    )
    await adapter.admin_message(
        CHANNEL, "Room renamed.", f"{CHANNEL}:{THREAD_TS}", drawn="`!undo` to revert"
    )

    _assert_golden("admin_message", client.calls)
