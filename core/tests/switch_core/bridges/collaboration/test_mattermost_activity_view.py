"""Reading a Mattermost turn's tool calls without posting them to the channel.

Slack prints the per-call log beside the status. Mattermost's status is one
message and has nowhere to put one, so the log sits behind a button on that
message and comes back as `ephemeral_text` — the same content, read by one
person instead of by a channel, and never added to the channel's history.

The shape is cheaper than Discord's because the reply *is* the answer. There is
no private copy to keep up to date and therefore no Refresh: the log is drawn
when the press arrives, so pressing again is the refresh and nothing on screen
can be older than the press that put it there.

What it costs is an authority question the status message never had to ask. The
button names no turn — Mattermost names the post it was pressed on, which a
client cannot write — but who may *read* that conversation is a question only
Mattermost can answer, and it is asked on every press rather than inferred from
the press having arrived at all.

The context is the other half. Mattermost keeps an action's context
confidential, and this one is signed for the channel it was minted in, so a
context that does escape is worth one conversation rather than the server.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

import pytest
from mattermostdriver.exceptions import NotEnoughPermissions

from switch_core.bridges.collaboration.adapter import ActivitySnapshot, TurnActivity
from switch_core.bridges.collaboration.ingress import CallbackRefused
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.mattermost.callback import (
    ACTIVITY_ACTION_ID,
    ACTIVITY_LABEL,
    CONTEXT_KEY,
    action_context,
    activity_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    ACTIVITY_AUDIENCE_UNKNOWN,
    ACTIVITY_FAILED,
    ACTIVITY_GONE,
    ACTIVITY_NOT_A_MEMBER,
)

from .test_mattermost_press import (
    CALLBACK_BASE,
    CHANNEL,
    POST,
    TOKEN,
    USER,
    _adapter,
    _body,
    _key,
    _record,
)
from .test_mattermost_sdk_only import _activity, _card, _posts
from .test_session_activity import _item, _turn

CALLBACK_URL = f"{CALLBACK_BASE}/collaboration/mattermost/bridge-1/callback"
CONSOLE_URL = "https://console.example.test/s/1"
OTHER_CHANNEL = "chan-2"


def _viewer(
    *, member_of: str | None = CHANNEL, **kwargs: Any
) -> tuple[MattermostAdapter, list[tuple[str, str]]]:
    """An adapter whose presser is in `member_of`, and its list of reads made."""
    adapter = _adapter(**kwargs)
    _record(adapter)
    if member_of is not None:
        _channels(adapter).members[member_of] = {USER}
    return adapter, _resolving(adapter, _snapshot())


def _channels(adapter: MattermostAdapter) -> Any:
    driver: Any = adapter._admin_driver
    return driver.channels


def _snapshot(**fields: Any) -> ActivitySnapshot:
    items = [
        _item(itemId="a", kind="tool-activity", title="Read config.toml"),
        _item(
            itemId="b", kind="tool-activity", title="Ran the tests", text="42 passed"
        ),
    ]
    defaults: dict[str, Any] = {
        "items": items,
        "turn": _turn("completed"),
        "elapsed_seconds": 12.0,
        "session_url": CONSOLE_URL,
        "read_at": datetime(2026, 9, 16, 12, 34, 56, tzinfo=UTC),
    }
    return ActivitySnapshot(**{**defaults, **fields})


def _resolving(adapter: MattermostAdapter, answer: Any = None) -> list[tuple[str, str]]:
    """Give `adapter` something to resolve a press against, and record the asks.

    `answer` is what every read returns — a snapshot, None for a post showing
    nothing, or an exception instance to raise.
    """
    asked: list[tuple[str, str]] = []

    async def resolve(channel_id: str, ref: str) -> ActivitySnapshot | None:
        asked.append((channel_id, ref))
        if isinstance(answer, Exception):
            raise answer
        return answer  # type: ignore[no-any-return]

    adapter.set_activity_resolver(resolve)
    return asked


def _press(channel: str = CHANNEL, **overrides: Any) -> dict[str, Any]:
    """The body Mattermost posts when the activity button is pressed."""
    context = activity_action(_key(), CALLBACK_URL, channel)["integration"]["context"]
    return _body(context, channel_id=channel, **overrides)


def _buttons(post: dict[str, Any]) -> list[dict[str, Any]]:
    attachments = (post.get("props") or {}).get("attachments") or []
    return [action for attachment in attachments for action in attachment["actions"]]


def _shown(answer: dict[str, Any]) -> str:
    text = answer.get("ephemeral_text")
    assert isinstance(text, str)
    return text


# ── What the status post offers ──────────────────────────────────────────────


async def test_a_turns_status_post_carries_the_way_into_its_tool_calls() -> None:
    adapter, _ = _viewer()

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    assert [button["name"] for button in _buttons(_posts(adapter).created[0])] == [
        ACTIVITY_LABEL
    ]


async def test_the_button_is_addressed_to_this_bridges_own_callback_url() -> None:
    adapter, _ = _viewer()

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    button = _buttons(_posts(adapter).created[0])[0]
    assert button["integration"]["url"] == CALLBACK_URL
    assert button["id"] == ACTIVITY_ACTION_ID


async def test_the_button_carries_the_channel_and_a_signature_and_nothing_else() -> (
    None
):
    """No session id, no turn id, no card token. Which turn is being asked
    about is the post the press arrives on, and the server names that."""
    adapter, _ = _viewer()

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    context = _buttons(_posts(adapter).created[0])[0]["integration"]["context"]
    assert set(context) == {CONTEXT_KEY}
    assert set(context[CONTEXT_KEY]) == {"channel", "signature"}
    assert context[CONTEXT_KEY]["channel"] == CHANNEL


async def test_a_running_turn_is_offered_it_as_readily_as_a_finished_one() -> None:
    """The log is read when the press arrives rather than drawn into the post,
    so a running turn's is exactly as current as an ended turn's."""
    adapter, _ = _viewer()

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")
    await adapter.post_rich(
        CHANNEL,
        "worker",
        TurnActivity([_item(title="Ran the tests")], _turn("completed")),
        "root-1",
    )

    assert all(_buttons(post) for post in _posts(adapter).created)


async def test_the_attention_message_is_left_to_say_its_one_thing() -> None:
    """A message whose whole job is "somebody has to act" does not want a
    control under it inviting the reader somewhere else."""
    adapter, _ = _viewer()

    await adapter.post_rich(
        CHANNEL, "worker", _activity(error_summary="The session stopped."), "root-1"
    )

    assert _buttons(_posts(adapter).created[0]) == []


async def test_a_bridge_that_cannot_answer_the_question_does_not_ask_it() -> None:
    """A publisher is what knows which turn a post is showing. Without one the
    button would be drawn onto a question nobody can resolve."""
    adapter = _adapter()
    _record(adapter)

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    assert _buttons(_posts(adapter).created[0]) == []


async def test_a_bridge_with_no_callback_address_draws_no_button() -> None:
    adapter, _ = _viewer(callback_base_url=None)

    await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")

    assert _buttons(_posts(adapter).created[0]) == []


async def test_a_request_card_gets_its_options_and_not_this() -> None:
    adapter, _ = _viewer()

    await adapter.post_rich(CHANNEL, "worker", await _card(), "root-1")

    names = [button["name"] for button in _buttons(_posts(adapter).created[0])]
    assert ACTIVITY_LABEL not in names
    assert names == ["1. Allow once", "2. Deny"]


async def test_redrawing_a_turn_leaves_the_button_where_it_was() -> None:
    """The action is the same on every status post in a channel, so a redraw
    has nothing to say about it. Patching props anyway would mean reading the
    post back on every tool call, which is the hottest path this bridge has."""
    adapter, _ = _viewer()

    ref = await adapter.post_rich(CHANNEL, "worker", _activity(), "root-1")
    await adapter.update_rich(CHANNEL, "worker", ref, _activity(), "root-1")

    patched = _posts(adapter).patched[0][1]
    assert "props" not in patched
    assert _buttons(_posts(adapter).stored[ref])


# ── Reading the press ────────────────────────────────────────────────────────


async def test_the_read_is_made_against_the_post_the_server_names() -> None:
    adapter, asked = _viewer()

    await adapter._handle_callback(_press())

    assert asked == [(CHANNEL, POST)]


async def test_a_press_for_the_log_never_reaches_the_answer_path() -> None:
    """The two buttons share a route and a signing key, and mean entirely
    different things. Nothing about a read may land as an answer."""
    adapter = _adapter()
    seen = _record(adapter)
    _channels(adapter).members[CHANNEL] = {USER}
    _resolving(adapter, _snapshot())

    await adapter._handle_callback(_press())

    assert seen == []


async def test_an_answer_press_is_still_an_answer() -> None:
    adapter, asked = _viewer()
    seen = _record(adapter)

    await adapter._handle_callback(_body(action_context(_key(), TOKEN, 2)))

    assert asked == []
    assert [interaction.value for interaction in seen] == [TOKEN]


async def test_a_context_minted_for_another_channel_is_refused() -> None:
    """The signature binds the button to one conversation. A context lifted
    onto a post somewhere else is not resolved against either."""
    adapter, asked = _viewer()

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(
            _body(
                activity_action(_key(), CALLBACK_URL, OTHER_CHANNEL)["integration"][
                    "context"
                ],
                channel_id=CHANNEL,
            )
        )

    assert asked == []


async def test_a_context_signed_by_another_bridge_is_refused() -> None:
    adapter, asked = _viewer()

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(
            _body(
                activity_action(_key("bridge-2"), CALLBACK_URL, CHANNEL)["integration"][
                    "context"
                ]
            )
        )

    assert asked == []


async def test_an_unsigned_request_for_a_log_is_not_a_press() -> None:
    """The route is reachable by anything that can reach the port."""
    adapter, asked = _viewer()

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(_body({CONTEXT_KEY: {"channel": CHANNEL}}))

    assert asked == []


async def test_a_field_beside_what_was_signed_voids_the_whole_context() -> None:
    """The signature covers the channel. A reader added later would be reading
    an unsigned value out of a context that looks authentic."""
    adapter, asked = _viewer()
    context = activity_action(_key(), CALLBACK_URL, CHANNEL)["integration"]["context"]
    context[CONTEXT_KEY]["post"] = "post-somewhere-else"

    with pytest.raises(CallbackRefused):
        await adapter._handle_callback(_body(context))

    assert asked == []


# ── What the reader gets ─────────────────────────────────────────────────────


async def test_the_log_comes_back_to_the_presser_and_not_to_the_channel() -> None:
    adapter, _ = _viewer()

    answer = await adapter._handle_callback(_press())

    assert "Ran the tests — 42 passed" in _shown(answer)
    assert _posts(adapter).created == []
    assert _posts(adapter).patched == []


async def test_the_log_is_the_calls_oldest_first_under_the_state_line() -> None:
    adapter, _ = _viewer()

    lines = _shown(await adapter._handle_callback(_press())).splitlines()

    assert lines[1:3] == ["⌗ ✓ Read config.toml", "⌗ ✓ Ran the tests — 42 passed"]


async def test_the_log_carries_what_the_agent_said_as_well_as_what_it_did() -> None:
    """Prose the agent produced beside its work never reached this channel at
    all — the reply is posted on its own and the rest stayed in the session. It
    comes back here, privately, in the order the turn produced it."""
    adapter, _ = _viewer()
    _resolving(
        adapter,
        _snapshot(
            items=[
                _item(itemId="a", kind="tool-activity", title="Ran the tests"),
                _item(
                    itemId="b",
                    kind="assistant-message",
                    title="",
                    text="Both write to the same fixture user.",
                ),
            ]
        ),
    )

    lines = _shown(await adapter._handle_callback(_press())).splitlines()

    assert lines[1:3] == [
        "\u2317 \u2713 Ran the tests",
        "\u275d Both write to the same fixture user.",
    ]


async def test_the_state_line_carries_the_way_into_console() -> None:
    """The status post has the link too, but this reply is read on its own —
    an ephemeral message has no message above it."""
    adapter, _ = _viewer()

    assert CONSOLE_URL in _shown(await adapter._handle_callback(_press()))


async def test_it_says_when_the_read_behind_it_was_taken() -> None:
    """An ephemeral reply stays on screen until it is dismissed, and one left
    open for twenty minutes is not wrong but is not current either."""
    adapter, _ = _viewer()

    assert "12:34:56 UTC" in _shown(await adapter._handle_callback(_press()))


async def test_the_reply_is_sent_as_the_markdown_it_already_is() -> None:
    """Mattermost's Slack conversion is a second pass of markup rules over
    text the neutral renderer has already marked up."""
    adapter, _ = _viewer()

    assert (await adapter._handle_callback(_press()))["skip_slack_parsing"] is True


async def test_pressing_again_is_a_second_read_rather_than_a_second_copy() -> None:
    """That is the whole of the refresh story here: nothing is cached, and
    nothing on screen can be older than the press that put it there."""
    adapter, asked = _viewer()

    await adapter._handle_callback(_press())
    await adapter._handle_callback(_press())

    assert asked == [(CHANNEL, POST), (CHANNEL, POST)]


async def test_a_log_too_long_for_a_post_is_cut_rather_than_refused() -> None:
    """Mattermost rejects a post over its size, and a reply it rejects is a
    button that does nothing."""
    adapter, _ = _viewer()
    _resolving(
        adapter,
        _snapshot(
            items=[
                _item(itemId=f"i{n}", kind="tool-activity", title=f"Call {n}")
                for n in range(400)
            ]
        ),
    )

    shown = _shown(await adapter._handle_callback(_press()))

    assert len(shown) <= adapter.rich_fallback_limit()
    assert "not shown." in shown
    assert shown.splitlines()[-2] == "⌗ ✓ Call 399"


async def test_what_a_host_called_a_tool_cannot_address_the_channel() -> None:
    """A tool title is host text, and it goes through the same defusing here as
    it does in the status post it was read from — an ephemeral reply is still a
    message Mattermost renders, and a mention in one still notifies."""
    adapter, _ = _viewer()
    _resolving(
        adapter, _snapshot(items=[_item(itemId="a", title="Paged @channel twice")])
    )

    shown = _shown(await adapter._handle_callback(_press()))

    assert "@channel" not in shown
    assert "Paged @\u200bchannel twice" in shown


# ── Who may read it ──────────────────────────────────────────────────────────


async def test_someone_who_is_not_in_the_channel_is_told_rather_than_shown() -> None:
    """And told the fact that was established. Mattermost answered "not a
    member", which on an open channel is not the same as "cannot read" — a
    reader who has never joined one can still read every word in it."""
    adapter, asked = _viewer(member_of=None)

    answer = await adapter._handle_callback(_press())

    assert _shown(answer) == ACTIVITY_NOT_A_MEMBER
    assert asked == []


async def test_the_question_is_asked_of_mattermost_on_every_press() -> None:
    """A press establishes that the server accepted it, which is not a
    statement about what the presser may read now."""
    adapter, _ = _viewer()

    await adapter._handle_callback(_press())
    await adapter._handle_callback(_press())

    assert _channels(adapter).calls == [(CHANNEL, USER), (CHANNEL, USER)]


async def test_a_membership_lookup_that_cannot_answer_refuses(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """ "Mattermost did not say" is not "yes" — and it is not "you cannot read
    this" either. Nothing was established about the reader, so the refusal
    stands without telling them it was their doing."""
    adapter, asked = _viewer()
    _channels(adapter).error = RuntimeError("the server is down")

    with caplog.at_level(logging.WARNING):
        answer = await adapter._handle_callback(_press())

    assert _shown(answer) == ACTIVITY_AUDIENCE_UNKNOWN
    assert asked == []
    assert "would not say whether" in caplog.text


async def test_a_channel_this_bridge_may_not_inspect_is_one_it_will_not_disclose(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An audience that cannot be established is not an empty one, but it is
    not one anything should be shown to either.

    It says nothing about the presser — the bridge's own admin account is what
    was refused — so the reader is not told they are outside a channel nobody
    checked them against, and the operator is told, because a bridge that
    cannot see its own channels is misconfigured rather than idle.
    """
    adapter, _ = _viewer()
    _channels(adapter).error = NotEnoughPermissions("not allowed")

    with caplog.at_level(logging.WARNING):
        answer = await adapter._handle_callback(_press())

    assert _shown(answer) == ACTIVITY_AUDIENCE_UNKNOWN
    assert "will not let this bridge see who is in channel" in caplog.text


async def test_a_bridge_that_is_not_connected_shows_nobody_anything() -> None:
    adapter, _ = _viewer()
    adapter._admin_driver = None

    assert _shown(await adapter._handle_callback(_press())) == ACTIVITY_AUDIENCE_UNKNOWN


# ── When there is nothing to show ────────────────────────────────────────────


async def test_a_post_showing_no_turn_says_so_rather_than_nothing() -> None:
    """A button that answers with nothing reads as the press having been
    dropped, and the reader goes on pressing it."""
    adapter, _ = _viewer()
    _resolving(adapter, None)

    assert _shown(await adapter._handle_callback(_press())) == ACTIVITY_GONE


async def test_a_bridge_with_no_publisher_says_so_without_calling_it_gone(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Reachable only for a post whose button was drawn when there was one, so
    it is a card outliving the bridge that drew it. The turn is untouched and
    Switch Console can still open it — this end is what cannot reach it, and
    saying "gone" would retire a session that is running."""
    adapter = _adapter()
    _record(adapter)
    _channels(adapter).members[CHANNEL] = {USER}

    with caplog.at_level(logging.WARNING):
        shown = _shown(await adapter._handle_callback(_press()))

    assert shown == ACTIVITY_FAILED
    assert any("nothing to read the log with" in r.getMessage() for r in caplog.records)


async def test_a_read_that_fails_tells_the_reader_instead_of_hanging(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = _viewer()
    _resolving(adapter, RuntimeError("the database went away"))

    with caplog.at_level(logging.ERROR):
        answer = await adapter._handle_callback(_press())

    assert _shown(answer) == ACTIVITY_FAILED
    assert "failed, so the reader is told" in caplog.text
