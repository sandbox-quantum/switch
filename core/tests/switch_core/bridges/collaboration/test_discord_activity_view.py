"""Reading a Discord turn's tool calls without posting them to the channel.

Slack prints the per-call log beside the status. Discord's status is three
lines and has nowhere to put one, so the log sits behind a button and opens as
an ephemeral message: the same content, read by one person instead of by a
channel.

What that costs is an authority question the public post never had to ask.
A press names a message; the log behind it belongs to whatever conversation
that message is in; and the only party who knows whether this particular
account can still read that conversation is Discord. So every press — the first
and every refresh — resolves the conversation the reference names and
re-authorises the presser against it, never against the one the press happened
to arrive from.

The other half is that a refresh must not be able to reach the public message.
Discord's update callback rewrites whatever message the component was attached
to, so the guard is the message, not the id: a refresh is answered only where
it arrived on an ephemeral one.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.adapter import ActivitySnapshot
from switch_core.bridges.collaboration.discord.adapter import (
    _ACTIVITY_FAILED,
    _ACTIVITY_GONE,
    _ACTIVITY_LABEL,
    _ACTIVITY_UNREADABLE,
    _ACTIVITY_VIEW_ID,
    _CONSOLE_LABEL,
    _MAX_BUTTON_LABEL,
    _MAX_CUSTOM_ID,
    _REFRESH_LABEL,
    DiscordAdapter,
    _refresh_id,
)

from .test_discord_sdk_only import (
    CHANNEL_ID,
    DM_CHANNEL_ID,
    GUILD_ID,
    ROOT_MESSAGE_ID,
    _activity,
    _adapter,
    _Channel,
    _DMChannel,
    _Guild,
    _guild_setup,
    _http_error,
    _Thread,
)
from .test_session_activity import _item, _turn

READER_ID = 8181
OTHER_READER_ID = 8282
STATUS_MESSAGE_ID = 4004
PRIVATE_THREAD_ID = 700
CONSOLE_URL = "https://console.example.test/sessions/s-1"


# ── Fakes ────────────────────────────────────────────────────────────────────


class _Permissions:
    def __init__(
        self,
        *,
        view_channel: bool = True,
        read_message_history: bool = True,
        manage_threads: bool = False,
    ) -> None:
        self.view_channel = view_channel
        self.read_message_history = read_message_history
        self.manage_threads = manage_threads


class _Member:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class _Reader:
    def __init__(self, user_id: int = READER_ID) -> None:
        self.id = user_id
        self.name = "kim"


class _PeopledGuild(_Guild):
    """A guild that can be asked who somebody is, which is the whole of what
    the permission check needs from it."""

    def __init__(self, members: set[int]) -> None:
        super().__init__()
        self.members = members
        self.fetched: list[int] = []

    def get_member(self, user_id: int) -> _Member | None:
        return _Member(user_id) if user_id in self.members else None

    async def fetch_member(self, user_id: int) -> _Member:
        self.fetched.append(user_id)
        if user_id in self.members:
            return _Member(user_id)
        raise discord.NotFound(_HTTPResponse(), "no such member")  # type: ignore[arg-type]


class _HTTPResponse:
    status = 404
    reason = "Not Found"
    headers: dict[str, str] = {}


class _PeopledDM(_DMChannel):
    """A channel outside any guild that can say who is in it.

    The real thing carries `recipient` for a direct channel and `recipients`
    for a group one; the bare `_DMChannel` the other Discord tests share
    carries neither, which is the third case — a channel nothing can be
    established about.
    """

    def __init__(self, *recipients: int) -> None:
        super().__init__()
        self.recipients = [_Member(user_id) for user_id in recipients]


class _ReadableChannel(_Channel):
    """A guild channel that answers what a given member may do in it."""

    def __init__(
        self,
        channel_id: int,
        guild: _PeopledGuild,
        permissions: _Permissions | None = None,
    ) -> None:
        super().__init__(channel_id, guild=guild)
        self.permissions = permissions if permissions is not None else _Permissions()

    def permissions_for(self, member: Any) -> _Permissions:
        return self.permissions


class _ReadableThread(_Thread):
    """A public thread: everyone who may read the parent may read this."""

    def __init__(
        self,
        parent: _ReadableChannel,
        thread_id: int = ROOT_MESSAGE_ID,
        *,
        permissions: _Permissions | None = None,
    ) -> None:
        super().__init__(parent, thread_id)
        self.permissions = permissions if permissions is not None else _Permissions()

    def permissions_for(self, member: Any) -> _Permissions:
        return self.permissions


class _PrivateThread(_ReadableThread):
    """A private thread: visible to everyone who can see the parent, readable
    only by the accounts actually added to it."""

    def __init__(
        self,
        parent: _ReadableChannel,
        thread_id: int = PRIVATE_THREAD_ID,
        *,
        members: set[int] | None = None,
        permissions: _Permissions | None = None,
    ) -> None:
        super().__init__(parent, thread_id, permissions=permissions)
        self.thread_members = members if members is not None else set()

    def is_private(self) -> bool:
        return True

    async def fetch_member(self, user_id: int) -> object:
        if user_id not in self.thread_members:
            raise discord.NotFound(_HTTPResponse(), "not in this thread")  # type: ignore[arg-type]
        return object()


class _Flags:
    def __init__(self, ephemeral: bool) -> None:
        self.ephemeral = ephemeral


class _PressedMessage:
    def __init__(self, message_id: int, *, ephemeral: bool = False) -> None:
        self.id = message_id
        self.flags = _Flags(ephemeral)


class _InteractionResponse:
    def __init__(self) -> None:
        self.defers: list[dict[str, Any]] = []
        self.error: Exception | None = None

    async def defer(self, **kwargs: Any) -> None:
        if self.error is not None:
            raise self.error
        self.defers.append(kwargs)


class _Press:
    """What the gateway hands a listener when an activity button is operated."""

    def __init__(
        self,
        custom_id: str,
        *,
        channel: Any,
        message: Any,
        user: _Reader | None = None,
    ) -> None:
        self.type = discord.InteractionType.component
        self.guild_id = None if getattr(channel, "guild", None) is None else GUILD_ID
        self.data: dict[str, Any] = {"custom_id": custom_id, "component_type": 2}
        self.channel = channel
        self.message = message
        self.user = user if user is not None else _Reader()
        self.response = _InteractionResponse()
        self.shown: list[dict[str, Any]] = []
        self.edit_error: Exception | None = None

    async def edit_original_response(self, **kwargs: Any) -> None:
        if self.edit_error is not None:
            raise self.edit_error
        self.shown.append(kwargs)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _snapshot(**fields: Any) -> ActivitySnapshot:
    items = [
        _item(itemId="a", title="Read config.toml", status="completed"),
        _item(itemId="b", title="Ran the tests", text="42 passed", status="completed"),
    ]
    defaults: dict[str, Any] = {
        "items": items,
        "turn": _turn("completed"),
        "elapsed_seconds": 12.0,
        "session_url": CONSOLE_URL,
        "read_at": datetime(2026, 9, 16, 12, 0, tzinfo=UTC),
    }
    return ActivitySnapshot(**{**defaults, **fields})


def _resolving(adapter: DiscordAdapter, answer: Any = None) -> list[tuple[str, str]]:
    """Give `adapter` something to resolve a press against, and record the asks.

    `answer` is what every read returns — a snapshot, None for a message showing
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


def _buttons(payload: dict[str, Any]) -> list[tuple[str, str | None, str | None]]:
    """Every button in a send, edit or private view, as (label, id, url)."""
    view = payload.get("view")
    if view is None:
        return []
    return [(item.label, item.custom_id, item.url) for item in view.children]


def _shown(press: _Press) -> str:
    assert len(press.shown) == 1
    return str(press.shown[0]["content"])


def _guild_with(members: set[int]) -> tuple[DiscordAdapter, _ReadableChannel]:
    """An adapter whose one channel `members` can read, with a resolver wired."""
    guild = _PeopledGuild(members)
    channel = _ReadableChannel(CHANNEL_ID, guild)
    adapter = _adapter({CHANNEL_ID: channel})
    return adapter, channel


def _status_press(channel: Any) -> _Press:
    return _Press(
        _ACTIVITY_VIEW_ID,
        channel=channel,
        message=_PressedMessage(STATUS_MESSAGE_ID),
    )


def _refresh_press(channel: Any, ref: str, *, ephemeral: bool = True) -> _Press:
    return _Press(
        f"swact:r:{ref}",
        channel=channel,
        message=_PressedMessage(9999, ephemeral=ephemeral),
    )


# ── What a status offers ─────────────────────────────────────────────────────


async def test_a_status_offers_the_way_into_the_log_it_does_not_print() -> None:
    """The button carries no identifier. Which turn it is about is the message
    it arrives on, which Discord fills in and a client cannot write."""
    adapter, _channel, _thread, webhook = _guild_setup()
    _resolving(adapter, _snapshot())

    await adapter.post_rich(
        str(CHANNEL_ID), "my-agent", _activity(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    assert _buttons(webhook.sent[0]) == [(_ACTIVITY_LABEL, _ACTIVITY_VIEW_ID, None)]


async def test_no_button_where_nothing_can_answer_the_press() -> None:
    """A bridge publishing no sessions has nothing that knows which turn a
    message is showing, so a button on it would be a question with no reader."""
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.post_rich(
        str(CHANNEL_ID), "my-agent", _activity(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    assert _buttons(webhook.sent[0]) == []


async def test_the_attention_slot_offers_nothing_but_the_thing_it_asks_for() -> None:
    """That message is one sentence saying somebody has to act. A control under
    it about tool calls is an invitation away from it."""
    adapter, _channel, _thread, webhook = _guild_setup()
    _resolving(adapter, _snapshot())

    await adapter.post_rich(
        str(CHANNEL_ID),
        "my-agent",
        replace(_activity(), error_summary="The session needs attention."),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
    )

    assert _buttons(webhook.sent[0]) == []


async def test_the_button_survives_a_redraw_without_being_remembered() -> None:
    """Every redraw builds the view again from the content, so a button after a
    restart is the same button — nothing in this process is holding it."""
    adapter, _channel, _thread, webhook = _guild_setup()
    _resolving(adapter, _snapshot())

    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{ROOT_MESSAGE_ID}:901", _activity(), None
    )

    assert _buttons(webhook.edits[0]) == [(_ACTIVITY_LABEL, _ACTIVITY_VIEW_ID, None)]


# ── The private copy ─────────────────────────────────────────────────────────


async def test_a_press_opens_a_private_copy_nobody_else_is_shown() -> None:
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert press.response.defers == [{"ephemeral": True, "thinking": True}]
    assert asked == [(str(CHANNEL_ID), f"{CHANNEL_ID}:{STATUS_MESSAGE_ID}")]
    assert "Ran the tests" in _shown(press)
    assert channel.sent == []


async def test_two_readers_get_their_own_snapshot_of_the_same_message() -> None:
    """Independent private copies, not a shared one: each press is answered in
    the response Discord opened for it."""
    adapter, channel = _guild_with({READER_ID, OTHER_READER_ID})
    _resolving(adapter, _snapshot())
    first = _status_press(channel)
    second = _Press(
        _ACTIVITY_VIEW_ID,
        channel=channel,
        message=_PressedMessage(STATUS_MESSAGE_ID),
        user=_Reader(OTHER_READER_ID),
    )

    await adapter._handle_interaction(first)  # type: ignore[arg-type]
    await adapter._handle_interaction(second)  # type: ignore[arg-type]

    assert len(first.shown) == 1
    assert len(second.shown) == 1
    assert channel.sent == []


async def test_the_private_copy_carries_refresh_and_the_console_link() -> None:
    adapter, channel = _guild_with({READER_ID})
    _resolving(adapter, _snapshot())
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _buttons(press.shown[0]) == [
        (_REFRESH_LABEL, f"swact:r:{CHANNEL_ID}:{STATUS_MESSAGE_ID}", None),
        (_CONSOLE_LABEL, None, CONSOLE_URL),
    ]


async def test_the_copy_says_when_it_was_read_so_a_stale_one_admits_it() -> None:
    """Discord's own relative stamp, which the client ages without anything
    here refreshing it."""
    adapter, channel = _guild_with({READER_ID})
    read_at = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    _resolving(adapter, _snapshot(read_at=read_at))
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert f"Read <t:{int(read_at.timestamp())}:R>" in _shown(press)


# ── Refresh ──────────────────────────────────────────────────────────────────


async def test_a_refresh_rereads_and_rewrites_the_same_private_copy() -> None:
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    ref = f"{CHANNEL_ID}:{STATUS_MESSAGE_ID}"
    press = _refresh_press(channel, ref)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert press.response.defers == [{}]
    assert asked == [(str(CHANNEL_ID), ref)]
    assert len(press.shown) == 1
    assert channel.sent == []


async def test_a_refresh_on_a_public_message_is_refused_before_it_is_answered(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An update rewrites whatever message the component was on, so a press
    carrying this id from a channel message would turn a status into a log."""
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    press = _refresh_press(
        channel, f"{CHANNEL_ID}:{STATUS_MESSAGE_ID}", ephemeral=False
    )

    with caplog.at_level(logging.WARNING):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert press.response.defers == []
    assert press.shown == []
    assert asked == []
    assert any("would rewrite that message" in r.getMessage() for r in caplog.records)


async def test_a_refresh_naming_nothing_readable_is_ignored() -> None:
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    press = _Press(
        "swact:r:", channel=channel, message=_PressedMessage(9999, ephemeral=True)
    )

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert press.response.defers == []
    assert asked == []


async def test_a_reference_that_is_not_an_address_is_told_there_is_nothing() -> None:
    """The reference comes off a client, so a malformed one is an ordinary
    answer rather than a fault — but it is still an answer."""
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    press = _refresh_press(channel, "not-an-address")

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert _shown(press) == _ACTIVITY_GONE


# ── Who may read it ──────────────────────────────────────────────────────────


async def test_a_reader_who_has_lost_the_channel_is_told_rather_than_shown() -> None:
    adapter, channel = _guild_with({READER_ID})
    channel.permissions = _Permissions(view_channel=False)
    asked = _resolving(adapter, _snapshot())
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert _shown(press) == _ACTIVITY_UNREADABLE


async def test_a_reader_who_cannot_read_the_history_is_refused_too() -> None:
    """A turn's log is history. Seeing the channel exist is not reading it."""
    adapter, channel = _guild_with({READER_ID})
    channel.permissions = _Permissions(read_message_history=False)
    _resolving(adapter, _snapshot())
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_UNREADABLE


async def test_someone_who_has_left_the_guild_is_refused() -> None:
    adapter, channel = _guild_with(set())
    _resolving(adapter, _snapshot())
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_UNREADABLE


async def test_a_private_thread_asks_for_membership_not_visibility() -> None:
    """Everyone who can see the parent passes the channel check. Only the
    thread's own membership says who is actually in it."""
    guild = _PeopledGuild({READER_ID})
    parent = _ReadableChannel(CHANNEL_ID, guild)
    thread = _PrivateThread(parent, members=set())
    adapter = _adapter({CHANNEL_ID: parent, PRIVATE_THREAD_ID: thread})
    asked = _resolving(adapter, _snapshot())
    press = _Press(
        _ACTIVITY_VIEW_ID, channel=thread, message=_PressedMessage(STATUS_MESSAGE_ID)
    )

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert _shown(press) == _ACTIVITY_UNREADABLE


async def test_a_member_of_that_thread_is_shown_it() -> None:
    guild = _PeopledGuild({READER_ID})
    parent = _ReadableChannel(CHANNEL_ID, guild)
    thread = _PrivateThread(parent, members={READER_ID})
    adapter = _adapter({CHANNEL_ID: parent, PRIVATE_THREAD_ID: thread})
    asked = _resolving(adapter, _snapshot())
    press = _Press(
        _ACTIVITY_VIEW_ID, channel=thread, message=_PressedMessage(STATUS_MESSAGE_ID)
    )

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == [(str(CHANNEL_ID), f"{PRIVATE_THREAD_ID}:{STATUS_MESSAGE_ID}")]
    assert "Ran the tests" in _shown(press)


async def test_a_refresh_is_authorised_against_the_thread_its_reference_names() -> None:
    """The hole this closes: a reference is a locator the presser supplied, so
    authorising it against the conversation the press arrived from would let a
    public thread's permissions open the private thread beside it."""
    guild = _PeopledGuild({READER_ID})
    parent = _ReadableChannel(CHANNEL_ID, guild)
    public = _ReadableThread(parent, ROOT_MESSAGE_ID)
    private = _PrivateThread(parent, PRIVATE_THREAD_ID, members=set())
    adapter = _adapter(
        {CHANNEL_ID: parent, ROOT_MESSAGE_ID: public, PRIVATE_THREAD_ID: private}
    )
    asked = _resolving(adapter, _snapshot())
    press = _refresh_press(public, f"{PRIVATE_THREAD_ID}:{STATUS_MESSAGE_ID}")

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert _shown(press) == _ACTIVITY_UNREADABLE


async def test_a_destination_nobody_can_ask_about_is_refused_not_assumed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Not having been able to check is not the same as having checked."""
    guild = _PeopledGuild({READER_ID})
    channel = _Channel(CHANNEL_ID, guild=guild)
    adapter = _adapter({CHANNEL_ID: channel})
    _resolving(adapter, _snapshot())
    press = _status_press(channel)

    with caplog.at_level(logging.WARNING):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_UNREADABLE
    assert any(
        "Cannot establish who may read" in r.getMessage() for r in caplog.records
    )


async def test_a_channel_outside_a_guild_is_read_by_whoever_is_in_it() -> None:
    dm = _PeopledDM(READER_ID)
    adapter = _adapter({DM_CHANNEL_ID: dm})
    asked = _resolving(adapter, _snapshot())
    press = _status_press(dm)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == [(str(DM_CHANNEL_ID), f"{DM_CHANNEL_ID}:{STATUS_MESSAGE_ID}")]
    assert "Ran the tests" in _shown(press)


async def test_someone_not_in_that_channel_is_refused_it() -> None:
    """There are no permissions to consult outside a guild, so membership is
    the whole of the check. A branch that answered yes for want of anything to
    ask would be the one place an address could be steered into."""
    dm = _PeopledDM(OTHER_READER_ID)
    adapter = _adapter({DM_CHANNEL_ID: dm})
    asked = _resolving(adapter, _snapshot())
    press = _status_press(dm)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert _shown(press) == _ACTIVITY_UNREADABLE


async def test_a_channel_that_cannot_say_who_is_in_it_is_refused(
    caplog: pytest.LogCaptureFixture,
) -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    _resolving(adapter, _snapshot())
    press = _status_press(dm)

    with caplog.at_level(logging.WARNING):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_UNREADABLE
    assert any("Cannot establish who is in" in r.getMessage() for r in caplog.records)


# ── When there is nothing to show ────────────────────────────────────────────


async def test_a_message_showing_no_turn_says_so_rather_than_nothing() -> None:
    """A button that answers silently reads as Discord having dropped the
    press, and the reader goes on pressing it."""
    adapter, channel = _guild_with({READER_ID})
    _resolving(adapter, None)
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_GONE


async def test_a_reference_to_a_channel_discord_will_not_name_says_so() -> None:
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    press = _refresh_press(channel, f"{CHANNEL_ID + 1}:{STATUS_MESSAGE_ID}")

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert _shown(press) == _ACTIVITY_GONE


async def test_a_read_that_fails_is_reported_to_the_reader_and_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, channel = _guild_with({READER_ID})
    _resolving(adapter, RuntimeError("the database went away"))
    press = _status_press(channel)

    with caplog.at_level(logging.ERROR):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_FAILED
    assert any(
        "failed, so the reader is told" in r.getMessage() for r in caplog.records
    )


async def test_a_press_discord_will_not_let_us_acknowledge_reads_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Three seconds is the whole budget, and a press that misses it is one
    Discord has already told the presser failed."""
    adapter, channel = _guild_with({READER_ID})
    asked = _resolving(adapter, _snapshot())
    press = _status_press(channel)
    press.response.error = _http_error(404)

    with caplog.at_level(logging.ERROR):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert asked == []
    assert press.shown == []
    assert any("not acknowledged in time" in r.getMessage() for r in caplog.records)


async def test_an_edit_discord_refuses_is_logged_rather_than_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing downstream is waiting on this: the press is already
    acknowledged, and an expired token cannot be retried into."""
    adapter, channel = _guild_with({READER_ID})
    _resolving(adapter, _snapshot())
    press = _status_press(channel)
    press.edit_error = _http_error(404)

    with caplog.at_level(logging.WARNING):
        await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert any(
        "would not carry the activity view" in r.getMessage() for r in caplog.records
    )


# ── What the copy contains ───────────────────────────────────────────────────


async def test_a_long_log_says_how_much_of_itself_it_is_not_showing() -> None:
    """The cut is at the newest end's expense last: a log that quietly showed
    its tail reads as a turn that only made those calls."""
    adapter, channel = _guild_with({READER_ID})
    items = [
        _item(itemId=f"i{index}", title=f"Call {index} " + "x" * 300)
        for index in range(60)
    ]
    _resolving(adapter, _snapshot(items=items))
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    text = _shown(press)
    assert "earlier in this turn, not shown." in text
    assert "Call 59" in text
    assert len(text) <= 2000


async def test_a_turn_with_no_tool_calls_says_that_too() -> None:
    adapter, channel = _guild_with({READER_ID})
    _resolving(adapter, _snapshot(items=[]))
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert "No tool calls." in _shown(press)


async def test_a_turn_with_no_console_link_offers_only_refresh() -> None:
    adapter, channel = _guild_with({READER_ID})
    _resolving(adapter, _snapshot(session_url=None))
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _buttons(press.shown[0]) == [
        (_REFRESH_LABEL, f"swact:r:{CHANNEL_ID}:{STATUS_MESSAGE_ID}", None)
    ]


async def test_an_unpublished_bridge_answers_a_stale_button_rather_than_hanging() -> (
    None
):
    """Old buttons outlive the process that drew them, and a restart that no
    longer publishes sessions must not leave them pressing into silence."""
    adapter, channel = _guild_with({READER_ID})
    press = _status_press(channel)

    await adapter._handle_interaction(press)  # type: ignore[arg-type]

    assert _shown(press) == _ACTIVITY_GONE


def test_the_activity_ids_fit_what_discord_carries() -> None:
    """A custom id Discord will not accept is a button that never arrives, and
    a snowflake is as long as a snowflake gets."""
    assert len(_ACTIVITY_VIEW_ID) <= _MAX_CUSTOM_ID
    assert len(_refresh_id(f"{2**64 - 1}:{2**64 - 1}")) <= _MAX_CUSTOM_ID
    assert len(_ACTIVITY_LABEL) <= _MAX_BUTTON_LABEL
    assert len(_REFRESH_LABEL) <= _MAX_BUTTON_LABEL
    assert len(_CONSOLE_LABEL) <= _MAX_BUTTON_LABEL
