from unittest.mock import MagicMock

from switch_core.bridges.collaboration.platforms import PLATFORMS, register_platforms
from switch_core.feature_flags import ADDITIONAL_MESSAGING_PLATFORMS

_ESTABLISHED = {"mattermost", "slack", "teams", "discord", "telegram"}


def _registered(flags: dict[str, bool]) -> set[str]:
    lifecycle = MagicMock()
    register_platforms(lifecycle, flags)
    return {call.args[0] for call in lifecycle.register_adapter.call_args_list}


def test_additional_platforms_are_not_registered_with_the_flag_off() -> None:
    assert _registered({ADDITIONAL_MESSAGING_PLATFORMS: False}) == _ESTABLISHED


def test_every_platform_is_registered_with_the_flag_on() -> None:
    assert _registered({ADDITIONAL_MESSAGING_PLATFORMS: True}) == {
        p.key for p in PLATFORMS
    }
