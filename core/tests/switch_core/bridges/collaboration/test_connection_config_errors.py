"""A rejected connection config must not echo what was typed: the 422 detail
is the validation error's text, and the input is usually a token."""

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.discord.adapter import DiscordConnectionConfig
from switch_core.bridges.collaboration.slack.adapter import SlackConnectionConfig
from switch_core.bridges.collaboration.telegram.adapter import TelegramConnectionConfig

SECRET = "xoxb-0000-not-a-real-token"


@pytest.mark.parametrize(
    "config_type",
    [SlackConnectionConfig, DiscordConnectionConfig, TelegramConnectionConfig],
)
def test_a_validation_error_leaves_the_token_out(config_type: type) -> None:
    with pytest.raises(ValidationError) as caught:
        config_type.model_validate({"bot_token": [SECRET]})
    assert SECRET not in str(caught.value)
