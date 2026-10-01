"""Half-configuring the distributed Discord app has to be a startup error.

The four credentials are useless apart: without the client id and secret the
code exchange is refused, without the application id there is no app to speak
for, and without the bot token the shared Gateway connection has nothing to open
with. A deployment that sets three of four looks configured, offers the button,
and breaks — so it does not start. And an app with no public origin builds its
redirect against nothing, which Discord refuses with nothing in our logs.
"""

import pytest

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)

_APP = dict(
    discord_app_client_id="123456789012345678",
    discord_app_client_secret="secret",
    discord_app_bot_token="bot-token",
    discord_app_application_id="123456789012345678",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_setting_none_of_them_is_the_ordinary_case() -> None:
    assert _config().discord_app_client_id is None


def test_setting_all_four_with_a_public_origin_is_accepted() -> None:
    config = _config(**_APP, messaging_public_url="https://switch.example")
    assert config.discord_app_bot_token == "bot-token"


@pytest.mark.parametrize("missing", sorted(_APP))
def test_setting_some_of_them_raises(missing: str) -> None:
    partial = {key: value for key, value in _APP.items() if key != missing}
    with pytest.raises(ValueError, match="Partial distributed Discord app config"):
        _config(**partial, messaging_public_url="https://switch.example")


def test_an_app_with_no_public_origin_raises() -> None:
    """The redirect is built from it, and Discord compares it byte for byte."""
    with pytest.raises(ValueError, match="MESSAGING_PUBLIC_URL"):
        _config(**_APP)


def test_the_gateway_url_does_not_stand_in_for_it() -> None:
    """They name different hosts and only one is a valid OAuth redirect origin."""
    with pytest.raises(ValueError, match="MESSAGING_PUBLIC_URL"):
        _config(**_APP, gateway_public_url="https://gateway.example")
