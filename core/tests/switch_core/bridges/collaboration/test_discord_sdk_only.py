"""Discord publishes SDK sessions, and the legacy renderer no longer runs.

What is under test here is the rich-content seam: the compact status and the
plain-text request card, posted under the agent's own webhook identity, edited
in place, taken down at the end of a turn where a thread is not holding it,
found again after an uncertain delivery, and loud when any of that fails.

There is no longer a second renderer anywhere to fall back to, so what the
publication draws is the whole of what a channel sees of a turn.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import discord
import pytest

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    ThreadUnavailable,
    TurnActivity,
)
from switch_core.bridges.collaboration.discord.adapter import (
    _PUBLICATION_WEBHOOK_NAME,
    _WEBHOOK_NAME,
    DiscordAdapter,
    DiscordConnectionConfig,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.session.transport import (
    FixtureEventSource,
    project,
)

from .test_session_activity import _item, _turn

REPO_ROOT = Path(__file__).resolve().parents[5]
EXAMPLES_PATH = REPO_ROOT / "console/packages/shared/src/session-v1/examples.json"

GUILD_ID = 900
CHANNEL_ID = 100
DM_CHANNEL_ID = 555
BOT_USER_ID = 42
WEBHOOK_ID = 77
PUBLICATION_WEBHOOK_ID = 78
ROOT_MESSAGE_ID = 321
ASKER_ID = "60606"


# ── Fakes ────────────────────────────────────────────────────────────────────


class _Response:
    def __init__(self) -> None:
        self.status = 400
        self.reason = "Bad Request"
        self.headers: dict[str, str] = {}


def _http_error(
    status: int, *, headers: dict[str, str] | None = None
) -> discord.HTTPException:
    response = _Response()
    response.status = status
    response.headers = headers if headers is not None else {}
    if status >= 500:
        return discord.DiscordServerError(response, "upstream")  # type: ignore[arg-type]
    return discord.HTTPException(response, "refused")  # type: ignore[arg-type]


class _Role:
    pass


class _Guild:
    def __init__(self) -> None:
        self.id = GUILD_ID
        self.default_role = _Role()


class _Overwrite:
    view_channel = True


class _Author:
    def __init__(self, user_id: int) -> None:
        self.id = user_id


class _Message:
    def __init__(self, channel: Any, message_id: int, content: str = "") -> None:
        self.id = message_id
        self.channel = channel
        self.content = content
        self.author = _Author(0)
        self.webhook_id: int | None = None
        self.edited: str | None = None
        self.deleted = False

    async def edit(self, *, content: str, **kwargs: Any) -> None:
        self.edited = content

    async def delete(self) -> None:
        self.deleted = True
        self.channel.deleted_ids.append(self.id)

    async def create_thread(self, *, name: str) -> Any:
        return self.channel.open_thread(self.id, name)


class _PartialMessage:
    def __init__(self, channel: Any, message_id: int) -> None:
        self.id = message_id
        self._channel = channel

    async def create_thread(self, *, name: str) -> Any:
        return self._channel.open_thread(self.id, name)

    async def delete(self) -> None:
        if self._channel.delete_error is not None:
            raise self._channel.delete_error
        self._channel.deleted_ids.append(self.id)

    async def add_reaction(self, emoji: str) -> None:
        if self._channel.reaction_error is not None:
            raise self._channel.reaction_error
        self._channel.reactions.append((emoji, True))

    async def remove_reaction(self, emoji: str, user: Any) -> None:
        if self._channel.reaction_error is not None:
            raise self._channel.reaction_error
        self._channel.reactions.append((emoji, False))


class _Channel:
    def __init__(self, channel_id: int = CHANNEL_ID, *, guild: Any | None = None):
        self.id = channel_id
        self.guild = guild if guild is not None else _Guild()
        self.name = "general"
        self.sent: list[dict[str, Any]] = []
        self.deleted_ids: list[int] = []
        self.reactions: list[tuple[str, bool]] = []
        self.reaction_error: Exception | None = None
        self.typing_count = 0
        self.messages: dict[int, _Message] = {}
        self.history_messages: list[_Message] = []
        self.history_error: Exception | None = None
        self.send_error: Exception | None = None
        self.delete_error: Exception | None = None
        self.fetch_error: Exception | None = None
        self.existing_webhooks: list[Any] = []
        self.webhook_error: Exception | None = None
        self.thread_error: Exception | None = None
        self.client: _Client | None = None

    def overwrites_for(self, role: Any) -> _Overwrite:
        return _Overwrite()

    def open_thread(self, message_id: int, name: str) -> Any:
        """Start a thread under one of this channel's messages.

        Discord gives the thread the message's own id, and the bridge relies on
        that everywhere, so the fake has to do the same — and has to make the
        new thread visible to the client, which is where the bridge looks for
        it next.
        """
        if self.thread_error is not None:
            raise self.thread_error
        thread = _Thread(self, message_id)
        if self.client is not None:
            self.client.add(thread)
        return thread

    async def send(self, content: str, **kwargs: Any) -> Any:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append({"content": content, **kwargs})
        message = _Message(self, 500 + len(self.sent), content)
        self.messages[message.id] = message
        return message

    async def typing(self) -> None:
        self.typing_count += 1

    async def fetch_message(self, message_id: int) -> _Message:
        if self.fetch_error is not None:
            raise self.fetch_error
        message = self.messages.get(message_id)
        if message is None:
            raise discord.NotFound(_Response(), "message not found")  # type: ignore[arg-type]
        return message

    def get_partial_message(self, message_id: int) -> _PartialMessage:
        return _PartialMessage(self, message_id)

    async def webhooks(self) -> list[Any]:
        if self.webhook_error is not None:
            raise self.webhook_error
        return self.existing_webhooks

    async def create_webhook(self, *, name: str) -> Any:
        webhook = _Webhook(name)
        self.existing_webhooks.append(webhook)
        return webhook

    def history(self, **kwargs: Any) -> Any:
        messages = list(self.history_messages)
        error = self.history_error

        class _History:
            def __aiter__(self) -> Any:
                return self

            async def __anext__(self) -> _Message:
                if error is not None:
                    raise error
                if not messages:
                    raise StopAsyncIteration
                return messages.pop(0)

        return _History()


class _DMChannel(_Channel):
    def __init__(self) -> None:
        super().__init__(DM_CHANNEL_ID, guild=None)
        self.guild = None

    async def webhooks(self) -> list[Any]:
        raise AssertionError("a DM channel has no webhooks")


class _Thread(_Channel):
    def __init__(self, parent: _Channel, thread_id: int = ROOT_MESSAGE_ID) -> None:
        super().__init__(thread_id, guild=parent.guild)
        self.parent = parent
        self.parent_id = parent.id


_WEBHOOK_IDS = {
    _WEBHOOK_NAME: WEBHOOK_ID,
    _PUBLICATION_WEBHOOK_NAME: PUBLICATION_WEBHOOK_ID,
}


class _Webhook:
    def __init__(self, name: str) -> None:
        self.id = _WEBHOOK_IDS[name]
        self.name = name
        self.token = "tok"
        self.sent: list[dict[str, Any]] = []
        self.edits: list[dict[str, Any]] = []
        self.deletes: list[dict[str, Any]] = []
        self.send_error: Exception | None = None
        self.edit_error: Exception | None = None
        self.delete_error: Exception | None = None

    async def send(self, **kwargs: Any) -> Any:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append(kwargs)
        thread = kwargs.get("thread")
        channel = thread if thread is not None else _Channel()
        return _Message(channel, 900 + len(self.sent), kwargs.get("content", ""))

    async def edit_message(self, message_id: int, **kwargs: Any) -> None:
        if self.edit_error is not None:
            raise self.edit_error
        self.edits.append({"message_id": message_id, **kwargs})

    async def delete_message(self, message_id: int, **kwargs: Any) -> None:
        if self.delete_error is not None:
            raise self.delete_error
        self.deletes.append({"message_id": message_id, **kwargs})


class _Client:
    def __init__(self, channels: dict[int, Any]) -> None:
        self._channels = channels
        self.user = object()
        # What Discord says instead of answering, keyed by channel id. A thread
        # the bot cannot open answers here, not with "unknown channel".
        self.fetch_errors: dict[int, Exception] = {}
        for channel in channels.values():
            channel.client = self

    def add(self, channel: Any) -> None:
        self._channels[channel.id] = channel
        channel.client = self

    def get_channel(self, channel_id: int) -> Any | None:
        return self._channels.get(channel_id)

    async def fetch_channel(self, channel_id: int) -> Any:
        error = self.fetch_errors.get(channel_id)
        if error is not None:
            raise error
        channel = self._channels.get(channel_id)
        if channel is None:
            raise discord.NotFound(_Response(), "unknown channel")  # type: ignore[arg-type]
        return channel


def _adapter(channels: dict[int, Any]) -> DiscordAdapter:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(GUILD_ID))
    )
    adapter._bot_user_id = BOT_USER_ID
    adapter._client = _Client(channels)  # type: ignore[assignment]
    return adapter


def _guild_setup() -> tuple[DiscordAdapter, _Channel, _Thread, _Webhook]:
    """A guild channel carrying both of the bridge's webhooks, and a thread.

    The publication webhook is the one returned, because everything here that
    inspects what was sent is inspecting a publication. The agents' webhook
    exists in every one of these channels for the same reason it does in a real
    one — and so that a test can post an agent's own words through it.
    """
    channel = _Channel()
    thread = _Thread(channel)
    adapter = _adapter({CHANNEL_ID: channel, ROOT_MESSAGE_ID: thread})
    channel.existing_webhooks = [
        _Webhook(_WEBHOOK_NAME),
        _Webhook(_PUBLICATION_WEBHOOK_NAME),
    ]
    return adapter, channel, thread, channel.existing_webhooks[1]


def _activity(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Looking now.")]
    return TurnActivity(items, _turn("running"), **kwargs)


def _ended(**kwargs: Any) -> TurnActivity:
    items = [_item(kind="assistant-message", title="", text="Done.")]
    return TurnActivity(items, _turn("completed"), **kwargs)


async def _card(**kwargs: Any) -> RequestCard:
    source = FixtureEventSource.from_examples(EXAMPLES_PATH, events=[])
    projection = await project(source, "session-demo")
    request = projection.open_requests()[0]
    return RequestCard(request, RequestReference(token="tok-1", handle="R7"), **kwargs)


# ── The publication is the only account of the turn ──────────────────────────


async def test_the_publication_is_the_only_account_of_a_turn() -> None:
    """There is no second renderer to fall back to, and `bridge_core` reads
    this flag to decide whether to route sessions here at all — so a platform
    that stopped declaring it would go quiet rather than draw the turn some
    other way."""
    adapter, _channel, _thread, _webhook = _guild_setup()

    assert adapter.publishes_sdk_sessions is True


def test_discord_names_the_asker_because_nothing_else_reaches_them() -> None:
    """A thread reply notifies only its members, and the asker is not one."""
    adapter, _channel, _thread, _webhook = _guild_setup()

    assert adapter.notifies_only_by_mention is True
    assert adapter.separate_attention_slot is True
    assert adapter.separate_activity_log is False
    assert adapter.supports_activity_reactions is True
    assert adapter.activity_reactions_per_agent is False


# ── Posting ──────────────────────────────────────────────────────────────────


async def test_a_turn_posts_into_its_thread_under_the_agents_own_identity() -> None:
    adapter, channel, thread, webhook = _guild_setup()

    ref = await adapter.post_rich(
        str(CHANNEL_ID), "my-agent", _activity(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    assert channel.sent == []
    assert webhook.sent[0]["username"] == "my-agent"
    assert webhook.sent[0]["thread"] is thread
    assert webhook.sent[0]["wait"] is True
    assert ref == f"{ROOT_MESSAGE_ID}:901"


async def test_a_card_names_the_asker_and_prints_the_handle_it_answers_to() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.post_rich(
        str(CHANNEL_ID),
        "my-agent",
        await _card(notify_external_id=ASKER_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
    )

    content = webhook.sent[0]["content"]
    assert content.startswith(f"<@{ASKER_ID}>\n")
    assert "request `R7`" in content


async def test_a_card_nobody_can_be_notified_about_says_so_on_the_card() -> None:
    """A card posted with the mention simply missing reads on the channel
    exactly like one that reached someone — an agent waiting on input nobody
    knows to give. The handle is the agent owner's linked account, so nobody to
    name means the owner has not said which account here is theirs, and the
    card says that instead of trailing off.
    """
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.post_rich(
        str(CHANNEL_ID),
        "my-agent",
        await _card(notify_unreachable=True),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
    )

    content = webhook.sent[0]["content"]
    assert "this notified no one" in content
    # Named as a person would name it, not as the class is.
    assert "Link your Discord account" in content
    assert "Adapter" not in content


async def test_a_dm_inlines_the_agent_name_because_there_is_no_webhook() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})

    ref = await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", _activity(), None)

    assert dm.sent[0]["content"].startswith("**my-agent**: ")
    assert ref == f"{DM_CHANNEL_ID}:501"


def _no_thread_yet() -> tuple[DiscordAdapter, _Channel, _Webhook]:
    """A channel whose root message has no reply thread hanging from it."""
    channel = _Channel()
    adapter = _adapter({CHANNEL_ID: channel})
    channel.existing_webhooks = [
        _Webhook(_WEBHOOK_NAME),
        _Webhook(_PUBLICATION_WEBHOOK_NAME),
    ]
    return adapter, channel, channel.existing_webhooks[1]


async def test_a_turn_opens_the_reply_thread_it_belongs_in() -> None:
    """The thread a turn is published into is the ordinary reply thread, and
    the first reply to a channel message is what makes it."""
    adapter, channel, webhook = _no_thread_yet()
    channel.messages[ROOT_MESSAGE_ID] = _Message(channel, ROOT_MESSAGE_ID, "do it")

    await adapter.post_rich(
        str(CHANNEL_ID), "my-agent", _activity(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    assert channel.sent == []
    assert webhook.sent[0]["thread"].id == ROOT_MESSAGE_ID


async def test_progress_is_suppressed_rather_than_spilled_into_the_channel() -> None:
    """The channel shows what the agent was asked and what it answers; a turn
    whose thread cannot be made does not get to narrate itself there instead."""
    adapter, channel, webhook = _no_thread_yet()
    channel.thread_error = discord.Forbidden(_Response(), "no Create Threads")  # type: ignore[arg-type]

    with pytest.raises(RichContentFailed):
        await adapter.post_rich(
            str(CHANNEL_ID), "my-agent", _activity(), f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
        )

    assert channel.sent == []
    assert webhook.sent == []


async def test_a_missing_thread_is_reported_and_not_replaced_by_the_channel() -> None:
    """A thread that is gone and one that was never made read the same here.

    Discord answers "no such channel" either way, and the second makes the
    parent channel the audience that was asked while the first makes it an
    audience that was not. Nothing this adapter can ask tells them apart, so it
    states the fact and leaves the choice to the caller that recorded where the
    command came from.
    """
    adapter, channel, webhook = _no_thread_yet()
    channel.thread_error = discord.NotFound(_Response(), "unknown message")  # type: ignore[arg-type]

    with pytest.raises(ThreadUnavailable):
        await adapter.post_rich(
            str(CHANNEL_ID),
            "my-agent",
            await _card(),
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        )

    assert channel.sent == []
    assert webhook.sent == []


async def test_a_thread_the_bot_cannot_open_never_becomes_the_whole_channel() -> None:
    """A private thread's request is not republished to its parent.

    A denied thread and an absent one look alike from outside, and only one of
    them is even a question the caller may answer. A request carries the
    agent's question and its options: handing that to the parent channel gives
    a private conversation an audience, and nothing takes it back.
    """
    adapter, channel, webhook = _no_thread_yet()
    client: Any = adapter._client
    client.fetch_errors[ROOT_MESSAGE_ID] = discord.Forbidden(  # type: ignore[arg-type]
        _Response(), "not a member of this thread"
    )

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(
            str(CHANNEL_ID),
            "my-agent",
            await _card(),
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        )

    # Not the absent-thread answer: a caller allowed to use the channel root
    # would take that as licence, and this thread is there and is not ours.
    assert not isinstance(raised.value, ThreadUnavailable)
    assert channel.sent == []
    assert webhook.sent == []


# ── Failure semantics ────────────────────────────────────────────────────────


async def test_a_refusal_is_reported_as_one_so_the_reservation_is_dropped() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.send_error = _http_error(400)

    with pytest.raises(RichContentFailed) as raised:
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", _activity(), None)

    # What the channel would have shown, so a caller can say what it now cannot.
    assert raised.value.text == "**Working…**"


async def test_an_unknown_outcome_keeps_its_reservation_by_raising_itself() -> None:
    """A 5xx may still have landed, and RichContentFailed would license a
    second copy of a card somebody is meant to answer exactly once."""
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.send_error = _http_error(503)

    with pytest.raises(discord.DiscordServerError):
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)


async def test_a_timeout_is_not_a_refusal_either() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.send_error = TimeoutError()

    with pytest.raises(TimeoutError):
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", await _card(), None)


async def test_being_rate_limited_says_how_long_to_wait() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.send_error = discord.RateLimited(2.5)

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", _activity(), None)

    assert raised.value.retry_after == 2.5


async def test_the_webhooks_own_shape_of_429_is_a_throttle_too() -> None:
    """The webhook transport does not raise `RateLimited`.

    It exhausts its own 429 retries and then raises a plain `HTTPException`,
    which is the shape that actually reaches this seam in production. Read as
    a refusal it would throw the reservation away and lose the wait Discord
    asked for, so the status of the response is what decides.
    """
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.send_error = _http_error(429, headers={"Retry-After": "3.5"})

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", _activity(), None)

    assert raised.value.retry_after == 3.5


async def test_a_429_that_says_nothing_still_waits_rather_than_hammering() -> None:
    """Retrying a throttle immediately is how a throttle becomes a ban."""
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.send_error = _http_error(429, headers={})

    with pytest.raises(RichContentThrottled) as raised:
        await adapter.post_rich(str(CHANNEL_ID), "my-agent", _activity(), None)

    assert raised.value.retry_after > 0


async def test_a_failed_edit_is_reported_rather_than_logged_and_forgotten() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()
    webhook.edit_error = _http_error(403)

    with pytest.raises(RichContentFailed):
        await adapter.update_rich(
            str(CHANNEL_ID), "my-agent", f"{ROOT_MESSAGE_ID}:901", await _card(), None
        )


# ── Redrawing ────────────────────────────────────────────────────────────────


async def test_a_running_turn_is_redrawn_in_place_inside_its_thread() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{ROOT_MESSAGE_ID}:901", _activity(), None
    )

    assert webhook.deletes == []
    assert webhook.edits[0]["message_id"] == 901
    assert webhook.edits[0]["thread"].id == ROOT_MESSAGE_ID


async def test_a_thread_keeps_the_finished_turn_as_its_record() -> None:
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{ROOT_MESSAGE_ID}:901", _ended(), None
    )

    assert webhook.deletes == []
    assert webhook.edits[0]["message_id"] == 901


async def test_a_flat_channel_keeps_the_finished_turn_too() -> None:
    """The channel root is where most turns are published and the one place a
    finished status used to disappear from. What a reader scrolling back wants
    is the same there as in a thread: that it ran, how long it took, and the
    link to open it."""
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{CHANNEL_ID}:901", _ended(), None
    )

    assert webhook.deletes == []
    assert webhook.edits[0]["message_id"] == 901


async def test_a_dm_keeps_it_too_and_never_asks_for_a_webhook() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    dm.messages[501] = _Message(dm, 501)

    await adapter.update_rich(
        str(DM_CHANNEL_ID), "my-agent", f"{DM_CHANNEL_ID}:501", _ended(), None
    )

    assert dm.deleted_ids == []
    assert dm.messages[501].edited is not None


async def test_a_dm_redraw_writes_the_agent_name_back_into_the_body() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})

    ref = await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", _activity(), None)
    await adapter.update_rich(str(DM_CHANNEL_ID), "my-agent", ref, _activity(), None)

    assert dm.messages[501].edited is not None
    assert dm.messages[501].edited.startswith("**my-agent**: ")


async def test_a_dm_redraw_still_names_the_agent_after_a_restart() -> None:
    """In a DM the name is in the body rather than on the sender, so a redraw
    that did not know it would republish somebody's turn as the bot. It comes
    with the call, so nothing here depends on this process having posted it.
    """
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    ref = await adapter.post_rich(str(DM_CHANNEL_ID), "my-agent", _activity(), None)

    restarted = _adapter({DM_CHANNEL_ID: dm})
    await restarted.update_rich(str(DM_CHANNEL_ID), "my-agent", ref, _activity(), None)

    assert dm.messages[501].edited is not None
    assert dm.messages[501].edited.startswith("**my-agent**: ")


async def test_a_settled_card_is_never_taken_down() -> None:
    """It is the record of a decision, and it says what became of it."""
    adapter, _channel, _thread, webhook = _guild_setup()
    card = await _card()

    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{CHANNEL_ID}:901", card, None
    )

    assert webhook.deletes == []
    assert webhook.edits[0]["message_id"] == 901


async def test_a_finished_status_is_still_redrawn_when_the_turn_says_more() -> None:
    """Nothing is retired, so a late revision of a turn that has ended reaches
    the channel rather than being dropped on the floor."""
    adapter, _channel, _thread, webhook = _guild_setup()

    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{CHANNEL_ID}:901", _ended(), None
    )
    await adapter.update_rich(
        str(CHANNEL_ID), "my-agent", f"{CHANNEL_ID}:901", _ended(), None
    )

    assert webhook.deletes == []
    assert len(webhook.edits) == 2


# ── Recovery ─────────────────────────────────────────────────────────────────


def _posted_card(channel: Any, message_id: int, content: str, webhook_id: int | None):
    message = _Message(channel, message_id, content)
    message.webhook_id = webhook_id
    return message


async def test_an_uncertainly_delivered_card_is_found_by_its_own_handle() -> None:
    adapter, channel, thread, webhook = _guild_setup()
    thread.history_messages = [
        _posted_card(
            thread, 901, "**Permission needed** · request `R7`", PUBLICATION_WEBHOOK_ID
        )
    ]

    found = await adapter.find_request_card(
        str(CHANNEL_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "tok-1",
        datetime.now(UTC) - timedelta(seconds=5),
        "R7",
    )

    assert found == f"{ROOT_MESSAGE_ID}:901"


async def test_somebody_quoting_the_handle_is_not_mistaken_for_the_card() -> None:
    adapter, channel, thread, webhook = _guild_setup()
    thread.history_messages = [
        _posted_card(thread, 902, "is that the request `R7` one?", None)
    ]

    found = await adapter.find_request_card(
        str(CHANNEL_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "tok-1",
        datetime.now(UTC),
        "R7",
    )

    assert found is None


async def test_the_mention_above_a_card_does_not_hide_it() -> None:
    """A card that notifies its asker opens with the mention, not the heading,
    and it is the one kind of card recovery most needs to find."""
    adapter, channel, thread, webhook = _guild_setup()
    thread.history_messages = [
        _posted_card(
            thread,
            901,
            f"<@{ASKER_ID}>\n**Permission needed** · request `R7`\nDeploy?",
            PUBLICATION_WEBHOOK_ID,
        )
    ]

    found = await adapter.find_request_card(
        str(CHANNEL_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "tok-1",
        datetime.now(UTC),
        "R7",
    )

    assert found == f"{ROOT_MESSAGE_ID}:901"


async def test_an_agent_explaining_a_card_is_not_bound_to_as_one() -> None:
    """An agent's own words arrive on the bridge's other webhook.

    "the request `R7`" is a phrase an agent can write, and its reply is posted
    by the bridge, so neither the sender being us nor the handle being present
    tells a card from a sentence about one. Binding to the sentence would mean
    every settlement edit overwrites an agent's reply while the real card sits
    there still saying the request is open.
    """
    adapter, channel, thread, webhook = _guild_setup()
    thread.history_messages = [
        _posted_card(thread, 902, "I can explain the request `R7`", WEBHOOK_ID),
        _posted_card(
            thread, 903, "**Permission needed** · request `R7`", PUBLICATION_WEBHOOK_ID
        ),
    ]

    found = await adapter.find_request_card(
        str(CHANNEL_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "tok-1",
        datetime.now(UTC),
        "R7",
    )

    assert found == f"{ROOT_MESSAGE_ID}:903"


async def test_a_dm_card_is_recovered_from_the_bots_own_message() -> None:
    """A DM has no webhooks, so the bot is the only sender a card can have."""
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    card = _posted_card(dm, 501, "**Permission needed** · request `R7`", None)
    card.author = _Author(BOT_USER_ID)
    dm.history_messages = [card]

    found = await adapter.find_request_card(
        str(DM_CHANNEL_ID), None, "tok-1", datetime.now(UTC), "R7"
    )

    assert found == f"{DM_CHANNEL_ID}:501"


async def test_a_dm_reply_from_the_same_bot_is_still_not_the_card() -> None:
    dm = _DMChannel()
    adapter = _adapter({DM_CHANNEL_ID: dm})
    reply = _posted_card(dm, 502, "**my-agent**: about request `R7` — ", None)
    reply.author = _Author(BOT_USER_ID)
    dm.history_messages = [reply]

    found = await adapter.find_request_card(
        str(DM_CHANNEL_ID), None, "tok-1", datetime.now(UTC), "R7"
    )

    assert found is None


async def test_a_card_that_fell_back_to_the_channel_root_is_still_found() -> None:
    adapter, channel, thread, webhook = _guild_setup()
    channel.history_messages = [
        _posted_card(
            channel, 903, "**Permission needed** · request `R7`", PUBLICATION_WEBHOOK_ID
        )
    ]

    found = await adapter.find_request_card(
        str(CHANNEL_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "tok-1",
        datetime.now(UTC),
        "R7",
    )

    assert found == f"{CHANNEL_ID}:903"


async def test_a_naive_timestamp_is_read_as_utc_rather_than_as_local_time() -> None:
    adapter, _channel, thread, _webhook = _guild_setup()
    thread.history_messages = [
        _posted_card(
            thread, 901, "**Permission needed** · request `R7`", PUBLICATION_WEBHOOK_ID
        )
    ]

    found = await adapter.find_request_card(
        str(CHANNEL_ID),
        f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
        "tok-1",
        datetime.now(UTC).replace(tzinfo=None),
        "R7",
    )

    assert found == f"{ROOT_MESSAGE_ID}:901"


async def test_a_turns_activity_cannot_be_recovered_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A webhook message carries no metadata, so there is nothing but the
    handle to match on — and a status prints none."""
    adapter, _channel, _thread, _webhook = _guild_setup()

    with caplog.at_level(logging.WARNING):
        found = await adapter.find_request_card(
            str(CHANNEL_ID), None, "tok-1", datetime.now(UTC), None
        )

    assert found is None
    assert "stays unconfirmed rather than being posted twice" in caplog.text


async def test_an_unreadable_history_is_not_a_missing_card(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, channel, _thread, _webhook = _guild_setup()
    channel.history_error = _http_error(500)

    with caplog.at_level(logging.WARNING):
        found = await adapter.find_request_card(
            str(CHANNEL_ID), None, "tok-1", datetime.now(UTC), "R7"
        )

    assert found is None
    assert "looking for card R7" in caplog.text


# ── Reactions, typing and thread reads ───────────────────────────────────────


async def test_one_mark_is_shared_between_agents_and_not_added_twice() -> None:
    """Every agent posts through one bot application here, so there is one
    reaction between them; the publisher counts who is still holding it."""
    adapter, channel, _thread, _webhook = _guild_setup()

    ref = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
    )
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="other-agent", mark="working", on=True
    )
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=False
    )

    assert channel.reactions == [("👀", True), ("👀", False)]


async def test_force_marks_again_because_the_record_may_be_empty_and_wrong() -> None:
    adapter, channel, _thread, _webhook = _guild_setup()

    ref = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
    )
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True, force=True
    )

    assert channel.reactions == [("👀", True), ("👀", True)]


async def test_a_missing_permission_is_refused_rather_than_swallowed() -> None:
    adapter, channel, _thread, _webhook = _guild_setup()
    channel.reaction_error = discord.Forbidden(_Response(), "no Add Reactions")  # type: ignore[arg-type]

    with pytest.raises(ActivityMarkRefused, match="Add Reactions"):
        await adapter.mark_activity(
            str(CHANNEL_ID),
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
            agent_name="my-agent",
            mark="working",
            on=True,
        )


async def test_a_mark_that_cannot_be_taken_off_is_refused_not_shrugged_away() -> None:
    """A missing mark is an absence; a stuck one is a false statement.

    Both are refusals the adapter reports rather than logs, because whether a
    mark is still on the message depends on what was put there — a question
    this adapter cannot answer once a restart has emptied its memory, and the
    publisher's durable record can.
    """
    adapter, channel, _thread, _webhook = _guild_setup()
    ref = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
    )
    channel.reaction_error = discord.Forbidden(_Response(), "cannot see the channel")  # type: ignore[arg-type]

    with pytest.raises(ActivityMarkRefused, match="still see"):
        await adapter.mark_activity(
            str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=False
        )


async def test_a_refused_mark_is_not_recorded_as_present() -> None:
    """Recording a mark that was refused would make the next attempt a no-op,
    so the guild would never get the reaction back once the permission is."""
    adapter, channel, _thread, _webhook = _guild_setup()
    ref = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    channel.reaction_error = discord.Forbidden(_Response(), "no Add Reactions")  # type: ignore[arg-type]

    with pytest.raises(ActivityMarkRefused):
        await adapter.mark_activity(
            str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
        )

    channel.reaction_error = None
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
    )
    assert channel.reactions == [("👀", True)]


async def test_a_message_inside_a_thread_is_marked_in_that_thread() -> None:
    """The reaction goes where the message is, not where the room is.

    A message posted in a thread is bridged into the parent channel's room, but
    it lives in the thread — which on Discord is a channel of its own, and the
    only place the reaction can be added.
    """
    adapter, channel, thread, _webhook = _guild_setup()

    await adapter.mark_activity(
        str(CHANNEL_ID),
        f"{ROOT_MESSAGE_ID}:999",
        agent_name="my-agent",
        mark="working",
        on=True,
    )

    assert thread.reactions == [("👀", True)]
    assert channel.reactions == []


async def test_a_deleted_message_is_not_a_failed_removal() -> None:
    """The end state is what was wanted either way, so the mark is forgotten
    rather than left recorded as present — and a later turn still marks."""
    adapter, channel, _thread, _webhook = _guild_setup()
    ref = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
    )

    channel.reaction_error = discord.NotFound(_Response(), "unknown message")  # type: ignore[arg-type]
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=False
    )

    channel.reaction_error = None
    await adapter.mark_activity(
        str(CHANNEL_ID), ref, agent_name="my-agent", mark="working", on=True
    )
    # The whole list, not just its tail: the failed removal appends nothing, so
    # a tail check passes on the first add alone and would not notice the
    # second being suppressed by a record still claiming the mark is present.
    assert channel.reactions == [("👀", True), ("👀", True)]


async def test_a_transient_reaction_failure_raises_so_the_publisher_retries() -> None:
    adapter, channel, _thread, _webhook = _guild_setup()
    channel.reaction_error = _http_error(500)

    with pytest.raises(discord.DiscordServerError):
        await adapter.mark_activity(
            str(CHANNEL_ID),
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
            agent_name="my-agent",
            mark="working",
            on=True,
        )


async def test_the_typing_nudge_never_creates_a_thread_to_go_in() -> None:
    channel = _Channel()
    adapter = _adapter({CHANNEL_ID: channel})

    await adapter.notify_working(
        str(CHANNEL_ID), "my-agent", f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    assert channel.typing_count == 1


async def test_the_typing_nudge_uses_a_thread_that_already_exists() -> None:
    adapter, channel, thread, _webhook = _guild_setup()

    await adapter.notify_working(
        str(CHANNEL_ID), "my-agent", f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    )

    assert thread.typing_count == 1
    assert channel.typing_count == 0


async def test_the_first_message_in_a_thread_is_the_first_reply() -> None:
    adapter, _channel, thread, _webhook = _guild_setup()
    thread.history_messages = [_Message(thread, 901, "yes")]

    root = f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}"
    assert await adapter.is_first_reply(str(CHANNEL_ID), root, f"{ROOT_MESSAGE_ID}:901")
    assert not await adapter.is_first_reply(
        str(CHANNEL_ID), root, f"{ROOT_MESSAGE_ID}:902"
    )


async def test_a_thread_that_cannot_be_read_refuses_rather_than_raises(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _channel, thread, _webhook = _guild_setup()
    thread.history_error = _http_error(500)

    with caplog.at_level(logging.WARNING):
        answered = await adapter.is_first_reply(
            str(CHANNEL_ID),
            f"{CHANNEL_ID}:{ROOT_MESSAGE_ID}",
            f"{ROOT_MESSAGE_ID}:901",
        )

    assert answered is False
    assert "not the first reply" in caplog.text
