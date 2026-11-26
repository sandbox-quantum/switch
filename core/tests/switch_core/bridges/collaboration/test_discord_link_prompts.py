"""Confirming a chat account link by tapping a number in a Discord DM.

The bot opens its own direct conversation with the account and sends the
prompt with one button per number and a last `Not me`. A press comes back
through the path a card's press takes, as a position and the prompt's token,
addressed to the message it was on so that message can be replaced with what
happened. A DM carries no server, so each button names the server whose bridge
sent it; that is what lets the shared connection route the press at all.
"""

from __future__ import annotations

import logging
from typing import Any

import discord
import pytest

from switch_core.account_links import PROMPT_TOKEN_PREFIX
from switch_core.bridges.collaboration.discord.adapter import (
    DiscordAdapter,
    DiscordConnectionConfig,
    _press_action,
    prompt_guild,
)
from switch_core.bridges.collaboration.link_prompts import NOT_ME_LABEL, compose_prompt
from switch_core.bridges.collaboration.models import (
    DirectMessageUnavailable,
    DirectPrompt,
    InboundInteraction,
)
from switch_core.bridges.collaboration.session.renderers import (
    parse_answer_position,
    position_action,
)

from .test_discord_card_buttons import PRESSER_ID, _Interaction

GUILD_ID = 900
BOT_USER_ID = 42
ACCOUNT_ID = 4242
DM_CHANNEL_ID = 777
PROMPT_MESSAGE_ID = 8800
# A prompt token as `new_prompt_token` shapes it, built so no scanner reads it
# as a credential.
PROMPT_TOKEN = f"{PROMPT_TOKEN_PREFIX}fixture"


# ── Fakes ────────────────────────────────────────────────────────────────────


class _HttpResponse:
    status = 403
    reason = "Forbidden"
    headers: dict[str, str] = {}


def _forbidden() -> discord.Forbidden:
    return discord.Forbidden(_HttpResponse(), "Cannot send messages to this user")  # type: ignore[arg-type]


def _not_found() -> discord.NotFound:
    return discord.NotFound(_HttpResponse(), "Unknown User")  # type: ignore[arg-type]


class _Sent:
    def __init__(self, channel: Any, message_id: int) -> None:
        self.channel = channel
        self.id = message_id


class _DM:
    def __init__(self) -> None:
        self.id = DM_CHANNEL_ID
        self.guild = None
        self.sent: list[dict[str, Any]] = []
        self.send_error: Exception | None = None

    async def send(self, content: str, **kwargs: Any) -> _Sent:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append({"content": content, **kwargs})
        return _Sent(self, PROMPT_MESSAGE_ID)


class _User:
    def __init__(self, dm: _DM) -> None:
        self.id = ACCOUNT_ID
        self._dm = dm
        self.dm_error: Exception | None = None

    async def create_dm(self) -> _DM:
        if self.dm_error is not None:
            raise self.dm_error
        return self._dm


class _PartialMessage:
    def __init__(self, client: _Client, channel_id: int, message_id: int) -> None:
        self._client = client
        self._channel_id = channel_id
        self.id = message_id

    async def edit(self, **kwargs: Any) -> None:
        if self._client.edit_error is not None:
            raise self._client.edit_error
        self._client.edits.append(
            {"channel_id": self._channel_id, "message_id": self.id, **kwargs}
        )


class _PartialChannel:
    def __init__(self, client: _Client, channel_id: int) -> None:
        self._client = client
        self.id = channel_id

    def get_partial_message(self, message_id: int) -> _PartialMessage:
        return _PartialMessage(self._client, self.id, message_id)


class _Client:
    def __init__(self) -> None:
        self.dm = _DM()
        self.user = _User(self.dm)
        self.fetched: list[int] = []
        self.fetch_error: Exception | None = None
        self.edits: list[dict[str, Any]] = []
        self.edit_error: Exception | None = None
        self.partial_types: list[Any] = []

    async def fetch_user(self, user_id: int) -> _User:
        if self.fetch_error is not None:
            raise self.fetch_error
        self.fetched.append(user_id)
        return self.user

    def get_partial_messageable(
        self, channel_id: int, *, type: Any = None
    ) -> _PartialChannel:
        self.partial_types.append(type)
        return _PartialChannel(self, channel_id)


def _adapter(guild_id: int = GUILD_ID) -> tuple[DiscordAdapter, _Client]:
    adapter = DiscordAdapter(
        config=DiscordConnectionConfig(bot_token="token", guild_id=str(guild_id))
    )
    client = _Client()
    adapter._connection._bot_user_id = BOT_USER_ID
    adapter._connection._client = client  # type: ignore[assignment]
    return adapter, client


def _prompt() -> DirectPrompt:
    return compose_prompt(
        requester_name="Jane Doe",
        requester_email="jane@example.com",
        platform="Discord",
        choices=[17, 42, 88],
        token=PROMPT_TOKEN,
        escape=lambda text: text,
    )


def _buttons(client: _Client) -> list[Any]:
    return list(client.dm.sent[0]["view"].children)


def _handled(adapter: DiscordAdapter) -> list[InboundInteraction]:
    seen: list[InboundInteraction] = []

    async def took(interaction: InboundInteraction) -> None:
        seen.append(interaction)

    adapter.set_interaction_handler(took)
    return seen


# ── Sending ──────────────────────────────────────────────────────────────────


async def test_a_prompt_goes_to_the_accounts_own_dm_with_the_bot() -> None:
    adapter, client = _adapter()

    ref = await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())

    assert client.fetched == [ACCOUNT_ID]
    assert len(client.dm.sent) == 1
    sent = client.dm.sent[0]
    assert sent["content"] == adapter.translate_outbound(_prompt().text)
    assert "**Jane Doe**" in sent["content"]
    # The ref is the one a press on it carries back: DM, then message.
    assert ref == f"{DM_CHANNEL_ID}:{PROMPT_MESSAGE_ID}"
    assert adapter.direct_prompt_link(ref) == (
        f"https://discord.com/channels/@me/{DM_CHANNEL_ID}/{PROMPT_MESSAGE_ID}"
    )


async def test_each_label_is_a_button_in_order_and_not_me_is_last() -> None:
    adapter, client = _adapter()

    await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())

    buttons = _buttons(client)
    assert [button.label for button in buttons] == ["17", "42", "88", NOT_ME_LABEL]
    assert [button.style for button in buttons] == [
        discord.ButtonStyle.secondary,
        discord.ButtonStyle.secondary,
        discord.ButtonStyle.secondary,
        discord.ButtonStyle.danger,
    ]


async def test_each_button_reads_back_as_its_position_and_the_prompts_token() -> None:
    """The pair a card's button gives, so the press takes a card's path."""
    adapter, client = _adapter()

    await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())

    for position, button in enumerate(_buttons(client), start=1):
        assert _press_action(button.custom_id) == (
            position_action(position),
            PROMPT_TOKEN,
        )
        assert prompt_guild(button.custom_id) == GUILD_ID
        assert len(button.custom_id) <= 100


async def test_the_view_is_never_left_in_the_clients_own_store() -> None:
    """A press is read off its id, which is what lets a prompt outlive a
    restart; an unstopped view would be kept for the life of the process."""
    adapter, client = _adapter()

    await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())

    view = client.dm.sent[0]["view"]
    assert view.timeout is None
    assert view.is_finished()


async def test_an_account_that_takes_no_dms_from_the_bot_is_told_to_use_the_code() -> (
    None
):
    adapter, client = _adapter()
    client.dm.send_error = _forbidden()

    with pytest.raises(DirectMessageUnavailable, match="use the code instead"):
        await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())


async def test_a_dm_the_bot_cannot_open_is_told_to_use_the_code() -> None:
    adapter, client = _adapter()
    client.user.dm_error = _forbidden()

    with pytest.raises(DirectMessageUnavailable, match="use the code instead"):
        await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())


@pytest.mark.parametrize("account", [str(ACCOUNT_ID), "not-a-discord-id"])
async def test_an_account_discord_does_not_know_is_told_to_use_the_code(
    account: str,
) -> None:
    adapter, client = _adapter()
    client.fetch_error = _not_found()

    with pytest.raises(DirectMessageUnavailable, match="use the code instead"):
        await adapter.send_direct_prompt(account, _prompt())

    assert client.dm.sent == []


# ── A press ──────────────────────────────────────────────────────────────────


async def test_a_press_in_the_dm_comes_back_addressed_to_the_prompt() -> None:
    """No server and no parent: the press is addressed to the DM itself, and
    its ref is the one `send_direct_prompt` returned."""
    adapter, client = _adapter()
    seen = _handled(adapter)
    ref = await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())
    pressed = _buttons(client)[1]
    press = _Interaction(
        pressed.custom_id,
        channel=client.dm,
        message=_Sent(client.dm, PROMPT_MESSAGE_ID),
        guild_id=None,
    )

    await adapter._handle_interaction(press)

    assert press.response.deferred == 1
    assert len(seen) == 1
    assert seen[0].value == PROMPT_TOKEN
    assert parse_answer_position(seen[0].action_id) == 2
    assert seen[0].message_ref == ref
    assert seen[0].channel_id == str(DM_CHANNEL_ID)
    assert seen[0].sender_id == str(PRESSER_ID)


async def test_a_press_on_another_bridges_prompt_is_left_to_it() -> None:
    """Two bridges on one bot both hear a DM press; only the one whose server
    the button names answers it."""
    sender, client = _adapter(GUILD_ID + 1)
    await sender.send_direct_prompt(str(ACCOUNT_ID), _prompt())
    custom_id = _buttons(client)[0].custom_id
    adapter, _client = _adapter()
    seen = _handled(adapter)
    press = _Interaction(
        custom_id,
        channel=client.dm,
        message=_Sent(client.dm, PROMPT_MESSAGE_ID),
        guild_id=None,
    )

    await adapter._handle_interaction(press)

    assert seen == []
    assert press.response.deferred == 0


def test_a_malformed_prompt_button_is_not_ours() -> None:
    for custom_id in (
        "swlnk",
        f"swlnk:{GUILD_ID}:{PROMPT_TOKEN}",
        f"swlnk:{GUILD_ID}::1",
        f"swlnk::{PROMPT_TOKEN}:1",
        f"swlnk:guild:{PROMPT_TOKEN}:1",
        f"swlnk:{GUILD_ID}:{PROMPT_TOKEN}:0",
        f"swlnk:{GUILD_ID}:{PROMPT_TOKEN}:two",
        f"swlnk:{GUILD_ID}:{PROMPT_TOKEN}:1:2",
    ):
        assert _press_action(custom_id) is None, custom_id
        assert prompt_guild(custom_id) is None, custom_id


def test_a_cards_button_names_no_server() -> None:
    assert prompt_guild("sw:tok-1:1") is None
    assert _press_action("sw:tok-1:1") == (position_action(1), "tok-1")


# ── Settling ─────────────────────────────────────────────────────────────────


async def test_an_answered_prompt_is_replaced_and_loses_its_buttons() -> None:
    adapter, client = _adapter()
    ref = await adapter.send_direct_prompt(str(ACCOUNT_ID), _prompt())

    await adapter.settle_direct_prompt(ref, "✅ Linked to **Jane Doe**.")

    assert len(client.edits) == 1
    edit = client.edits[0]
    assert edit["channel_id"] == DM_CHANNEL_ID
    assert edit["message_id"] == PROMPT_MESSAGE_ID
    assert edit["content"] == adapter.translate_outbound("✅ Linked to **Jane Doe**.")
    assert edit["view"] is None
    assert client.partial_types == [discord.ChannelType.private]


async def test_a_prompt_that_cannot_be_replaced_is_logged_and_left(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The answer is already recorded; settling it is best effort."""
    adapter, client = _adapter()
    client.edit_error = _forbidden()

    with caplog.at_level(logging.WARNING):
        await adapter.settle_direct_prompt(
            f"{DM_CHANNEL_ID}:{PROMPT_MESSAGE_ID}", "Cancelled."
        )
        await adapter.settle_direct_prompt("not-a-ref", "Cancelled.")

    assert client.edits == []
    assert caplog.text.count("Could not replace Discord prompt") == 2
    assert "Cancelled." in caplog.text
