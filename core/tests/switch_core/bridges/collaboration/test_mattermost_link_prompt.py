"""Confirming a Mattermost account link by pressing a number in a DM.

Switch's own bot, not an agent's, opens a direct channel of its own with the
account and posts the prompt there. Its buttons are signed like a card's answer
buttons, so a press comes back through the same callback as a card's does and
reaches the shared layer as an interaction on the post the prompt was sent as.
A prompt that cannot go out says why in words for the Switch user, who is then
shown the code instead.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import pytest
from mattermostdriver.exceptions import (
    InvalidOrMissingParameters,
    NotEnoughPermissions,
    ResourceNotFound,
)

from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.mattermost.callback import Press, read_press
from switch_core.bridges.collaboration.models import (
    DirectMessageUnavailable,
    DirectPrompt,
)
from switch_core.bridges.collaboration.session.renderers import position_action

from .test_mattermost_press import USER, _adapter, _body, _record
from .test_mattermost_sdk_only import _posts

DM = "dm-bot-admin-user-abc"
PROMPT = DirectPrompt(
    text=(
        "**Ada** (ada@example.com) is linking this Mattermost account to their "
        "Switch account.\n\nTap the number Switch Console is showing to finish."
    ),
    token="lnk.prompt-token",
    labels=("12", "47", "83", "Not me"),
)


class _FakeDirectChannels:
    def __init__(self) -> None:
        self.opened: list[list[str]] = []
        self.error: Exception | None = None

    def create_direct_message_channel(self, user_ids: list[str]) -> dict[str, str]:
        if self.error:
            raise self.error
        self.opened.append(user_ids)
        return {"id": DM, "type": "D"}


def _prompting(**kwargs: Any) -> tuple[MattermostAdapter, _FakeDirectChannels]:
    """An adapter that takes presses, with the admin bot able to open DMs."""
    adapter = _adapter(**kwargs)
    _record(adapter)
    channels = _FakeDirectChannels()
    driver: Any = adapter._admin_bot_driver
    driver.channels = channels
    return adapter, channels


def _buttons(post: dict[str, Any]) -> list[dict[str, Any]]:
    attachments = (post.get("props") or {}).get("attachments") or []
    return [action for attachment in attachments for action in attachment["actions"]]


# ── Sending ──────────────────────────────────────────────────────────────────


async def test_the_prompt_goes_out_in_the_admin_bots_own_dm_with_the_account() -> None:
    adapter, channels = _prompting()

    await adapter.send_direct_prompt(USER, PROMPT)

    assert channels.opened == [["bot-admin", USER]]
    created = _posts(adapter).created
    assert [post["channel_id"] for post in created] == [DM]
    assert _posts(adapter).created_by == ["admin-bot"]
    assert created[0]["message"] == adapter.translate_outbound(PROMPT.text)
    assert "root_id" not in created[0]


async def test_the_ref_returned_is_the_post_the_prompt_was_sent_as() -> None:
    adapter, _ = _prompting()

    ref = await adapter.send_direct_prompt(USER, PROMPT)

    assert ref == "post-1"
    assert _posts(adapter).stored[ref]["message"] == adapter.translate_outbound(
        PROMPT.text
    )


async def test_the_link_is_the_posts_permalink_on_the_public_address() -> None:
    adapter, _ = _prompting()
    adapter._config = adapter._config.model_copy(
        update={"public_url": "https://chat.example/"}
    )

    assert adapter.direct_prompt_link("post-1") == "https://chat.example/team/pl/post-1"


async def test_no_public_address_gives_no_link_rather_than_one_to_switchs_own_address() -> (
    None
):
    adapter, _ = _prompting()

    assert adapter.direct_prompt_link("post-1") is None


async def test_one_button_per_label_in_order_named_by_the_label_alone() -> None:
    """The labels are the numbers, so a card's "1. " numbering would put a
    number in front of a number."""
    adapter, _ = _prompting()

    await adapter.send_direct_prompt(USER, PROMPT)

    buttons = _buttons(_posts(adapter).created[0])
    assert [button["name"] for button in buttons] == list(PROMPT.labels)
    assert all(re.fullmatch(r"[A-Za-z0-9]+", button["id"]) for button in buttons)
    assert len({button["id"] for button in buttons}) == len(buttons)


async def test_only_the_way_out_is_marked_dangerous() -> None:
    adapter, _ = _prompting()

    await adapter.send_direct_prompt(USER, PROMPT)

    styles = [button.get("style") for button in _buttons(_posts(adapter).created[0])]
    assert styles == [None, None, None, "danger"]


async def test_each_button_reads_back_as_the_token_and_its_own_position() -> None:
    adapter, _ = _prompting()

    ref = await adapter.send_direct_prompt(USER, PROMPT)

    assert adapter._callback is not None
    keys = adapter._callback.verification_keys
    for position, button in enumerate(_buttons(_posts(adapter).created[0]), start=1):
        press = read_press(
            keys, _body(button["integration"]["context"], post_id=ref, channel_id=DM)
        )
        assert press == Press(
            user_id=USER,
            post_id=ref,
            channel_id=DM,
            token=PROMPT.token,
            position=position,
        )


async def test_a_press_in_the_dm_arrives_as_an_interaction_on_the_prompts_post() -> (
    None
):
    """No room is bridged to the DM, and nothing on the way in asks for one:
    the prompt's token is what the shared layer resolves the press against."""
    adapter, _ = _prompting()
    seen = _record(adapter)
    ref = await adapter.send_direct_prompt(USER, PROMPT)
    pressed = _buttons(_posts(adapter).created[0])[1]

    answer = await adapter._handle_callback(
        _body(pressed["integration"]["context"], post_id=ref, channel_id=DM)
    )

    assert answer == {}
    assert len(seen) == 1
    assert seen[0].message_ref == ref
    assert seen[0].action_id == position_action(2)
    assert seen[0].value == PROMPT.token
    assert seen[0].channel_id == DM
    assert seen[0].sender_id == USER


# ── When it cannot go out ────────────────────────────────────────────────────


async def test_no_admin_bot_in_this_process_is_unavailable_not_a_crash(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A process that does not hold the bridge mints no bot token."""
    adapter, channels = _prompting()
    adapter._admin_bot_driver = None

    with caplog.at_level(logging.WARNING):
        with pytest.raises(DirectMessageUnavailable, match="use the code"):
            await adapter.send_direct_prompt(USER, PROMPT)

    assert channels.opened == []
    assert "Switch Admin bot" in caplog.text


async def test_no_callback_address_is_unavailable_because_nothing_could_be_pressed() -> (
    None
):
    adapter, channels = _prompting(callback_base_url=None)

    with pytest.raises(DirectMessageUnavailable, match="callback address"):
        await adapter.send_direct_prompt(USER, PROMPT)

    assert channels.opened == []
    assert _posts(adapter).created == []


async def test_a_refused_dm_is_unavailable_and_posts_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, channels = _prompting()
    channels.error = NotEnoughPermissions("403 cannot create direct channel")

    with caplog.at_level(logging.WARNING):
        with pytest.raises(DirectMessageUnavailable, match="use the code"):
            await adapter.send_direct_prompt(USER, PROMPT)

    assert _posts(adapter).created == []
    assert "403 cannot create direct channel" in caplog.text


async def test_a_refused_post_is_unavailable() -> None:
    adapter, _ = _prompting()
    _posts(adapter).create_error = InvalidOrMissingParameters("400 bad post")

    with pytest.raises(DirectMessageUnavailable, match="use the code"):
        await adapter.send_direct_prompt(USER, PROMPT)


async def test_an_error_that_is_not_a_refusal_propagates() -> None:
    """A send whose outcome is unknown is not Mattermost saying no. It reaches
    the caller as itself, which logs it with its trace."""
    adapter, _ = _prompting()
    _posts(adapter).create_error = TimeoutError("response lost")

    with pytest.raises(TimeoutError):
        await adapter.send_direct_prompt(USER, PROMPT)


# ── Settling ─────────────────────────────────────────────────────────────────


async def test_settling_replaces_the_text_and_takes_the_buttons_off() -> None:
    adapter, _ = _prompting()
    ref = await adapter.send_direct_prompt(USER, PROMPT)

    await adapter.settle_direct_prompt(ref, "Linked to **Ada**.")

    held = _posts(adapter).stored[ref]
    assert held["message"] == adapter.translate_outbound("Linked to **Ada**.")
    assert "attachments" not in held["props"]
    assert held["props"]["from_bot"] == "true"
    assert _posts(adapter).patched_by == ["admin-bot"]


async def test_a_process_without_the_bot_settles_as_the_admin_user() -> None:
    """A press reaches whichever process the callback address leads to."""
    adapter, _ = _prompting()
    ref = await adapter.send_direct_prompt(USER, PROMPT)
    adapter._admin_bot_driver = None

    await adapter.settle_direct_prompt(ref, "Cancelled.")

    assert _posts(adapter).patched_by == ["admin"]
    assert "attachments" not in _posts(adapter).stored[ref]["props"]


async def test_a_failed_settle_is_logged_and_never_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = _prompting()
    ref = await adapter.send_direct_prompt(USER, PROMPT)
    _posts(adapter).patch_error = ResourceNotFound("404 post gone")

    with caplog.at_level(logging.WARNING):
        await adapter.settle_direct_prompt(ref, "Cancelled.")

    assert ref in caplog.text
    assert "Cancelled." in caplog.text


async def test_settling_while_disconnected_is_logged_and_never_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = _prompting()
    adapter._admin_bot_driver = None
    adapter._admin_driver = None

    with caplog.at_level(logging.WARNING):
        await adapter.settle_direct_prompt("post-9", "Cancelled.")

    assert "post-9" in caplog.text
