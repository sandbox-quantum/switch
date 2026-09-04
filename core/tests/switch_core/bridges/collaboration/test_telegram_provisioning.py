"""Channel provisioning, membership and links for the Telegram bridge.

Telegram is the one platform where Switch cannot create the channel: the Bot API
has no call for it, and none for adding a member either. Most of what follows
therefore asserts that the adapter refuses clearly rather than appearing to
succeed — a room that silently never got created is the failure mode worth
guarding against.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest

from switch_core.bridges.collaboration.models import ChannelCreationUnsupported
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)

SUPERGROUP_ID = "-1001234567890"
BOT_USERNAME = "acme_switch_bot"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeChat:
    def __init__(self, chat_type: str, *, username: str | None = None) -> None:
        self.type = chat_type
        self.username = username
        self.title = "somewhere"


class _FakeBot:
    def __init__(self, chat: _FakeChat) -> None:
        self._chat = chat
        self.get_chat_calls = 0

    async def get_chat(self, chat_id: Any) -> _FakeChat:
        self.get_chat_calls += 1
        return self._chat


def _adapter(chat: _FakeChat | None = None) -> TelegramAdapter:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username=BOT_USERNAME)
    )
    adapter._bot = _FakeBot(chat if chat is not None else _FakeChat("supergroup"))
    return adapter


# ── Creating chats ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "channel_type", ["channel_public", "channel_private", "group", "direct"]
)
def test_creating_a_chat_is_refused_for_every_type(channel_type: Any) -> None:
    # ChannelCreationUnsupported is a ValueError, which is what turns this into
    # a 400 carrying the message rather than an opaque 500.
    with pytest.raises(ChannelCreationUnsupported) as excinfo:
        _run(_adapter().create_channel("Team room", "topic", channel_type=channel_type))

    # The error is read by an operator, so it has to say what to do instead.
    message = str(excinfo.value)
    assert "cannot create chats" in message
    assert BOT_USERNAME in message
    assert "Team room" in message


def test_creating_a_dm_is_refused_because_the_user_starts_it() -> None:
    with pytest.raises(ChannelCreationUnsupported, match="initiated by the user"):
        _run(
            _adapter().create_dm_channel(
                agent_name="scout", user_name="alice", user_external_id="7"
            )
        )


# ── Chat types ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("chat_type", "username", "expected"),
    [
        ("private", None, "lobby"),
        ("group", None, "channel_private"),
        ("supergroup", None, "channel_private"),
        ("supergroup", "acme_public", "channel_public"),
        ("channel", None, "channel_private"),
        ("channel", "acme_news", "channel_public"),
    ],
)
def test_chat_type_maps_to_the_bridges_channel_type(
    chat_type: str, username: str | None, expected: str
) -> None:
    adapter = _adapter(_FakeChat(chat_type, username=username))

    assert _run(adapter.get_channel_type(SUPERGROUP_ID)) == expected


def test_a_basic_group_is_private_even_though_it_cannot_hold_a_username() -> None:
    # A basic group has no username field to consult, so the mapping must not
    # depend on one.
    adapter = _adapter(_FakeChat("group", username="ignored"))

    assert _run(adapter.get_channel_type(SUPERGROUP_ID)) == "channel_private"


# ── Membership ───────────────────────────────────────────────────────────────


def test_adding_users_says_so_rather_than_reporting_a_change_it_cannot_make(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _adapter()

    with caplog.at_level(logging.WARNING):
        _run(adapter.add_users_to_channel(SUPERGROUP_ID, ["alice", "bob"], ["7", "8"]))

    assert "Cannot add alice, bob" in caplog.text
    assert "invite link" in caplog.text


def test_adding_nobody_is_silent(caplog: pytest.LogCaptureFixture) -> None:
    adapter = _adapter()

    with caplog.at_level(logging.WARNING):
        _run(adapter.add_users_to_channel(SUPERGROUP_ID, [], []))

    assert caplog.text == ""


def test_adding_agents_is_a_no_op_under_the_single_bot_model() -> None:
    # Every agent posts through the one bot, so there is nothing to add.
    _run(_adapter().add_agents_to_channel(SUPERGROUP_ID, ["scout", "scribe"]))


def test_agent_identities_are_a_no_op_under_the_single_bot_model() -> None:
    adapter = _adapter()

    _run(adapter.create_agent_identity("scout", "a scout"))
    _run(adapter.remove_agent_identity("scout"))

    assert _run(adapter.get_channel_agent_names(SUPERGROUP_ID)) == []


# ── Links ────────────────────────────────────────────────────────────────────


def test_a_private_supergroup_link_carries_a_message_id() -> None:
    # Bare `t.me/c/<id>` does not reliably resolve — the canonical private form
    # includes a message id, and opens for members of the chat.
    assert (
        _run(_adapter().channel_deeplink(SUPERGROUP_ID))
        == "https://t.me/c/1234567890/1"
    )


def test_a_public_chat_uses_its_real_address() -> None:
    # A username gives a link that works in a browser as well as the app, so it
    # beats the internal form whenever the chat has one.
    adapter = _adapter(_FakeChat("supergroup", username="acme_public"))

    assert _run(adapter.channel_deeplink(SUPERGROUP_ID)) == "https://t.me/acme_public"


def test_a_resolved_chat_is_only_looked_up_once() -> None:
    # A deeplink is built per room on every dashboard read, inside the
    # request's transaction. Uncached, a getChat round trip per room is a pool
    # slot held for the network, per room, per page load.
    adapter = _adapter(_FakeChat("supergroup", username="acme_public"))

    for _ in range(3):
        assert (
            _run(adapter.channel_deeplink(SUPERGROUP_ID)) == "https://t.me/acme_public"
        )

    assert adapter._bot.get_chat_calls == 1  # type: ignore[union-attr]


def test_a_chat_with_no_username_is_not_looked_up_again_either() -> None:
    adapter = _adapter(_FakeChat("supergroup"))

    for _ in range(3):
        assert (
            _run(adapter.channel_deeplink(SUPERGROUP_ID))
            == "https://t.me/c/1234567890/1"
        )

    assert adapter._bot.get_chat_calls == 1  # type: ignore[union-attr]


def test_a_failed_lookup_is_not_cached() -> None:
    # A transient outage must not cost the chat its real address for the life
    # of the process.
    adapter = _adapter(_FakeChat("supergroup", username="acme_public"))
    working = adapter._bot.get_chat  # type: ignore[union-attr]

    async def _fail(_chat_id: Any) -> _FakeChat:
        raise RuntimeError("telegram unreachable")

    adapter._bot.get_chat = _fail  # type: ignore[union-attr]
    assert (
        _run(adapter.channel_deeplink(SUPERGROUP_ID)) == "https://t.me/c/1234567890/1"
    )

    adapter._bot.get_chat = working  # type: ignore[union-attr]
    assert _run(adapter.channel_deeplink(SUPERGROUP_ID)) == "https://t.me/acme_public"


def test_a_failed_lookup_still_yields_the_internal_link() -> None:
    # Losing the button because one API call failed is worse than the link the
    # chat id alone can produce.
    adapter = _adapter()

    async def _fail(_chat_id: Any) -> _FakeChat:
        raise RuntimeError("telegram unreachable")

    adapter._bot.get_chat = _fail  # type: ignore[union-attr]

    assert (
        _run(adapter.channel_deeplink(SUPERGROUP_ID)) == "https://t.me/c/1234567890/1"
    )


def test_a_basic_group_has_no_channel_link() -> None:
    # A group that has never been upgraded to a supergroup is not addressable
    # by URL at all, so the caller hides the button rather than showing a dud.
    adapter = _adapter(_FakeChat("group"))

    assert _run(adapter.channel_deeplink("-987654321")) is None


def test_a_one_to_one_chat_has_no_channel_link() -> None:
    # Better none than a link that opens the wrong place.
    assert _run(_adapter().channel_deeplink("7")) is None


def test_a_malformed_chat_id_has_no_channel_link() -> None:
    assert _run(_adapter().channel_deeplink("-100not-a-number")) is None


def test_an_empty_chat_id_has_no_channel_link() -> None:
    assert _run(_adapter().channel_deeplink("")) is None


def test_the_home_link_normalises_a_configured_at_sign() -> None:
    adapter = TelegramAdapter(
        config=TelegramConnectionConfig(bot_token="token", bot_username="@acme_bot")
    )

    assert _run(adapter.home_deeplink()) == "https://t.me/acme_bot"
