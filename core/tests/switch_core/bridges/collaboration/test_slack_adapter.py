from __future__ import annotations

import asyncio
from typing import Any

from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)


def _adapter() -> SlackAdapter:
    return SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
        )
    )


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _capture_messages(adapter: SlackAdapter) -> list[InboundMessage]:
    captured: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        captured.append(msg)

    adapter._on_message = on_message
    # Pre-cache the channel name so resolution does not need a live web client.
    adapter._channel_name_cache["C123"] = "general"
    return captured


class _FakeWebClient:
    """Captures chat_postMessage / chat_delete kwargs and returns canned ts."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self.updates: list[dict[str, Any]] = []
        # ts values actually handed back, in order — lets a test assert that
        # everything posted was also removed.
        self.issued: list[str] = []
        self._next_ts = iter(["999.9", "888.8", "777.7"])

    async def chat_postMessage(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(kwargs)
        try:
            ts = next(self._next_ts)
        except StopIteration:
            ts = "000.0"
        self.issued.append(ts)
        return {"ts": ts}

    async def chat_delete(self, **kwargs: Any) -> dict[str, bool]:
        self.deletes.append(kwargs)
        return {"ok": True}

    async def chat_update(self, **kwargs: Any) -> dict[str, bool]:
        self.updates.append(kwargs)
        return {"ok": True}


# ── Attachments ────────────────────────────────────────────────────────────


def test_fetch_downloads_image_attachment() -> None:
    adapter = _adapter()
    downloaded: list[str] = []

    async def fake_download(url: str) -> bytes:
        downloaded.append(url)
        return b"img-bytes"

    adapter._download_file = fake_download  # type: ignore[assignment]

    files = [
        {
            "id": "F1",
            "name": "cat.png",
            "mimetype": "image/png",
            "url_private_download": "https://files.slack.com/cat.png",
        }
    ]
    attachments, failures = _run(adapter._fetch_attachments(files))

    assert failures == []
    assert len(attachments) == 1
    assert attachments[0].filename == "cat.png"
    assert attachments[0].mimetype == "image/png"
    assert attachments[0].data == b"img-bytes"
    assert downloaded == ["https://files.slack.com/cat.png"]


def test_fetch_downloads_non_image_attachment() -> None:
    adapter = _adapter()
    downloaded: list[str] = []

    async def fake_download(url: str) -> bytes:
        downloaded.append(url)
        return b"# notes"

    adapter._download_file = fake_download  # type: ignore[assignment]

    files = [
        {
            "id": "F1",
            "name": "notes.md",
            "mimetype": "text/markdown",
            "url_private_download": "https://files.slack.com/notes.md",
        }
    ]
    attachments, failures = _run(adapter._fetch_attachments(files))

    # Every file type is relayed now — not just images.
    assert failures == []
    assert len(attachments) == 1
    assert attachments[0].filename == "notes.md"
    assert attachments[0].mimetype == "text/markdown"
    assert attachments[0].data == b"# notes"
    assert downloaded == ["https://files.slack.com/notes.md"]


def test_fetch_failed_download_reported_as_failure() -> None:
    adapter = _adapter()

    async def fake_download(url: str) -> bytes:
        if "bad" in url:
            raise RuntimeError("boom")
        return b"ok"

    adapter._download_file = fake_download  # type: ignore[assignment]

    files = [
        {
            "id": "bad",
            "name": "bad.png",
            "mimetype": "image/png",
            "url_private": "https://files.slack.com/bad.png",
        },
        {
            "id": "good",
            "name": "good.jpg",
            "mimetype": "image/jpeg",
            "url_private": "https://files.slack.com/good.jpg",
        },
    ]
    attachments, failures = _run(adapter._fetch_attachments(files))

    # The good file still comes through; the bad one is disclosed, not dropped.
    assert [a.filename for a in attachments] == ["good.jpg"]
    assert [f.filename for f in failures] == ["bad.png"]
    assert failures[0].reason


def test_fetch_oversize_file_reported_without_downloading() -> None:
    adapter = _adapter()
    downloaded: list[str] = []

    async def fake_download(url: str) -> bytes:
        downloaded.append(url)
        return b"x" * 100

    adapter._download_file = fake_download  # type: ignore[assignment]
    adapter.set_max_attachment_bytes(10)

    files = [
        {
            "id": "F1",
            "name": "huge.bin",
            "mimetype": "application/octet-stream",
            "size": 100,
            "url_private_download": "https://files.slack.com/huge.bin",
        }
    ]
    attachments, failures = _run(adapter._fetch_attachments(files))

    # Slack reports the size up front, so we never spend the download.
    assert attachments == []
    assert downloaded == []
    assert [f.filename for f in failures] == ["huge.bin"]
    assert failures[0].reason


def test_fetch_multiple_files_all_returned() -> None:
    adapter = _adapter()

    async def fake_download(url: str) -> bytes:
        return url.rsplit("/", 1)[-1].encode()

    adapter._download_file = fake_download  # type: ignore[assignment]

    files = [
        {
            "id": "F1",
            "name": "cat.png",
            "mimetype": "image/png",
            "url_private": "https://files.slack.com/cat.png",
        },
        {
            "id": "F2",
            "name": "notes.md",
            "mimetype": "text/markdown",
            "url_private": "https://files.slack.com/notes.md",
        },
        {
            "id": "F3",
            "name": "doc.pdf",
            "mimetype": "application/pdf",
            "url_private": "https://files.slack.com/doc.pdf",
        },
    ]
    attachments, failures = _run(adapter._fetch_attachments(files))

    assert failures == []
    assert [a.filename for a in attachments] == ["cat.png", "notes.md", "doc.pdf"]
    assert [a.data for a in attachments] == [b"cat.png", b"notes.md", b"doc.pdf"]


def test_fetch_no_files_returns_empty() -> None:
    adapter = _adapter()
    assert _run(adapter._fetch_attachments([])) == ([], [])


# ── Inbound threading ────────────────────────────────────────────────────────


def test_inbound_threaded_reply_sets_root_id() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "200.2",
        "user": "U1",
        "text": "a reply",
        "channel_type": "channel",
        "thread_ts": "100.1",
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert captured[0].root_id == "C123:100.1"
    assert captured[0].message_ref == "C123:200.2"


def test_inbound_top_level_has_no_root_id() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    # Slack sets thread_ts == ts on a thread's own root; treat it as top-level.
    event = {
        "channel": "C123",
        "ts": "100.1",
        "user": "U1",
        "text": "top level",
        "channel_type": "channel",
        "thread_ts": "100.1",
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert captured[0].root_id is None


# ── Subtype filtering ────────────────────────────────────────────────────────


def test_file_share_subtype_is_processed() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    async def fake_download(url: str) -> bytes:
        return b"img"

    adapter._download_file = fake_download  # type: ignore[assignment]

    event = {
        "channel": "C123",
        "ts": "300.3",
        "user": "U1",
        "text": "here is a file",
        "channel_type": "channel",
        "subtype": "file_share",
        "files": [
            {
                "id": "F1",
                "name": "p.png",
                "mimetype": "image/png",
                "url_private": "https://files.slack.com/p.png",
            }
        ],
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert [a.filename for a in captured[0].attachments] == ["p.png"]


def test_message_changed_subtype_is_skipped() -> None:
    adapter = _adapter()
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "400.4",
        "user": "U1",
        "text": "edited",
        "channel_type": "channel",
        "subtype": "message_changed",
    }
    _run(adapter._handle_message_event(event))

    assert captured == []


def test_third_party_bot_message_is_bridged() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "600.6",
        "text": "Triggered: container restart spike",
        "channel_type": "channel",
        "subtype": "bot_message",
        "bot_id": "BDATADOG",
        "username": "Datadog",
        "bot_profile": {"name": "Datadog"},
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert captured[0].sender_id == "BDATADOG"
    assert captured[0].sender_name == "Datadog"
    assert captured[0].content == "Triggered: container restart spike"


def test_bot_message_body_extracted_from_blocks() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "600.8",
        "text": "",
        "channel_type": "channel",
        "subtype": "bot_message",
        "bot_id": "BDATADOG",
        "username": "Datadog",
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": "Triggered: tests"},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "system.load.1 over * was > 0.0"},
            },
        ],
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert "Triggered: tests" in captured[0].content
    assert "system.load.1 over * was > 0.0" in captured[0].content


def test_bot_message_body_extracted_from_attachments() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "600.9",
        "text": "",
        "channel_type": "channel",
        "subtype": "bot_message",
        "bot_id": "BDATADOG",
        "username": "Datadog",
        "attachments": [
            {
                "title": "Triggered: tests",
                "text": "Metric value: 1.708",
                "fallback": "ignored",
            },
        ],
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert "Triggered: tests" in captured[0].content
    assert "Metric value: 1.708" in captured[0].content
    assert "ignored" not in captured[0].content


def test_attachment_title_link_becomes_slack_link() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "601.0",
        "text": "",
        "channel_type": "channel",
        "subtype": "bot_message",
        "bot_id": "BDATADOG",
        "username": "Datadog",
        "attachments": [
            {
                "title": "Warn: container restart spike",
                "title_link": "https://app.datadoghq.com/monitors/123",
                "text": "A container has restarted",
            },
        ],
    }
    _run(adapter._handle_message_event(event))

    raw = captured[0].content
    assert (
        "<https://app.datadoghq.com/monitors/123|Warn: container restart spike>" in raw
    )
    # And translate_inbound renders it as a clickable markdown link.
    rendered = adapter.translate_inbound(raw)
    assert (
        "[Warn: container restart spike](https://app.datadoghq.com/monitors/123)"
        in rendered
    )


def test_translate_inbound_converts_slack_links() -> None:
    adapter = _adapter()
    assert (
        adapter.translate_inbound("see <https://example.com|the docs> now")
        == "see [the docs](https://example.com) now"
    )
    assert (
        adapter.translate_inbound("bare <https://example.com>")
        == "bare https://example.com"
    )


def test_own_bot_message_is_skipped() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._bot_id = "BSELF"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "600.7",
        "text": "bridged echo",
        "channel_type": "channel",
        "subtype": "bot_message",
        "bot_id": "BSELF",
    }
    _run(adapter._handle_message_event(event))

    assert captured == []


# ── Outbound threading ───────────────────────────────────────────────────────


def test_send_message_threads_under_explicit_root() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    ref = _run(
        adapter.send_message(
            "C123", "agent-bot", "hi there", thread_root_id="C123:1700.5"
        )
    )

    assert len(fake.calls) == 1
    assert fake.calls[0]["thread_ts"] == "1700.5"
    assert fake.calls[0]["channel"] == "C123"
    assert ref == "C123:999.9"


def test_send_message_top_level_has_no_thread_ts() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(adapter.send_message("C123", "agent-bot", "hi", thread_root_id=None))

    assert len(fake.calls) == 1
    assert fake.calls[0]["thread_ts"] is None


# ── Thinking indicator threading ─────────────────────────────────────────────


def test_inbound_message_records_active_thread_root() -> None:
    adapter = _adapter()
    _capture_messages(adapter)

    # A top-level message anchors its own thread.
    _run(
        adapter._handle_message_event(
            {
                "channel": "C123",
                "ts": "100.1",
                "user": "U1",
                "text": "hi",
                "channel_type": "channel",
            }
        )
    )
    assert adapter._last_thread_ts["C123"] == "100.1"

    # A reply belongs to the root thread, not its own ts.
    _run(
        adapter._handle_message_event(
            {
                "channel": "C123",
                "ts": "200.2",
                "user": "U1",
                "text": "reply",
                "channel_type": "channel",
                "thread_ts": "100.1",
            }
        )
    )
    assert adapter._last_thread_ts["C123"] == "100.1"


def test_thinking_indicator_posts_in_active_thread() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]
    adapter._last_thread_ts["C123"] = "100.1"

    _run(adapter.send_typing("C123", "agent-bot", True))

    assert len(fake.calls) == 1
    assert fake.calls[0]["thread_ts"] == "100.1"
    assert fake.calls[0]["text"] == "_thinking..._"


def test_new_typing_turn_replaces_stale_indicator() -> None:
    # A second addressed turn must delete the leftover placeholder and post a
    # fresh one (in the now-current thread), never recycle the old message.
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    adapter._last_thread_ts["C123"] = "100.1"
    _run(adapter.send_typing("C123", "agent-bot", True))
    assert adapter._thinking_ts[("C123", "agent-bot")] == "999.9"

    # New turn arrives in a different thread; the old indicator is cleared.
    adapter._last_thread_ts["C123"] = "200.2"
    _run(adapter.send_typing("C123", "agent-bot", True))

    assert fake.deletes == [{"channel": "C123", "ts": "999.9"}]
    assert len(fake.calls) == 2
    assert fake.calls[1]["thread_ts"] == "200.2"
    assert adapter._thinking_ts[("C123", "agent-bot")] == "888.8"


def test_stop_typing_deletes_indicator() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    adapter._last_thread_ts["C123"] = "100.1"
    _run(adapter.send_typing("C123", "agent-bot", True))
    _run(adapter.send_typing("C123", "agent-bot", False))

    assert fake.deletes == [{"channel": "C123", "ts": "999.9"}]
    assert ("C123", "agent-bot") not in adapter._thinking_ts


def test_stop_typing_without_indicator_is_noop() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(adapter.send_typing("C123", "agent-bot", False))

    assert fake.deletes == []


# ── Runtime state (working-on-it activity) ──────────────────────────────────


def test_runtime_state_working_posts_generic_indicator() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123", "agent-bot", "working", mention_handle=None, thread_root_id=None
        )
    )

    assert len(fake.calls) == 1
    assert fake.calls[0]["text"] == "⚙️ _Working on it…_"
    assert adapter._working_msg[("C123", "agent-bot")].message_ref == "C123:999.9"


def test_runtime_state_detail_edits_message_in_place() -> None:
    # A follow-up working update with a `detail` refreshes the SAME message via
    # chat_update rather than posting a new one.
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123", "agent-bot", "working", mention_handle=None, thread_root_id=None
        )
    )
    _run(
        adapter.apply_runtime_state(
            "C123",
            "agent-bot",
            "working",
            mention_handle=None,
            thread_root_id=None,
            detail="Editing room-connection.ts",
        )
    )

    # Still exactly one posted message; the second update edited it in place.
    assert len(fake.calls) == 1
    assert len(fake.updates) == 1
    assert fake.updates[0]["ts"] == "999.9"
    assert fake.updates[0]["text"] == "⚙️ Editing room-connection.ts"
    # The tracked ref is unchanged.
    assert adapter._working_msg[("C123", "agent-bot")].message_ref == "C123:999.9"


def test_runtime_state_idle_clears_working_message() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123", "agent-bot", "working", mention_handle=None, thread_root_id=None
        )
    )
    _run(
        adapter.apply_runtime_state(
            "C123", "agent-bot", "idle", mention_handle=None, thread_root_id=None
        )
    )

    assert fake.deletes == [{"channel": "C123", "ts": "999.9"}]
    assert ("C123", "agent-bot") not in adapter._working_msg


# ── Runtime state (following the latest message) ────────────────────────────


def test_reposition_reposts_indicator_below_newer_traffic() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123",
            "agent-bot",
            "working",
            mention_handle=None,
            thread_root_id=None,
            detail="Editing adapter.py",
        )
    )
    _run(adapter.reposition_runtime_state("C123", "agent-bot", None))

    # Reposted verbatim, then the original removed — never edited in place.
    assert len(fake.calls) == 2
    assert fake.calls[1]["text"] == "⚙️ Editing adapter.py"
    assert fake.updates == []
    assert fake.deletes == [{"channel": "C123", "ts": "999.9"}]
    assert adapter._working_msg[("C123", "agent-bot")].message_ref == "C123:888.8"


def test_reposition_stays_in_the_thread_when_the_message_is_in_it() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123",
            "agent-bot",
            "working",
            mention_handle=None,
            thread_root_id="C123:111.1",
        )
    )
    _run(adapter.reposition_runtime_state("C123", "agent-bot", "C123:111.1"))

    assert fake.calls[1]["thread_ts"] == "111.1"


def test_reposition_follows_the_agent_into_a_different_thread() -> None:
    # The indicator re-homes rather than being stranded in whichever thread the
    # turn happened to open in.
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123",
            "agent-bot",
            "working",
            mention_handle=None,
            thread_root_id="C123:111.1",
        )
    )
    _run(adapter.reposition_runtime_state("C123", "agent-bot", "C123:222.2"))

    assert fake.calls[1]["thread_ts"] == "222.2"
    assert adapter._working_msg[("C123", "agent-bot")].thread_root_id == "C123:222.2"


def test_reposition_follows_the_agent_back_out_to_the_channel_root() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123",
            "agent-bot",
            "working",
            mention_handle=None,
            thread_root_id="C123:111.1",
        )
    )
    _run(adapter.reposition_runtime_state("C123", "agent-bot", None))

    assert fake.calls[1]["thread_ts"] is None
    assert adapter._working_msg[("C123", "agent-bot")].thread_root_id is None


def test_reposition_is_a_noop_without_a_live_indicator() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(adapter.reposition_runtime_state("C123", "agent-bot", None))

    assert fake.calls == []
    assert fake.deletes == []


def test_a_turn_ending_during_a_move_clears_what_the_move_left() -> None:
    # A move and the end-of-turn clear cannot interleave: both run under the
    # agent's runtime lock, so the clear sees the moved indicator rather than
    # the message the move already deleted. Nothing is left in the channel.
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    async def scenario() -> None:
        await adapter.apply_runtime_state(
            "C123", "agent-bot", "working", mention_handle=None, thread_root_id=None
        )
        await asyncio.gather(
            adapter.reposition_runtime_state("C123", "agent-bot", None),
            adapter.apply_runtime_state(
                "C123", "agent-bot", "idle", mention_handle=None, thread_root_id=None
            ),
        )

    _run(scenario())

    # Every message the adapter posted was deleted again — whichever order the
    # two ran in, the channel ends up empty and nothing is left tracked.
    assert set(fake.issued) == {d["ts"] for d in fake.deletes}
    assert ("C123", "agent-bot") not in adapter._working_msg


def test_reposition_leaves_the_original_when_the_repost_fails() -> None:
    # A move must never end with no indicator at all: if the replacement cannot
    # be posted, the original stays where it is rather than being deleted.
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    _run(
        adapter.apply_runtime_state(
            "C123", "agent-bot", "working", mention_handle=None, thread_root_id=None
        )
    )

    async def failing_send(*_args: Any, **_kwargs: Any) -> None:
        return None

    adapter.send_message = failing_send  # type: ignore[method-assign]
    _run(adapter.reposition_runtime_state("C123", "agent-bot", None))

    assert fake.deletes == []
    assert adapter._working_msg[("C123", "agent-bot")].message_ref == "C123:999.9"


# ── Self-mention (tagging the app) ───────────────────────────────────────────


def test_self_mention_token_set_when_bot_tagged() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "500.5",
        "user": "U1",
        "text": "hey <@UBOT> can you help",
        "channel_type": "channel",
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert captured[0].self_mention_token == "UBOT"


def test_self_mention_token_none_when_bot_not_tagged() -> None:
    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    captured = _capture_messages(adapter)

    event = {
        "channel": "C123",
        "ts": "500.5",
        "user": "U1",
        "text": "hey <@U999> can you help",
        "channel_type": "channel",
    }
    _run(adapter._handle_message_event(event))

    assert len(captured) == 1
    assert captured[0].self_mention_token is None


def test_admin_message_posts_as_app_in_thread() -> None:
    adapter = _adapter()
    fake = _FakeWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    ref = _run(adapter.admin_message("C123", "use !set-alias", "C123:500.5"))

    assert ref == "C123:999.9"
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call["channel"] == "C123"
    assert call["text"] == "use !set-alias"
    assert call["thread_ts"] == "500.5"
    # Posted as the app itself — no per-agent username/icon override.
    assert "username" not in call
    assert "icon_url" not in call


# ── Outbound mention resolution ──────────────────────────────────────────────


def test_outbound_mention_resolves_to_slack_user() -> None:
    adapter = _adapter()
    adapter._username_to_id["doe.jane"] = "U123"

    assert adapter.translate_outbound("@doe.jane here you go") == "<@U123> here you go"


def test_outbound_unknown_mention_left_as_plain_text() -> None:
    adapter = _adapter()
    assert adapter.translate_outbound("@nobody hello") == "@nobody hello"


# ── DM channel provisioning ──────────────────────────────────────────────────


class _FakeDMWebClient:
    """Records conversations_create / conversations_invite kwargs."""

    def __init__(self, invite_error: str | None = None) -> None:
        self.creates: list[dict[str, Any]] = []
        self.invites: list[dict[str, Any]] = []
        self._invite_error = invite_error

    async def conversations_create(self, **kwargs: Any) -> dict[str, Any]:
        self.creates.append(kwargs)
        return {"channel": {"id": "C-DM"}}

    async def conversations_invite(self, **kwargs: Any) -> dict[str, Any]:
        self.invites.append(kwargs)
        if self._invite_error is not None:
            raise SlackApiError(
                self._invite_error, response={"error": self._invite_error}
            )
        return {"ok": True}


def test_create_dm_channel_makes_private_channel_and_invites_user() -> None:
    adapter = _adapter()
    fake = _FakeDMWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    channel_id = _run(
        adapter.create_dm_channel(
            agent_name="agent.bot",
            user_name="doe.jane",
            user_external_id="U123",
        )
    )

    assert channel_id == "C-DM"
    assert len(fake.creates) == 1
    # A private channel, named dm-<user>-<agent> with non-slug chars dashed.
    assert fake.creates[0]["is_private"] is True
    assert fake.creates[0]["name"] == "dm-doe-jane-agent-bot"
    # The single user is invited to the freshly created channel.
    assert fake.invites == [{"channel": "C-DM", "users": "U123"}]


def test_create_dm_channel_tolerates_already_in_channel() -> None:
    adapter = _adapter()
    fake = _FakeDMWebClient(invite_error="already_in_channel")
    adapter._web_client = fake  # type: ignore[assignment]

    # An "already in channel" invite is not an error — the channel still stands.
    channel_id = _run(
        adapter.create_dm_channel(agent_name="a", user_name="u", user_external_id="U1")
    )

    assert channel_id == "C-DM"


def test_create_dm_channel_raises_on_real_invite_failure() -> None:
    adapter = _adapter()
    fake = _FakeDMWebClient(invite_error="user_not_found")
    adapter._web_client = fake  # type: ignore[assignment]

    # A genuine invite failure must surface — a DM with no user is useless.
    try:
        _run(
            adapter.create_dm_channel(
                agent_name="a", user_name="u", user_external_id="Ubad"
            )
        )
        raised = False
    except SlackApiError:
        raised = True
    assert raised


# ── Slash commands ───────────────────────────────────────────────────────────


class _FakeSlashWebClient:
    """Serves users_info / conversations_info / chat_postMessage for slash."""

    def __init__(self, *, is_private: bool = False) -> None:
        self._is_private = is_private
        self.posts: list[dict[str, Any]] = []

    async def users_info(self, **kwargs: Any) -> dict[str, Any]:
        return {
            "user": {
                "name": "doe.jane",
                "profile": {"display_name": "Jane"},
            }
        }

    async def conversations_info(self, **kwargs: Any) -> dict[str, Any]:
        return {"channel": {"is_private": self._is_private}}

    async def chat_postMessage(self, **kwargs: Any) -> dict[str, str]:
        self.posts.append(kwargs)
        return {"ts": "111.1"}


def _capture_commands(adapter: SlackAdapter) -> list[InboundCommand]:
    captured: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        captured.append(cmd)

    adapter._on_command = on_command
    return captured


def test_slash_command_maps_to_in_room_command() -> None:
    adapter = _adapter()
    fake = _FakeSlashWebClient()
    adapter._web_client = fake  # type: ignore[assignment]
    commands = _capture_commands(adapter)

    _run(
        adapter._handle_slash_command(
            {
                "command": "/reset",
                "text": "@worker",
                "channel_id": "C123",
                "user_id": "U123",
            }
        )
    )

    assert len(commands) == 1
    cmd = commands[0]
    # The leading `/` is stripped so the name matches the in-room command.
    assert cmd.command == "reset"
    assert cmd.args == "@worker"
    assert cmd.channel_id == "C123"
    assert cmd.channel_type == "channel_public"
    # A visible "Running …" message is posted (as the app — no username
    # override), and the command's result is routed into ITS thread via the
    # message ref.
    assert len(fake.posts) == 1
    assert "username" not in fake.posts[0]
    assert "/reset @worker" in fake.posts[0]["text"]
    assert cmd.message_ref == "C123:111.1"


def test_slash_command_private_channel_type_resolved() -> None:
    adapter = _adapter()
    adapter._web_client = _FakeSlashWebClient(is_private=True)  # type: ignore[assignment]
    commands = _capture_commands(adapter)

    _run(
        adapter._handle_slash_command(
            {
                "command": "/agents-status",
                "text": "",
                "channel_id": "C123",
                "user_id": "U123",
            }
        )
    )

    assert commands[0].channel_type == "channel_private"


def test_slash_command_translates_slack_mention() -> None:
    adapter = _adapter()
    adapter._web_client = _FakeSlashWebClient()  # type: ignore[assignment]
    # Prime the user cache so the encoded mention resolves to a name.
    adapter._user_cache["U999"] = SlackUser(name="worker", display_name="Worker")
    commands = _capture_commands(adapter)

    _run(
        adapter._handle_slash_command(
            {
                "command": "/interrupt",
                "text": "<@U999>",
                "channel_id": "C123",
                "user_id": "U123",
            }
        )
    )

    # `<@U999>` is normalised to `@worker` so command targeting resolves it.
    assert commands[0].args == "@worker"


def test_translate_inbound_handles_escaped_mention_with_label() -> None:
    adapter = _adapter()
    adapter._user_cache["U012ABCDEF"] = SlackUser(name="worker", display_name="Worker")
    # Slash-command escaping sends mentions as `<@U…|username>`; both the piped
    # and bare forms must resolve to `@name`.
    assert adapter.translate_inbound("reset <@U012ABCDEF|worker>") == "reset @worker"
    assert adapter.translate_inbound("reset <@U012ABCDEF>") == "reset @worker"


def test_translate_inbound_unknown_piped_mention_falls_back_to_id() -> None:
    adapter = _adapter()
    # The bridge bot's own id is not in the user cache; it must fall back to the
    # raw id (its room-alias key) rather than being dropped, so alias routing
    # still resolves for an aliased app mention.
    assert adapter.translate_inbound("<@U012ABCDEF|agent switch>") == "@U012ABCDEF"


def test_slash_command_without_channel_is_ignored() -> None:
    adapter = _adapter()
    commands = _capture_commands(adapter)

    _run(
        adapter._handle_slash_command(
            {"command": "/reset", "text": "", "channel_id": "", "user_id": "U1"}
        )
    )

    assert commands == []


class _FakeConversationsInfoClient:
    """Minimal web client answering conversations_info for get_channel_type."""

    def __init__(self, channel: dict[str, Any]) -> None:
        self._channel = channel

    async def conversations_info(self, **_: Any) -> dict[str, Any]:
        return {"channel": self._channel}


def test_bot_join_fires_on_app_joined() -> None:
    from switch_core.bridges.collaboration.models import InboundAppJoin

    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._web_client = _FakeConversationsInfoClient({})  # type: ignore[assignment]
    adapter._channel_name_cache["C123"] = "general"

    joins: list[InboundAppJoin] = []

    async def on_app_joined(join: InboundAppJoin) -> None:
        joins.append(join)

    adapter._on_app_joined = on_app_joined

    _run(
        adapter._handle_member_joined_channel(
            {"type": "member_joined_channel", "user": "UBOT", "channel": "C123"}
        )
    )

    assert len(joins) == 1
    assert joins[0].channel_id == "C123"
    assert joins[0].channel_type == "channel_public"
    assert joins[0].channel_name == "general"


def test_user_join_does_not_fire_on_app_joined() -> None:
    from switch_core.bridges.collaboration.models import (
        InboundAppJoin,
        InboundUserJoin,
    )

    adapter = _adapter()
    adapter._bot_user_id = "UBOT"
    adapter._web_client = _FakeConversationsInfoClient({})  # type: ignore[assignment]
    adapter._channel_name_cache["C123"] = "general"
    adapter._user_cache["U1"] = SlackUser(name="alice", display_name="Alice")

    app_joins: list[InboundAppJoin] = []
    user_joins: list[InboundUserJoin] = []

    async def on_app_joined(join: InboundAppJoin) -> None:
        app_joins.append(join)

    async def on_user_joined(join: InboundUserJoin) -> None:
        user_joins.append(join)

    adapter._on_app_joined = on_app_joined
    adapter._on_user_joined = on_user_joined

    _run(
        adapter._handle_member_joined_channel(
            {"type": "member_joined_channel", "user": "U1", "channel": "C123"}
        )
    )

    assert app_joins == []
    assert len(user_joins) == 1
    assert user_joins[0].external_user_id == "U1"


# ── Outbound attachments ─────────────────────────────────────────────────────


class _FakeUploadWebClient(_FakeWebClient):
    """Adds files_upload_v2 capture on top of the postMessage fake."""

    def __init__(
        self,
        *,
        upload_response: dict[str, Any] | None = None,
        upload_error: str | None = None,
    ) -> None:
        super().__init__()
        self.uploads: list[dict[str, Any]] = []
        self._upload_response = upload_response or {"files": []}
        self._upload_error = upload_error

    async def files_upload_v2(self, **kwargs: Any) -> dict[str, Any]:
        self.uploads.append(kwargs)
        if self._upload_error:
            raise SlackApiError(self._upload_error, {"error": self._upload_error})
        return self._upload_response


def test_send_attachment_uploads_file_with_sender_and_caption() -> None:
    adapter = _adapter()
    fake = _FakeUploadWebClient(
        upload_response={"files": [{"shares": {"public": {"C123": [{"ts": "42.1"}]}}}]}
    )
    adapter._web_client = fake  # type: ignore[assignment]

    ref = _run(
        adapter.send_attachment(
            "C123",
            "agent-a",
            "plot.png",
            "image/png",
            b"bytes",
            caption="the **plot**",
            thread_root_id="C123:11.0",
        )
    )

    assert len(fake.uploads) == 1
    up = fake.uploads[0]
    assert up["channel"] == "C123"
    assert up["file"] == b"bytes"
    assert up["filename"] == "plot.png"
    # Sender identity is preserved in the comment (bolded), caption translated
    # to mrkdwn (** → *).
    assert up["initial_comment"] == "*agent-a*: the *plot*"
    assert up["thread_ts"] == "11.0"
    # The share ts from the upload response becomes the message ref.
    assert ref == "C123:42.1"


def test_send_attachment_without_caption_names_sender_and_file() -> None:
    adapter = _adapter()
    fake = _FakeUploadWebClient()
    adapter._web_client = fake  # type: ignore[assignment]

    ref = _run(adapter.send_attachment("C123", "agent-a", "cat.png", "image/png", b"x"))

    assert fake.uploads[0]["initial_comment"] == "*agent-a* sent `cat.png`"
    assert fake.uploads[0]["thread_ts"] is None
    # No share info in the response → no ref (threading correlation degraded).
    assert ref is None


def test_send_attachment_upload_failure_falls_back_to_disclosed_text() -> None:
    adapter = _adapter()
    fake = _FakeUploadWebClient(upload_error="upload_failed")
    adapter._web_client = fake  # type: ignore[assignment]

    ref = _run(
        adapter.send_attachment(
            "C123", "agent-a", "cat.png", "image/png", b"x", caption="look"
        )
    )

    # The failure surfaces as a visible text message, never a silent drop.
    assert len(fake.calls) == 1
    assert "couldn't be relayed" in fake.calls[0]["text"]
    assert "cat.png" in fake.calls[0]["text"]
    assert fake.calls[0]["username"] == "agent-a"
    assert ref == "C123:999.9"
