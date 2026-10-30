"""A Switch Trust notice about a person's own message reaches that person
alone: an ephemeral where the platform has one, a direct message where it has
not, and the channel, with a warning, where it has neither, the private route
fails, or there is no one person to reach
(`CollaborationCore._post_trust_notice`)."""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import pytest
from telegram.error import Forbidden

from switch_core.bridges.collaboration.adapter import PrivateNoticeRefused
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.trust.client import TrustCheckResult, TrustFinding

from .test_bridge_inbound_trust import (
    TRANSPORT_ROOM_ID,
    _bridge,
    _FakeHumanActor,
    _FixedTrustClient,
)

_BLOCKED = TrustCheckResult(
    outcome="blocked",
    policy_id="policy-1",
    policy_name="default",
    findings=(
        TrustFinding(category="pii/email", detector_name="email", severity="high"),
    ),
)

_REDACTED = TrustCheckResult(
    outcome="redacted",
    policy_id="policy-1",
    policy_name="default",
    findings=(
        TrustFinding(category="pii/email", detector_name="email", severity="high"),
    ),
    redacted_content="my email is [redacted]",
)


def _message(
    *,
    channel_type: str = "channel_public",
    sender_id: str = "U-alice",
    message_ref: str = "C1:111.0",
    root_id: str | None = None,
    sender_is_app: bool = False,
) -> InboundMessage:
    return InboundMessage(
        channel_id="chan-1",
        channel_type=channel_type,  # type: ignore[arg-type]
        channel_name="general",
        sender_id=sender_id,
        sender_name="alice",
        content="my email is alice@example.com",
        message_ref=message_ref,
        root_id=root_id,
        sender_is_app=sender_is_app,
    )


class _SlackWeb:
    def __init__(self) -> None:
        self.ephemeral: list[dict[str, Any]] = []
        self.posted: list[dict[str, Any]] = []

    async def chat_postEphemeral(self, **kwargs: Any) -> None:
        self.ephemeral.append(kwargs)

    async def chat_postMessage(self, **kwargs: Any) -> dict[str, str]:
        self.posted.append(kwargs)
        return {"ts": "222.0"}


def _slack(web: _SlackWeb) -> SlackAdapter:
    adapter = SlackAdapter.__new__(SlackAdapter)
    adapter._web_client = web  # type: ignore[assignment]
    adapter._gateway_public_url = None
    return adapter


async def test_slack_block_notice_is_ephemeral_to_the_sender() -> None:
    web = _SlackWeb()
    human_actor = _FakeHumanActor()
    bridge = _bridge(human_actor, _slack(web), _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    await CollaborationCore._handle_inbound_message(bridge, _message())

    assert human_actor.sent == []
    assert web.posted == []
    assert len(web.ephemeral) == 1
    call = web.ephemeral[0]
    assert call["channel"] == "chan-1"
    assert call["user"] == "U-alice"
    assert "blocked by Switch Trust" in call["text"]
    # A top-level message gets its notice at the channel root, beside it,
    # rather than in a thread nobody opened.
    assert call["thread_ts"] is None


async def test_slack_redaction_notice_in_a_thread_is_ephemeral_in_that_thread() -> None:
    web = _SlackWeb()
    human_actor = _FakeHumanActor()
    bridge = _bridge(human_actor, _slack(web), _FixedTrustClient(_REDACTED))  # type: ignore[arg-type]

    async def _root_event(_external_root: str) -> str:
        return "$root"

    bridge._event_for_external_post = _root_event

    await CollaborationCore._handle_inbound_message(
        bridge, _message(root_id="C1:100.0")
    )

    assert human_actor.sent == [(TRANSPORT_ROOM_ID, "my email is [redacted]")]
    assert web.posted == []
    assert len(web.ephemeral) == 1
    assert web.ephemeral[0]["user"] == "U-alice"
    assert web.ephemeral[0]["thread_ts"] == "100.0"
    assert "redacted by Switch Trust" in web.ephemeral[0]["text"]


class _TelegramBot:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_message(self, **kwargs: Any) -> None:
        self.sent.append(kwargs)


async def test_telegram_block_notice_goes_to_the_senders_private_chat() -> None:
    bot = _TelegramBot()
    adapter = TelegramAdapter.__new__(TelegramAdapter)
    adapter._bot = bot
    adapter._gateway_public_url = None
    human_actor = _FakeHumanActor()
    bridge = _bridge(human_actor, adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    await CollaborationCore._handle_inbound_message(
        bridge, _message(sender_id="4242", message_ref="-100:7")
    )

    assert human_actor.sent == []
    assert len(bot.sent) == 1
    assert bot.sent[0]["chat_id"] == 4242
    assert bot.sent[0]["text"].startswith("About your message in general:")
    assert "blocked by Switch Trust" in bot.sent[0]["text"]


async def test_discord_block_notice_is_a_direct_message_naming_the_channel() -> None:
    sent: list[tuple[str, dict[str, Any]]] = []

    class _User:
        async def send(self, content: str, **kwargs: Any) -> None:
            sent.append((content, kwargs))

    users = {4242: _User()}
    client = SimpleNamespace(get_user=users.get)
    adapter = DiscordAdapter.__new__(DiscordAdapter)
    adapter._connection = SimpleNamespace(client=client)  # type: ignore[assignment]
    adapter._gateway_public_url = None
    human_actor = _FakeHumanActor()
    bridge = _bridge(human_actor, adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    await CollaborationCore._handle_inbound_message(
        bridge, _message(sender_id="4242", message_ref="1:2")
    )

    assert human_actor.sent == []
    assert len(sent) == 1
    content, _ = sent[0]
    assert content.startswith("About your message in <#chan-1>:")
    assert "blocked by Switch Trust" in content


async def test_a_long_telegram_notice_is_split_to_fit() -> None:
    bot = _TelegramBot()
    adapter = TelegramAdapter.__new__(TelegramAdapter)
    adapter._bot = bot
    adapter._gateway_public_url = None

    await adapter.notify_privately(
        channel_id="-100",
        channel_name="general",
        user_id="4242",
        content="\n".join(f"line {n} " + "x" * 60 for n in range(200)),
        thread_root_id=None,
    )

    assert len(bot.sent) > 1
    assert all(len(sent["text"]) <= 4096 for sent in bot.sent)
    assert all(sent["chat_id"] == 4242 for sent in bot.sent)


async def test_telegrams_refusal_is_raised_as_expected() -> None:
    class _RefusingBot:
        async def send_message(self, **_kwargs: Any) -> None:
            raise Forbidden("Forbidden: bot can't initiate conversation with a user")

    adapter = TelegramAdapter.__new__(TelegramAdapter)
    adapter._bot = _RefusingBot()
    adapter._gateway_public_url = None

    with pytest.raises(PrivateNoticeRefused):
        await adapter.notify_privately(
            channel_id="-100",
            channel_name="general",
            user_id="4242",
            content="blocked",
            thread_root_id=None,
        )


async def test_a_long_discord_notice_is_split_to_fit() -> None:
    sent: list[str] = []

    class _User:
        async def send(self, content: str, **_kwargs: Any) -> None:
            sent.append(content)

    client = SimpleNamespace(get_user={4242: _User()}.get)
    adapter = DiscordAdapter.__new__(DiscordAdapter)
    adapter._connection = SimpleNamespace(client=client)  # type: ignore[assignment]
    adapter._gateway_public_url = None

    await adapter.notify_privately(
        channel_id="chan-1",
        channel_name="general",
        user_id="4242",
        content="\n".join(f"line {n} " + "x" * 60 for n in range(100)),
        thread_root_id=None,
    )

    assert len(sent) > 1
    assert all(len(content) <= 2000 for content in sent)


class _NoticeAdapter:
    """A platform whose private route is declared but can be made to fail,
    recording what reached the channel instead."""

    platform_name = "Fake"

    def __init__(
        self, delivery: str, *, private_fails: bool, refused: bool = False
    ) -> None:
        self.private_notice_delivery = delivery
        self._private_fails = private_fails
        self._refused = refused
        self.private: list[dict[str, Any]] = []
        self.admin_messages: list[tuple[str, str, str | None, str]] = []

    def translate_inbound(self, content: str) -> str:
        return content

    def unlinkable_account_reason(self, external_user_id: str) -> str | None:
        return "a stand-in" if external_user_id == "stand-in" else None

    async def notify_privately(self, **kwargs: Any) -> None:
        if self._refused:
            raise PrivateNoticeRefused("Forbidden: bot can't initiate conversation")
        if self._private_fails:
            raise RuntimeError("the platform timed out")
        self.private.append(kwargs)

    async def admin_message(
        self, channel_id: str, body: str, root_or_ref: str | None, *, message_type: str
    ) -> None:
        self.admin_messages.append((channel_id, body, root_or_ref, message_type))


async def test_a_refused_direct_message_falls_back_to_the_channel_with_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _NoticeAdapter("direct_message", private_fails=True)
    bridge = _bridge(_FakeHumanActor(), adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING):
        await CollaborationCore._handle_inbound_message(bridge, _message())

    assert len(adapter.admin_messages) == 1
    channel_id, body, root_or_ref, message_type = adapter.admin_messages[0]
    assert channel_id == "chan-1"
    assert "blocked by Switch Trust" in body
    assert root_or_ref == "C1:111.0"
    assert message_type == AdminMessageType.TRUST_BLOCKED.value
    assert "everyone in it sees it" in caplog.text
    assert "timed out" in caplog.text


async def test_a_refusal_the_platform_is_expected_to_give_is_logged_without_a_traceback(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Most members of a Telegram group never started a chat with the bot,
    so its refusal is routine: one line, not a traceback per notice."""
    adapter = _NoticeAdapter("direct_message", private_fails=False, refused=True)
    bridge = _bridge(_FakeHumanActor(), adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING):
        await CollaborationCore._handle_inbound_message(bridge, _message())

    assert len(adapter.admin_messages) == 1
    [record] = [r for r in caplog.records if "privately" in r.getMessage()]
    assert "can't initiate conversation" in record.getMessage()
    assert record.exc_info is None


@pytest.mark.parametrize(
    ("sender_id", "sender_is_app"), [("U-app", True), ("stand-in", False)]
)
async def test_an_app_or_a_shared_account_gets_its_notice_in_the_channel(
    caplog: pytest.LogCaptureFixture, sender_id: str, sender_is_app: bool
) -> None:
    """Nobody is behind an app's post to reach privately, and a stand-in
    account is many people, so the private route is not tried at all."""
    adapter = _NoticeAdapter("direct_message", private_fails=True)
    bridge = _bridge(_FakeHumanActor(), adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING):
        await CollaborationCore._handle_inbound_message(
            bridge, _message(sender_id=sender_id, sender_is_app=sender_is_app)
        )

    assert adapter.private == []
    assert len(adapter.admin_messages) == 1
    assert "privately" not in caplog.text
    assert "everyone in it sees it" not in caplog.text


async def test_a_platform_without_a_private_route_posts_in_channel_and_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _NoticeAdapter("in_channel", private_fails=False)
    bridge = _bridge(_FakeHumanActor(), adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING):
        await CollaborationCore._handle_inbound_message(bridge, _message())

    assert adapter.private == []
    assert len(adapter.admin_messages) == 1
    assert "has no way to reach one person privately" in caplog.text


async def test_in_a_direct_conversation_the_notice_stays_where_it_is(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The channel is already just the sender and the bot, so nothing is
    sent anywhere else and nothing is worth a warning."""
    adapter = _NoticeAdapter("in_channel", private_fails=False)
    bridge = _bridge(_FakeHumanActor(), adapter, _FixedTrustClient(_BLOCKED))  # type: ignore[arg-type]

    with caplog.at_level(logging.WARNING):
        await CollaborationCore._handle_inbound_message(
            bridge, _message(channel_type="direct")
        )

    assert len(adapter.admin_messages) == 1
    assert "privately" not in caplog.text
