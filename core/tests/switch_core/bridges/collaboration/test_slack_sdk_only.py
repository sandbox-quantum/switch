"""Slack uses SDK publication, and handles no native stop event."""

import asyncio
import logging
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from slack_sdk.errors import SlackApiError
from slack_sdk.socket_mode.request import SocketModeRequest

from switch_core.bridges.collaboration import cooldown as cooldown_module
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack import adapter as slack_module
from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
    SlackReactionsRateLimited,
)

from .slack_fakes import FakeResponse, FakeWebClient


def adapter():
    result = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )
    client = FakeWebClient()
    result._web_client = client
    return result, client


async def test_native_stop_event_is_acknowledged_without_interrupting_an_sdk_turn():
    slack, _ = adapter()
    slack._on_command = AsyncMock()
    socket = SimpleNamespace(send_socket_mode_response=AsyncMock())
    await slack._handle_socket_event(
        socket,
        SocketModeRequest(
            type="events_api",
            envelope_id="old-event",
            payload={
                "event": {
                    "type": "agent_session_stopped",
                    "channel_id": "C1",
                    "thread_ts": "1.0",
                }
            },
        ),
    )
    socket.send_socket_mode_response.assert_awaited_once()
    slack._on_command.assert_not_awaited()


@pytest.mark.parametrize("error", ["already_reacted", "message_not_found"])
async def test_reaction_cache_handles_expected_slack_refusals_quietly(error, caplog):
    slack, client = adapter()
    client.reaction_error = error
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="working", on=True
    )
    client.reaction_error = None
    await slack.mark_activity("C1", "1.0", agent_name="worker", mark="working", on=True)
    assert not client.reactions
    assert not caplog.records


async def test_a_removal_slack_will_not_make_is_said_out_loud(caplog):
    """A mark that does not come off is the one failure a reader can see.

    Slack answering `message_not_found` to a removal is taken as the mark
    having gone with the message, and the caller is told it succeeded. When the
    message is in fact there that is a reaction left on it for good — the
    caller has been told there is nothing left to take off, so nothing tries
    again. Silently is the one way this must not happen.
    """
    slack, client = adapter()
    client.reaction_error = "message_not_found"
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="queued", on=False, force=True
    )

    assert "could not find 1.0 in C1 to take the queued reaction off" in caplog.text


async def test_a_removal_skipped_for_a_message_slack_lost_earlier_says_so(caplog):
    """The message goes in the cache once and every later mark reads it.

    So the addition that put it there is not the only removal that never
    reaches Slack, and a turn whose mark is stranded this way is one that never
    called Slack at all — there is nothing for a request log to show.
    """
    slack, client = adapter()
    client.reaction_error = "message_not_found"
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="queued", on=True
    )
    client.reaction_error = None
    caplog.clear()
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="queued", on=False, force=True
    )

    assert not client.reactions
    assert "Not asking Slack to take the queued reaction off 1.0 in C1" in caplog.text


async def test_a_rate_limited_reaction_stops_the_asking_until_slack_says_when(
    monkeypatch,
):
    """The publisher redraws on a timer, so a refusal it retries costs a call.

    Every few seconds, per turn still wanting its mark — which is how a
    workspace that metered one reaction call stayed metered, the retries
    holding the limit open against themselves. The window Slack names is
    waited out instead, and the turn keeps asking so the mark still lands.
    """
    slack, client = adapter()
    now = 1000.0
    monkeypatch.setattr(cooldown_module, "time", SimpleNamespace(monotonic=lambda: now))
    client.reaction_error = "ratelimited"
    client.reaction_error_headers = {"Retry-After": "7"}

    with pytest.raises(SlackReactionsRateLimited):
        await slack.mark_activity(
            "C1", "C1:1.0", agent_name="worker", mark="working", on=False, force=True
        )

    client.reaction_error = None
    for now in (1000.0, 1006.9):
        with pytest.raises(SlackReactionsRateLimited):
            await slack.mark_activity(
                "C1",
                "C1:2.0",
                agent_name="worker",
                mark="working",
                on=False,
                force=True,
            )
    assert not client.reactions

    now = 1007.1
    await slack.mark_activity(
        "C1", "C1:2.0", agent_name="worker", mark="working", on=False, force=True
    )
    assert client.reactions == [("remove", "2.0", "eyes")]


async def test_reaction_force_reconciles_after_restart():
    slack, client = adapter()
    await slack.mark_activity(
        "C1", "C1:1.0", agent_name="worker", mark="working", on=False, force=True
    )
    assert client.reactions == [("remove", "1.0", "eyes")]


def test_native_progress_setting_is_absent_from_registration():
    assert (
        "agent_sessions" not in SlackConnectionConfig.model_json_schema()["properties"]
    )


async def test_typed_interrupt_still_routes_to_the_global_command():
    slack, _ = adapter()
    slack._on_command = AsyncMock()
    slack._channel_name_cache["C1"] = "test"
    await slack._handle_message_event(
        {
            "type": "message",
            "channel": "C1",
            "channel_type": "channel",
            "ts": "2.0",
            "thread_ts": "1.0",
            "user": "U1",
            "text": "!interrupt @worker",
        }
    )
    slack._on_command.assert_awaited_once()
    command = slack._on_command.call_args.args[0]
    assert command.command == "interrupt"
    assert command.args == "@worker"
    assert command.root_id == "C1:1.0"


# ── Reading back what was posted while no process listened ─────────────────

SINCE = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


def _at(seconds: float) -> str:
    """The Slack timestamp `seconds` after SINCE."""
    return f"{SINCE.timestamp() + seconds:.6f}"


def _post(seconds: float, text: str, **fields: Any) -> dict[str, Any]:
    return {"type": "message", "ts": _at(seconds), "user": "U1", "text": text, **fields}


class _Channels(FakeWebClient):
    """Channels as Slack reads them back: history newest first, a page at a
    time, and a thread as its root and then its replies."""

    def __init__(
        self,
        posts: dict[str, list[dict[str, Any]]],
        *,
        replies: dict[str, list[dict[str, Any]]] | None = None,
        kinds: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        super().__init__()
        self.channel_posts = posts
        self.thread_replies = replies or {}
        self.kinds = kinds or {}
        self.history_calls: list[dict[str, Any]] = []
        self.replies_calls: list[dict[str, Any]] = []
        self.history_errors: dict[str, str] = {}
        self.slow = 0.0

    async def conversations_history(self, **kwargs: Any) -> FakeResponse:
        self.history_calls.append(kwargs)
        await asyncio.sleep(self.slow)
        channel = kwargs["channel"]
        if channel in self.history_errors:
            raise SlackApiError(
                "refused", FakeResponse({"error": self.history_errors[channel]})
            )
        newest_first = list(reversed(self.channel_posts.get(channel, [])))
        start = int(kwargs.get("cursor") or 0)
        end = start + kwargs["limit"]
        more = end < len(newest_first)
        return FakeResponse(
            {
                "messages": newest_first[start:end],
                "has_more": more,
                "response_metadata": {"next_cursor": str(end) if more else ""},
            }
        )

    async def conversations_replies(self, **kwargs: Any) -> FakeResponse:
        self.replies_calls.append(kwargs)
        root = [
            post
            for posts in self.channel_posts.values()
            for post in posts
            if post["ts"] == kwargs["ts"]
        ]
        replies = [
            reply
            for reply in self.thread_replies.get(kwargs["ts"], [])
            if float(reply["ts"]) > float(kwargs["oldest"])
        ]
        return FakeResponse({"messages": root + replies, "has_more": False})

    async def conversations_info(self, **kwargs: Any) -> FakeResponse:
        return FakeResponse({"channel": self.kinds.get(kwargs["channel"], {})})


def _reading(
    posts: dict[str, list[dict[str, Any]]], **kwargs: Any
) -> tuple[SlackAdapter, _Channels, list[InboundMessage]]:
    slack = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )
    client = _Channels(posts, **kwargs)
    slack._web_client = client  # type: ignore[assignment]
    slack._bot_user_id = "UBOT"
    slack._bot_id = "BBOT"
    handed: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        handed.append(message)

    slack._on_message = on_message
    slack._on_command = AsyncMock()
    return slack, client, handed


def _live(post: dict[str, Any], channel: str, kind: str) -> dict[str, Any]:
    """The post as its event over Socket Mode carries it."""
    return {**post, "channel": channel, "channel_type": kind}


async def test_a_read_back_hands_on_posts_and_thread_replies_in_order() -> None:
    """A reply comes from a thread the channel's posts show was replied to
    since, even one whose root is older, in its place among the channel's own
    posts. The bridge's own posts are left out, an app's are not, as live."""
    root = _post(-60, "an older question", latest_reply=_at(2), reply_count=2)
    slack, client, handed = _reading(
        {
            "C1": [
                root,
                _post(-1, "before the bridge moved"),
                _post(1, "while it moved"),
                _post(3, "an agent's words", user="UBOT"),
                {
                    "type": "message",
                    "subtype": "bot_message",
                    "bot_id": "B9",
                    "ts": _at(4),
                    "text": "an alert",
                },
                {
                    "type": "message",
                    "subtype": "channel_join",
                    "user": "U2",
                    "ts": _at(5),
                },
            ]
        },
        replies={
            root["ts"]: [
                _post(-30, "an earlier answer", thread_ts=root["ts"]),
                _post(2, "a later answer", thread_ts=root["ts"]),
            ]
        },
    )

    assert await slack.read_back(SINCE, ["C1"]) == 3

    assert [message.content for message in handed] == [
        "while it moved",
        "a later answer",
        "an alert",
    ]
    assert handed[1].root_id == f"C1:{root['ts']}"
    assert handed[0].channel_type == "channel_public"
    assert handed[2].sender_is_app
    assert [(call["ts"], call["oldest"]) for call in client.replies_calls] == [
        (root["ts"], f"{SINCE.timestamp():.6f}")
    ]


async def test_a_read_back_reads_a_channel_back_until_older_than_since(
    monkeypatch,
) -> None:
    monkeypatch.setattr(slack_module, "_READ_BACK_PAGE", 2)
    slack, client, handed = _reading(
        {"C1": [_post(at, f"post {at}") for at in (-90, -60, -30, 1, 2, 3)]}
    )

    assert await slack.read_back(SINCE, ["C1"]) == 3

    assert [message.content for message in handed] == ["post 1", "post 2", "post 3"]
    # Newest first: 3 and 2, then 1 and -30, older than since, so no third page.
    assert [call.get("cursor") for call in client.history_calls] == [None, "2"]


async def test_a_post_heard_already_is_handed_on_again_and_slacks_copy_is_not() -> None:
    """It may be a live post waiting for this read-back, and a reply read back
    before it would lose its thread; handed on twice, it is written once. The
    copy Slack sends a minute later is skipped as seen, as is the copy of a
    post only the read-back handed on."""
    post = _post(1, "said while the bridge moved")
    missed = _post(2, "only read back")
    slack, _, handed = _reading({"C1": [post, missed]})
    slack._remember_seen(post["ts"])

    assert await slack.read_back(SINCE, ["C1"]) == 2
    await slack._handle_message_event(_live(post, "C1", "channel"))
    await slack._handle_message_event(_live(missed, "C1", "channel"))

    assert [message.content for message in handed] == [
        "said while the bridge moved",
        "only read back",
    ]


async def test_a_post_that_fails_to_hand_on_is_left_for_slacks_copy() -> None:
    first, refused, third = _post(1, "first"), _post(2, "refused"), _post(3, "third")
    slack, _, handed = _reading({"C1": [first, refused, third]})
    accept = slack._on_message

    async def refuse_one(message: InboundMessage) -> None:
        if message.content == "refused":
            raise RuntimeError("the bridge refused it")
        await accept(message)

    slack._on_message = refuse_one

    assert await slack.read_back(SINCE, ["C1"]) == 2
    slack._on_message = accept
    await slack._handle_message_event(_live(refused, "C1", "channel"))

    assert [message.content for message in handed] == ["first", "third", "refused"]


async def test_a_rate_limit_stops_the_read_back_and_leaves_the_rest_to_slack(
    caplog,
) -> None:
    slack, client, handed = _reading({"C1": [_post(1, "one")], "C2": [_post(2, "two")]})
    client.history_errors["C1"] = "ratelimited"

    with caplog.at_level(logging.WARNING):
        assert await slack.read_back(SINCE, ["C1", "C2"]) == 0

    assert handed == []
    assert [call["channel"] for call in client.history_calls] == ["C1"]
    assert "comes when Slack sends it again" in caplog.text


async def test_a_channel_that_cannot_be_read_back_does_not_stop_the_rest() -> None:
    slack, client, handed = _reading({"C2": [_post(2, "two")]})
    client.history_errors["C1"] = "channel_not_found"

    assert await slack.read_back(SINCE, ["C1", "C2"]) == 1

    assert [message.content for message in handed] == ["two"]


async def test_a_read_back_stops_reading_channels_after_its_time(
    monkeypatch, caplog
) -> None:
    monkeypatch.setattr(slack_module, "_READ_BACK_SECONDS", 0.05)
    slack, client, handed = _reading({"C1": [_post(1, "one")], "C2": [_post(2, "two")]})
    client.slow = 0.2

    with caplog.at_level(logging.WARNING):
        assert await slack.read_back(SINCE, ["C1", "C2"]) == 0

    assert handed == []
    assert [call["channel"] for call in client.history_calls] == ["C1"]
    assert "Stopped reading back Slack channels" in caplog.text


async def test_a_direct_message_read_back_is_handed_on_as_one() -> None:
    post = _post(1, "hi")
    slack, _, handed = _reading({"D1": [post]}, kinds={"D1": {"is_im": True}})

    assert await slack.read_back(SINCE, ["D1"]) == 1

    assert handed[0].channel_type == "lobby"
    assert slack._reply_thread_ts("D1", None, False) == post["ts"]


async def test_a_post_read_back_leaves_a_dm_threaded_under_the_latest_post() -> None:
    """An agent's reply in a direct message threads under the person's latest
    post, which one read back, older than a post that arrived live since, is
    not."""
    slack, _, handed = _reading(
        {"D1": [_post(1, "said while the bridge moved")]}, kinds={"D1": {"is_im": True}}
    )
    live = _post(5, "said since")
    await slack._handle_message_event(_live(live, "D1", "im"))

    assert await slack.read_back(SINCE, ["D1"]) == 1

    assert len(handed) == 2
    assert slack._reply_thread_ts("D1", None, False) == live["ts"]


async def test_over_http_a_move_misses_nothing_so_nothing_is_read_back() -> None:
    slack, client, handed = _reading({"C1": [_post(1, "one")]})
    slack._config = SlackConnectionConfig(
        bot_token="test", event_delivery="webhook", workspace_id="T1"
    )

    assert slack.listening()
    assert await slack.read_back(SINCE, ["C1"]) == 0

    assert handed == []
    assert client.history_calls == []


async def test_a_bridge_listens_once_its_socket_mode_connection_is_open(
    monkeypatch,
) -> None:
    listening_while_connecting: list[bool] = []

    class _Socket:
        def __init__(self, **kwargs: Any) -> None:
            self.socket_mode_request_listeners: list[Any] = []

        async def connect(self) -> None:
            listening_while_connecting.append(slack.listening())

        async def close(self) -> None:
            pass

    class _Authed(FakeWebClient):
        def __init__(self, **kwargs: Any) -> None:
            super().__init__()

        async def auth_test(self) -> FakeResponse:
            return FakeResponse({"ok": True, "user_id": "UBOT", "bot_id": "BBOT"})

    monkeypatch.setattr(slack_module, "SocketModeClient", _Socket)
    monkeypatch.setattr(slack_module, "AsyncWebClient", _Authed)
    slack = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="test", app_token="test", workspace_id="T1"
        )
    )

    assert not slack.listening()
    await slack.start(AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock())
    assert listening_while_connecting == [False]
    assert slack.listening()
    await slack.stop()
    assert not slack.listening()


async def test_slacks_copy_arriving_while_a_read_back_post_fails_is_handed_on() -> None:
    """Slack's copy can arrive while the read-back is handing the same post
    on. Skipped as seen and acknowledged, and then lost with the read-back's
    failure, nothing would send it again."""
    post = _post(1, "said while the bridge moved")
    slack, _, handed = _reading({"C1": [post]})
    accept = slack._on_message
    replaying = True

    async def copy_arrives_then_the_read_back_fails(message: InboundMessage) -> None:
        nonlocal replaying
        if replaying:
            replaying = False
            await slack._handle_message_event(_live(post, "C1", "channel"))
            raise RuntimeError("the bridge refused the read-back")
        await accept(message)

    slack._on_message = copy_arrives_then_the_read_back_fails

    assert await slack.read_back(SINCE, ["C1"]) == 0

    assert [message.content for message in handed] == ["said while the bridge moved"]


async def test_a_read_back_stops_handing_on_after_its_time(monkeypatch, caplog) -> None:
    """Handing on takes time too (people's names, attachments, the room), and
    live posts wait for the read-back; what it leaves comes with Slack's copy."""
    monkeypatch.setattr(slack_module, "_READ_BACK_SECONDS", 0.05)
    first, second = _post(1, "first"), _post(2, "second")
    slack, _, handed = _reading({"C1": [first, second]})
    accept = slack._on_message

    async def slowly(message: InboundMessage) -> None:
        await asyncio.sleep(0.1)
        await accept(message)

    slack._on_message = slowly

    with caplog.at_level(logging.WARNING):
        assert await slack.read_back(SINCE, ["C1"]) == 1

    assert [message.content for message in handed] == ["first"]
    assert "not handed on yet comes when Slack sends it again" in caplog.text
    slack._on_message = accept
    await slack._handle_message_event(_live(second, "C1", "channel"))
    assert [message.content for message in handed] == ["first", "second"]
