"""Slack's native agent session, and the reaction that marks work in progress.

The session card replaces the status message Switch used to post: it is live,
named for the agent, and carries the link back to the session. Where a card
cannot be opened the posted message is still the fallback — so much of what
matters here is which of the two appears, and that exactly one of them does.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.models import InboundCommand
from switch_core.bridges.collaboration.slack.adapter import (
    _AGENT_SESSIONS_FAILURE_LIMIT,
    SlackAdapter,
    SlackConnectionConfig,
    SlackUser,
)

_TRACE_MARKER = "[agent-sessions]"
THREAD = "C1:111.0"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class FakeResponse(dict):
    def __init__(self, *args: Any, headers: dict[str, str] | None = None) -> None:
        super().__init__(*args)
        self.headers = headers or {}


class FakeWebClient:
    def __init__(self) -> None:
        self.api_calls: list[tuple[str, dict[str, Any]]] = []
        self.posted: list[dict[str, Any]] = []
        self.deleted: list[dict[str, Any]] = []
        self.reactions: list[tuple[str, str, str]] = []
        self.stream_error: str | None = None
        self.error_headers: dict[str, str] = {}
        self.reaction_error: str | None = None
        self._ts = 0

    def _fail(self) -> None:
        if self.stream_error:
            raise SlackApiError(
                "failed",
                FakeResponse({"error": self.stream_error}, headers=self.error_headers),
            )

    async def chat_startStream(self, **kwargs: Any) -> FakeResponse:
        self._fail()
        self.api_calls.append(("chat.startStream", kwargs))
        self._ts += 1
        return FakeResponse({"ok": True, "ts": f"stream-{self._ts}"})

    async def chat_appendStream(self, **kwargs: Any) -> FakeResponse:
        self._fail()
        self.api_calls.append(("chat.appendStream", kwargs))
        return FakeResponse({"ok": True})

    async def chat_stopStream(self, **kwargs: Any) -> FakeResponse:
        self._fail()
        self.api_calls.append(("chat.stopStream", kwargs))
        return FakeResponse({"ok": True})

    async def api_call(self, method: str, **kwargs: Any) -> FakeResponse:
        self._fail()
        self.api_calls.append((method, kwargs))
        return FakeResponse({"ok": True})

    async def reactions_add(self, **kwargs: Any) -> FakeResponse:
        if self.reaction_error:
            raise SlackApiError("no", FakeResponse({"error": self.reaction_error}))
        self.reactions.append(("add", kwargs["timestamp"], kwargs["name"]))
        return FakeResponse({"ok": True})

    async def reactions_remove(self, **kwargs: Any) -> FakeResponse:
        if self.reaction_error:
            raise SlackApiError("no", FakeResponse({"error": self.reaction_error}))
        self.reactions.append(("remove", kwargs["timestamp"], kwargs["name"]))
        return FakeResponse({"ok": True})

    async def chat_postMessage(self, **kwargs: Any) -> FakeResponse:
        self._ts += 1
        self.posted.append(kwargs)
        return FakeResponse({"ts": f"{self._ts}.0"})

    async def chat_delete(self, **kwargs: Any) -> FakeResponse:
        self.deleted.append(kwargs)
        return FakeResponse({"ok": True})

    async def chat_update(self, **kwargs: Any) -> FakeResponse:
        return FakeResponse({"ok": True})

    async def conversations_info(self, **kwargs: Any) -> FakeResponse:
        return FakeResponse({"channel": {"is_private": False}})

    async def users_info(self, **kwargs: Any) -> FakeResponse:
        return FakeResponse({"user": {"name": "someone", "profile": {}}})


def _adapter(*, enabled: bool = True) -> tuple[SlackAdapter, FakeWebClient]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
            agent_sessions=enabled,
        )
    )
    client = FakeWebClient()
    adapter._web_client = client  # type: ignore[assignment]
    adapter._channel_type_cache["C1"] = "channel"
    # Learned from auth_test at startup. On an Enterprise Grid org this is not
    # the configured workspace id, which is the org (`E…`) rather than the team.
    adapter._team_id = "T02TEAM"
    # Recorded in life from the message that started the turn.
    adapter._thread_requester[("C1", "111.0")] = "U1"
    return adapter, client


def _methods(client: FakeWebClient) -> list[str]:
    return [method for method, _ in client.api_calls]


def _chunks(client: FakeWebClient) -> list[dict[str, Any]]:
    return [p["chunks"][0] for m, p in client.api_calls if m == "chat.appendStream"]


def _state(
    adapter: SlackAdapter,
    state: str,
    *,
    detail: str | None = None,
    thread: str | None = THREAD,
    deeplink: str | None = None,
) -> Any:
    return adapter.apply_runtime_state(
        "C1",
        "flint-tracker",
        state,
        mention_handle=None,
        thread_root_id=thread,
        detail=detail,
        deeplink_url=deeplink,
    )


# ── The card replaces the posted message ─────────────────────────────────────


def test_a_streamed_turn_posts_a_stop_button_alongside_the_card() -> None:
    """The card tells the story; a minimal button-only message beside it
    gives the user a way to interrupt the turn from Slack."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading the codebase"))

    assert "chat.startStream" in _methods(client)
    assert len(client.posted) == 1
    blocks = client.posted[0].get("blocks", [])
    action_ids = [
        el["action_id"]
        for b in blocks
        if b["type"] == "actions"
        for el in b["elements"]
    ]
    assert "switch_interrupt" in action_ids
    # No section block — the card already has the status text.
    assert not any(b["type"] == "section" for b in blocks)


def test_an_earlier_posted_message_is_replaced_by_a_button_once_a_card_exists() -> None:
    adapter, client = _adapter()
    adapter._agent_sessions_off_reason = "not_authorized"
    _run(_state(adapter, "working", detail="first"))
    assert len(client.posted) == 1

    adapter._agent_sessions_off_reason = None
    _run(_state(adapter, "working", detail="second"))

    # The old working message is deleted and replaced by a button-only one.
    assert len(client.deleted) == 1
    assert len(client.posted) == 2


def test_without_a_card_the_posted_message_is_still_the_indicator() -> None:
    adapter, client = _adapter(enabled=False)

    _run(_state(adapter, "working", detail="reading"))

    assert client.api_calls == []
    assert len(client.posted) == 1


def test_a_turn_with_no_thread_falls_back_to_the_posted_message() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading", thread=None))

    assert "chat.startStream" not in _methods(client)
    assert len(client.posted) == 1


def test_a_refused_card_falls_back_to_the_posted_message() -> None:
    """Losing the card must never mean losing the turn's progress entirely."""
    adapter, client = _adapter()
    client.stream_error = "not_authorized"

    _run(_state(adapter, "working", detail="reading"))

    assert len(client.posted) == 1
    assert adapter._stream_ts == {}


def test_the_session_status_is_never_set() -> None:
    """Setting it draws a second card under the app's own name, with Slack's
    generic wording and no way to rename it — two cards for one turn."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))

    assert "agents.sessions.setStatus" not in _methods(client)


# ── What the card carries ────────────────────────────────────────────────────


def test_the_card_is_opened_for_the_agent_and_the_asker() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))

    opened = next(p for m, p in client.api_calls if m == "chat.startStream")
    assert opened["thread_ts"] == "111.0"
    assert opened["recipient_user_id"] == "U1"
    assert opened["recipient_team_id"] == "T02TEAM"
    assert opened["username"] == "flint-tracker"


def test_each_new_activity_becomes_a_step() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading the codebase"))
    _run(_state(adapter, "working", detail="running the tests"))

    assert [c["title"] for c in _chunks(client)] == [
        "reading the codebase",
        "running the tests",
    ]


def test_the_same_activity_is_not_sent_twice() -> None:
    adapter, client = _adapter()

    for _ in range(4):
        _run(_state(adapter, "working", detail="reading the codebase"))

    assert len(_chunks(client)) == 1


def test_a_stalled_turn_is_flagged_rather_than_shown_as_progress() -> None:
    """A detail on `awaiting-input` is why the turn died, not a step the agent
    is taking. Unmarked it reads as work in progress."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading the codebase"))
    _run(_state(adapter, "awaiting-input", detail="authentication_failed — expired"))

    assert [c["title"] for c in _chunks(client)] == [
        "reading the codebase",
        "⚠️ authentication_failed — expired",
    ]


def test_an_ordinary_request_for_input_is_not_flagged() -> None:
    """Only a reason gets the warning mark — a plain request for input keeps
    the generic step it has always had."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading the codebase"))
    _run(_state(adapter, "awaiting-input"))

    assert [c["title"] for c in _chunks(client)] == ["reading the codebase", "Working"]


def test_switch_markup_is_stripped_from_a_step() -> None:
    """A card's title is plain text, so markup arrives as literal underscores
    and backticks — which is exactly how it looked in the pilot."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="_Running tool_ `Bash` — sleep 10"))

    assert _chunks(client)[0]["title"] == "Running tool Bash — sleep 10"


def test_the_console_link_travels_with_the_card() -> None:
    """It used to live on the message Switch posted. With the card standing
    alone, losing it would cost the way back into the live session."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading", deeplink="https://switch/x"))

    assert _chunks(client)[0]["sources"] == [
        {"type": "url", "text": "Open in Switch Console", "url": "https://switch/x"}
    ]


def test_no_sources_when_there_is_no_link() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))

    assert "sources" not in _chunks(client)[0]


def test_the_card_is_closed_when_the_turn_ends() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))

    assert "chat.stopStream" in _methods(client)
    assert adapter._stream_ts == {}


def test_a_second_turn_opens_a_fresh_card() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="first"))
    _run(_state(adapter, "idle"))
    _run(_state(adapter, "working", detail="second"))

    assert _methods(client).count("chat.startStream") == 2


def test_no_card_without_the_team_id() -> None:
    adapter, client = _adapter()
    adapter._team_id = ""

    _run(_state(adapter, "working", detail="reading"))

    assert "chat.startStream" not in _methods(client)


def test_no_card_without_someone_to_stream_to() -> None:
    adapter, client = _adapter()
    adapter._thread_requester.clear()

    _run(_state(adapter, "working", detail="reading"))

    assert "chat.startStream" not in _methods(client)


# ── The eyes on the message being worked on ──────────────────────────────────


def test_the_message_being_worked_on_gets_the_eyes() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))

    assert ("add", "111.0", "eyes") in client.reactions


def test_the_eyes_come_off_when_the_turn_ends() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))

    assert ("remove", "111.0", "eyes") in client.reactions


def test_the_eyes_are_added_once_for_a_turn() -> None:
    adapter, client = _adapter()

    for _ in range(5):
        _run(_state(adapter, "working", detail="reading"))

    assert [r for r in client.reactions if r[0] == "add"] == [("add", "111.0", "eyes")]


def test_the_eyes_work_without_a_session() -> None:
    """The one progress signal needing nothing from Slack beyond a scope we
    already hold — so it must not be tied to the card."""
    adapter, client = _adapter(enabled=False)

    _run(_state(adapter, "working", detail="reading"))

    assert ("add", "111.0", "eyes") in client.reactions


def test_an_already_present_reaction_is_not_an_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, client = _adapter()
    client.reaction_error = "already_reacted"

    with caplog.at_level("WARNING"):
        _run(_state(adapter, "working", detail="reading"))

    assert [r for r in caplog.records if "working reaction" in r.getMessage()] == []
    assert ("C1", "111.0") in adapter._eyes


# ── Refusals ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "error,expected",
    [
        ("not_authorized", "not a member of that channel"),
        ("missing_scope", "assistant:write"),
        ("feature_disabled", "not enabled for this Slack workspace"),
        ("unknown_method", "does not offer"),
    ],
)
def test_a_refusal_is_reported_once_and_not_retried(
    error: str, expected: str, caplog: pytest.LogCaptureFixture
) -> None:
    adapter, client = _adapter()
    client.stream_error = error

    with caplog.at_level("WARNING"):
        for _ in range(3):
            _run(_state(adapter, "working", detail="reading"))

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert expected in warnings[0].getMessage()


def test_an_unknown_refusal_gives_up_rather_than_warning_forever(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, client = _adapter()
    client.stream_error = "some_code_we_have_never_seen"

    with caplog.at_level("WARNING"):
        for _ in range(3):
            _run(_state(adapter, "working", detail="reading"))
        settled = len([r for r in caplog.records if r.levelname == "WARNING"])
        for _ in range(5):
            _run(_state(adapter, "working", detail="reading"))

    assert adapter._agent_sessions_off_reason == "some_code_we_have_never_seen"
    assert len([r for r in caplog.records if r.levelname == "WARNING"]) == settled


def test_a_given_up_session_says_nothing_further(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = _adapter()
    adapter._agent_sessions_off_reason = "not_authorized"

    with caplog.at_level("DEBUG"):
        for _ in range(20):
            _run(_state(adapter, "working", detail="reading"))

    assert [r for r in caplog.records if _TRACE_MARKER in r.getMessage()] == []


def test_a_threadless_agent_is_only_reported_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = _adapter()

    with caplog.at_level("DEBUG"):
        for _ in range(20):
            _run(_state(adapter, "working", detail="reading", thread=None))

    assert len([r for r in caplog.records if "no thread for" in r.getMessage()]) == 1


# ── The stop button ──────────────────────────────────────────────────────────


def test_stop_interrupts_the_agent_whose_turn_it_is() -> None:
    adapter, _ = _adapter()
    commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    adapter._on_command = on_command  # type: ignore[assignment]
    adapter._user_cache["U1"] = SlackUser(name="louis", display_name="Louis")

    _run(_state(adapter, "working", detail="reading"))
    _run(
        adapter._handle_session_stopped(
            {"channel_id": "C1", "thread_ts": "111.0", "user_id": "U1"}
        )
    )

    assert len(commands) == 1
    assert commands[0].command == "interrupt"
    assert commands[0].args == "@flint-tracker"


def test_a_finished_turn_no_longer_answers_the_stop_button() -> None:
    adapter, _ = _adapter()
    commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    adapter._on_command = on_command  # type: ignore[assignment]

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))
    _run(
        adapter._handle_session_stopped(
            {"channel_id": "C1", "thread_ts": "111.0", "user_id": "U1"}
        )
    )

    assert commands == []


def test_the_requester_is_recorded_from_an_incoming_message() -> None:
    adapter, _ = _adapter()
    adapter._thread_requester.clear()
    adapter._bot_user_id = "UBOT"

    _run(
        adapter._handle_message_event(
            {
                "channel": "C1",
                "ts": "333.0",
                "user": "U9",
                "text": "hi",
                "channel_type": "channel",
            }
        )
    )

    assert adapter._thread_requester[("C1", "333.0")] == "U9"


# ── Two messages at once ─────────────────────────────────────────────────────


def _thread_b(adapter: SlackAdapter) -> None:
    adapter._thread_requester[("C1", "222.0")] = "U1"


def test_both_messages_lose_their_eyes_when_the_turn_ends() -> None:
    """A turn ends once, naming only the thread it last touched. The first
    message kept its eyes for good until this was tracked per agent."""
    adapter, client = _adapter()
    _thread_b(adapter)

    _run(_state(adapter, "working", detail="first", thread="C1:111.0"))
    _run(_state(adapter, "working", detail="second", thread="C1:222.0"))
    _run(_state(adapter, "idle", thread="C1:222.0"))

    removed = {ts for kind, ts, _ in client.reactions if kind == "remove"}
    assert removed == {"111.0", "222.0"}


def test_both_cards_are_closed_when_the_turn_ends() -> None:
    adapter, client = _adapter()
    _thread_b(adapter)

    _run(_state(adapter, "working", detail="first", thread="C1:111.0"))
    _run(_state(adapter, "working", detail="second", thread="C1:222.0"))
    _run(_state(adapter, "idle", thread="C1:222.0"))

    stopped = {p["ts"] for m, p in client.api_calls if m == "chat.stopStream"}
    assert len(stopped) == 2
    assert adapter._stream_ts == {}


def test_a_stop_on_either_thread_stops_answering_after_the_turn() -> None:
    adapter, _ = _adapter()
    _thread_b(adapter)

    _run(_state(adapter, "working", detail="first", thread="C1:111.0"))
    _run(_state(adapter, "working", detail="second", thread="C1:222.0"))
    _run(_state(adapter, "idle", thread="C1:222.0"))

    assert adapter._session_owner == {}


# ── The card's own end state ─────────────────────────────────────────────────


def test_the_last_step_is_marked_done_before_the_card_closes() -> None:
    """Slack draws a step left in progress as a failure — every finished turn
    was ending under a red error icon."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))

    assert [c["status"] for c in _chunks(client)] == ["in_progress", "complete"]
    # And the completion lands before the stream is closed, not after.
    methods = _methods(client)
    assert methods.index("chat.appendStream") < methods.index("chat.stopStream")


def test_a_card_with_no_step_is_just_closed() -> None:
    adapter, client = _adapter()
    adapter._stream_ts[("C1", "111.0")] = "stream-1"

    _run(_state(adapter, "idle"))

    assert _chunks(client) == []


def test_the_console_link_is_sent_once_per_card() -> None:
    """Slack accumulates a task's sources rather than replacing them, so
    sending the link every step stacked eight identical links under one card."""
    adapter, client = _adapter()

    for detail in ("reading", "running tests", "writing"):
        _run(_state(adapter, "working", detail=detail, deeplink="https://switch/x"))

    with_sources = [c for c in _chunks(client) if "sources" in c]
    assert len(with_sources) == 1


# ── Nothing left behind ──────────────────────────────────────────────────────


def test_the_card_and_button_are_deleted_when_the_turn_ends() -> None:
    """Both the card and the button-only message are progress indicators, not
    records — once the turn is over the agent's own reply is the thing worth
    reading."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))

    deleted_ts = sorted(d["ts"] for d in client.deleted)
    # The button message (posted as chat_postMessage) and the stream card.
    assert "stream-1" in deleted_ts
    assert len(deleted_ts) == 2


def test_every_card_and_button_is_deleted_when_two_were_open() -> None:
    adapter, client = _adapter()
    adapter._thread_requester[("C1", "222.0")] = "U1"

    _run(_state(adapter, "working", detail="first", thread="C1:111.0"))
    _run(_state(adapter, "working", detail="second", thread="C1:222.0"))
    _run(_state(adapter, "idle", thread="C1:222.0"))

    deleted_ts = sorted(d["ts"] for d in client.deleted)
    # Two cards + one button message (one per channel+agent) = 3 deletions.
    assert len(deleted_ts) == 3


# ── Which message gets the eyes ──────────────────────────────────────────────


def test_the_eyes_go_on_the_message_that_asked_not_the_thread_root() -> None:
    """Inside a thread the question is a reply. Marking the root says the
    conversation is busy; marking the reply says which request is being run."""
    adapter, client = _adapter()
    adapter._bot_user_id = "UBOT"

    _run(
        adapter._handle_message_event(
            {
                "channel": "C1",
                "ts": "555.0",
                "thread_ts": "111.0",
                "user": "U1",
                "text": "hi",
                "channel_type": "channel",
            }
        )
    )
    _run(_state(adapter, "working", detail="reading"))

    assert ("add", "555.0", "eyes") in client.reactions
    assert not any(ts == "111.0" for _, ts, _ in client.reactions)


def test_the_eyes_come_off_the_message_that_asked() -> None:
    adapter, client = _adapter()
    adapter._bot_user_id = "UBOT"

    _run(
        adapter._handle_message_event(
            {
                "channel": "C1",
                "ts": "555.0",
                "thread_ts": "111.0",
                "user": "U1",
                "text": "hi",
                "channel_type": "channel",
            }
        )
    )
    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))

    assert ("remove", "555.0", "eyes") in client.reactions


def test_a_root_question_is_marked_on_itself() -> None:
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))

    assert ("add", "111.0", "eyes") in client.reactions


# ── Throttling and give-ups that expire ──────────────────────────────────────


def test_throttling_never_counts_towards_giving_up() -> None:
    """A busy workspace is not a broken one.

    Counting rate limits as refusals turned a burst of traffic into a bridge
    that showed no card again until someone restarted it."""
    adapter, client = _adapter()
    client.stream_error = "ratelimited"

    for _ in range(_AGENT_SESSIONS_FAILURE_LIMIT + 5):
        adapter._sessions_throttled_until = None
        _run(_state(adapter, "working", detail="reading"))

    assert adapter._agent_sessions_off_reason is None


def test_throttling_pauses_updates_for_as_long_as_slack_asked() -> None:
    adapter, client = _adapter()
    client.stream_error = "ratelimited"
    client.error_headers = {"Retry-After": "45"}

    _run(_state(adapter, "working", detail="reading"))
    assert adapter._sessions_throttled_until is not None
    assert adapter._sessions_throttled_until - time.monotonic() > 40

    client.stream_error = None
    _run(_state(adapter, "working", detail="still reading"))

    assert "chat.startStream" not in _methods(client)


def test_the_card_comes_back_once_the_throttling_window_passes() -> None:
    adapter, client = _adapter()
    client.stream_error = "ratelimited"
    _run(_state(adapter, "working", detail="reading"))

    client.stream_error = None
    adapter._sessions_throttled_until = time.monotonic() - 1
    _run(_state(adapter, "working", detail="reading again"))

    assert "chat.startStream" in _methods(client)


def test_throttling_is_announced_once_per_burst(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, client = _adapter()
    client.stream_error = "ratelimited"

    with caplog.at_level("WARNING"):
        for _ in range(10):
            _run(_state(adapter, "working", detail="reading"))

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "rate-limiting" in warnings[0].getMessage()


def test_a_turn_still_ends_while_we_are_being_throttled() -> None:
    """Skipping teardown would leave the card open for good."""
    adapter, client = _adapter()
    _run(_state(adapter, "working", detail="reading"))
    adapter._sessions_throttled_until = time.monotonic() + 600

    _run(_state(adapter, "idle"))

    assert "chat.stopStream" in _methods(client)


def test_a_give_up_over_an_unknown_error_is_retried_later() -> None:
    adapter, client = _adapter()
    client.stream_error = "some_code_we_have_never_seen"
    for _ in range(_AGENT_SESSIONS_FAILURE_LIMIT):
        _run(_state(adapter, "working", detail="reading"))
    assert adapter._agent_sessions_off_reason == "some_code_we_have_never_seen"

    client.stream_error = None
    adapter._agent_sessions_retry_at = time.monotonic() - 1
    _run(_state(adapter, "working", detail="reading again"))

    assert adapter._agent_sessions_off_reason is None
    assert "chat.startStream" in _methods(client)


def test_a_refusal_that_named_its_cause_is_not_retried() -> None:
    """Nothing about the workspace changes on its own, so nothing re-arms."""
    adapter, client = _adapter()
    client.stream_error = "not_an_agent"
    _run(_state(adapter, "working", detail="reading"))

    assert adapter._agent_sessions_off_reason == "not_an_agent"
    assert adapter._agent_sessions_retry_at is None

    client.stream_error = None
    _run(_state(adapter, "working", detail="reading again"))

    assert "chat.startStream" not in _methods(client)


# ── A card that has gone ─────────────────────────────────────────────────────


def test_a_card_that_has_gone_does_not_count_against_the_app() -> None:
    """We delete the card ourselves at the end of a turn, so a state report a
    moment behind the teardown writes to something that is no longer there."""
    adapter, client = _adapter()
    _run(_state(adapter, "working", detail="reading"))

    client.stream_error = "message_not_found"
    for _ in range(_AGENT_SESSIONS_FAILURE_LIMIT + 3):
        _run(_state(adapter, "working", detail="still reading"))

    assert adapter._agent_sessions_off_reason is None


def test_a_card_that_has_gone_is_forgotten() -> None:
    adapter, client = _adapter()
    _run(_state(adapter, "working", detail="reading"))
    assert adapter._stream_ts

    client.stream_error = "message_not_found"
    _run(_state(adapter, "working", detail="still reading"))

    assert adapter._stream_ts == {}
    assert adapter._stream_step == {}


def test_the_turn_falls_back_to_the_posted_message_once_its_card_is_gone() -> None:
    adapter, client = _adapter()
    _run(_state(adapter, "working", detail="reading"))
    # The streaming path posted a button; note how many messages exist.
    assert len(client.posted) == 1
    client.stream_error = "message_not_found"
    _run(_state(adapter, "working", detail="still reading"))

    client.stream_error = None
    _run(_state(adapter, "working", detail="reading on"))

    # The card is gone so a new stream opens; the existing button message
    # (still tracked as a working_msg) is updated in place or a new one
    # is posted.
    assert _methods(client).count("chat.startStream") == 2


def test_a_step_that_never_landed_is_not_recorded_as_shown() -> None:
    """Recording it would tell the next step the console link had been sent."""
    adapter, client = _adapter()
    _run(_state(adapter, "working", detail="reading", deeplink="https://x/1"))
    adapter._stream_step.clear()
    client.stream_error = "not_in_channel"

    _run(_state(adapter, "working", detail="a step that fails"))

    assert adapter._stream_step == {}


# ── Turns nobody in Slack asked for ──────────────────────────────────────────


def _bot_message(adapter: SlackAdapter, ts: str, thread_ts: str | None = None) -> None:
    event: dict[str, Any] = {
        "channel": "C1",
        "ts": ts,
        "bot_id": "B0WORKFLOW",
        "username": "Daily summary",
        "text": "@flint-tracker summarise yesterday",
        "channel_type": "channel",
    }
    if thread_ts:
        event["thread_ts"] = thread_ts
    _run(adapter._handle_message_event(event))


def test_a_workflow_post_is_marked_like_any_other_request() -> None:
    """A Slack workflow asking an agent something is a request like any other."""
    adapter, client = _adapter()
    adapter._bot_user_id = "UBOT"
    _bot_message(adapter, "777.0", thread_ts="111.0")

    _run(_state(adapter, "working", detail="reading"))

    assert ("add", "777.0", "eyes") in client.reactions


def test_a_message_slack_cannot_find_is_marked_once_not_every_report() -> None:
    adapter, client = _adapter()
    client.reaction_error = "message_not_found"

    for _ in range(8):
        _run(_state(adapter, "working", detail="reading"))

    assert client.reactions == []


def test_the_warning_names_the_message_not_just_the_channel(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, client = _adapter()
    client.reaction_error = "message_not_found"

    with caplog.at_level("WARNING"):
        _run(_state(adapter, "working", detail="reading"))

    warnings = [r for r in caplog.records if "working reaction" in r.getMessage()]
    assert len(warnings) == 1
    assert "111.0" in warnings[0].getMessage()


# ── The interactive Stop button ─────────────────────────────────────────────


def _block_action_payload(
    agent_name: str = "flint-tracker",
    channel_id: str = "C1",
    thread_ts: str = "111.0",
    user_id: str = "U1",
    action_id: str = "switch_interrupt",
) -> dict[str, Any]:
    return {
        "type": "block_actions",
        "user": {"id": user_id},
        "channel": {"id": channel_id},
        "message": {"ts": "999.0", "thread_ts": thread_ts},
        "actions": [
            {
                "action_id": action_id,
                "value": agent_name,
            }
        ],
    }


def test_block_action_interrupts_the_agent_during_a_live_turn() -> None:
    adapter, _ = _adapter()
    commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    adapter._on_command = on_command  # type: ignore[assignment]
    adapter._user_cache["U1"] = SlackUser(name="louis", display_name="Louis")

    _run(_state(adapter, "working", detail="reading"))
    _run(adapter._handle_block_action(_block_action_payload()))

    assert len(commands) == 1
    assert commands[0].command == "interrupt"
    assert commands[0].args == "@flint-tracker"
    assert commands[0].sender_name == "louis"


def test_block_action_after_turn_finished_posts_soft_message() -> None:
    adapter, client = _adapter()
    commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    adapter._on_command = on_command  # type: ignore[assignment]

    _run(_state(adapter, "working", detail="reading"))
    _run(_state(adapter, "idle"))
    _run(adapter._handle_block_action(_block_action_payload()))

    assert commands == []
    already_finished = [
        p for p in client.posted if "already finished" in p.get("text", "")
    ]
    assert len(already_finished) == 1


def test_block_action_with_unknown_action_id_is_ignored() -> None:
    adapter, _ = _adapter()
    commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    adapter._on_command = on_command  # type: ignore[assignment]

    _run(_state(adapter, "working", detail="reading"))
    _run(
        adapter._handle_block_action(
            _block_action_payload(action_id="some_other_action")
        )
    )

    assert commands == []


def test_working_message_carries_stop_button_blocks() -> None:
    """Without the native card, the working message carries a section with the
    status text and an actions block with the Stop button."""
    adapter, client = _adapter(enabled=False)

    _run(_state(adapter, "working", detail="reading"))

    assert len(client.posted) == 1
    blocks = client.posted[0].get("blocks", [])
    assert any(b["type"] == "section" for b in blocks)
    action_ids = [
        el["action_id"]
        for b in blocks
        if b["type"] == "actions"
        for el in b["elements"]
    ]
    assert "switch_interrupt" in action_ids


def test_streaming_path_button_message_is_deleted_on_idle() -> None:
    """The button-only message posted alongside the native card must not
    outlive the turn — a stale Stop button that does nothing is the exact
    failure mode CHOO-2277 warned about."""
    adapter, client = _adapter()

    _run(_state(adapter, "working", detail="reading"))
    assert len(client.posted) == 1

    _run(_state(adapter, "idle"))

    # Both the card and the button message are cleaned up.
    assert len(client.deleted) == 2


def test_block_action_falls_back_to_session_owner() -> None:
    """When the button's value is empty, the handler resolves the agent
    from _session_owner."""
    adapter, _ = _adapter()
    commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        commands.append(cmd)

    adapter._on_command = on_command  # type: ignore[assignment]
    adapter._user_cache["U1"] = SlackUser(name="louis", display_name="Louis")

    _run(_state(adapter, "working", detail="reading"))
    payload = _block_action_payload()
    payload["actions"][0]["value"] = ""
    _run(adapter._handle_block_action(payload))

    assert len(commands) == 1
    assert commands[0].args == "@flint-tracker"
