"""What Switch sends a chat account while it is being linked: who is asking,
and how to take a confirmed link back.

On a local server the first user's address is one the server made up
(`admin@switch.local`), and showing it tells the person nothing. And a link
confirmed by tapping a number ran no command, so "run `unlink-account`" with
no `/` or `!` was not something anyone could follow, least of all in the
read-only conversation the prompt arrived in."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.discord.adapter import DiscordAdapter
from switch_core.bridges.collaboration.link_prompts import compose_prompt, shown_email
from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from switch_core.bridges.collaboration.slack.adapter import SlackAdapter
from switch_core.bridges.collaboration.teams.adapter import TeamsAdapter
from switch_core.bridges.collaboration.telegram.adapter import TelegramAdapter
from switch_core.chat_account_links import linked_notice, unlink_the_way_you_ran_this

NAME = "Mohammad Karzand"


def _prompt_text(email: str) -> str:
    return compose_prompt(
        requester_name=NAME,
        requester_email=email,
        platform="Slack",
        choices=[12, 42, 77],
        token="t",
        escape=lambda text: text,
    ).text


class TestThePromptNamesWhoIsAsking:
    @pytest.mark.parametrize(
        "email", ["admin@switch.local", "someone@mac.local", "ADMIN@SWITCH.LOCAL", ""]
    )
    def test_without_an_address_a_local_server_made_up(self, email: str) -> None:
        text = _prompt_text(email)

        assert text.startswith(f"**{NAME}** is linking this Slack account")
        assert ".local" not in text.lower()
        assert "()" not in text

    def test_with_a_real_address(self) -> None:
        assert _prompt_text("mo@example.com").startswith(
            f"**{NAME}** (mo@example.com) is linking this Slack account"
        )

    def test_only_a_local_domain_is_left_out(self) -> None:
        assert shown_email("ops@local.example.com") == "ops@local.example.com"
        assert shown_email("ops@example.local") is None


class TestTheConfirmationSaysHowToUnlink:
    @pytest.mark.parametrize(
        ("adapter_cls", "command"),
        [
            (SlackAdapter, f"`/unlink-account {NAME}` anywhere in Slack"),
            (
                TelegramAdapter,
                f"`/unlink_account {NAME}` in a group the Switch bot is in",
            ),
            (DiscordAdapter, f"`/unlink-account user:{NAME}` in a server channel"),
            (MattermostAdapter, f"`!unlink-account {NAME}` in a Mattermost channel"),
            (
                TeamsAdapter,
                f"@mention the Switch app in a channel or chat it is in and add `unlink-account {NAME}`",
            ),
            (
                PlatformAdapter,
                f"`!unlink-account {NAME}` from this account in any channel",
            ),
        ],
        ids=lambda value: value.__name__ if isinstance(value, type) else "",
    )
    def test_after_a_tap_in_the_platforms_own_command_form(
        self, adapter_cls: type[PlatformAdapter], command: str
    ) -> None:
        text = linked_notice(
            "Acme",
            "mo",
            NAME,
            unlink=adapter_cls.unlink_account_instructions(NAME, {}),
        )

        assert f"to Switch user **{NAME}**. If that isn't you, " in text
        assert command in text
        assert text.endswith(".")

    def test_after_a_command_the_way_it_was_run(self) -> None:
        text = linked_notice(
            "Acme", "mo", NAME, unlink=unlink_the_way_you_ran_this(NAME, {})
        )

        assert text.endswith(
            f"If that isn't you, run `unlink-account {NAME}` the way you ran this command."
        )


class TestTheConfirmationNamesTheAccount:
    """A Telegram account without a username is stored under a handle Switch
    made up ("MM_42"); the confirmation names the person instead."""

    def test_by_the_name_the_adapter_gives_it(self) -> None:
        adapter = TelegramAdapter.__new__(TelegramAdapter)
        adapter._full_names = {42: "M M"}
        label = adapter.known_user_label("42", "MM_42")

        text = linked_notice(
            "Telegram",
            label.display_name,
            NAME,
            unlink=unlink_the_way_you_ran_this(NAME, {}),
        )

        assert text.startswith(
            f"✅ Linked this Telegram account (M M) to Switch user **{NAME}**."
        )
        assert "MM_42" not in text
