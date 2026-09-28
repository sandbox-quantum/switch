"""Half-configuring the distributed Telegram app has to be a startup error.

The token without the secret is a bot that accepts any post to its webhook;
the secret without the token is nothing to receive for. And the values Telegram
itself would refuse — a malformed secret, a port it will not deliver to — are
refused here, where the message can say so, rather than in a background task
at boot where they would read as Telegram being unreachable.
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
    telegram_app_bot_token="123456:placeholder-token",
    telegram_app_webhook_secret="placeholder-secret",
)

_ORIGIN = "https://switch.example"


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_setting_neither_is_the_ordinary_case() -> None:
    assert _config().telegram_app_bot_token is None


def test_setting_both_with_a_public_origin_is_accepted() -> None:
    config = _config(**_APP, messaging_public_url=_ORIGIN)
    assert config.telegram_app_webhook_secret == "placeholder-secret"


@pytest.mark.parametrize("missing", sorted(_APP))
def test_setting_one_raises(missing: str) -> None:
    partial = {key: value for key, value in _APP.items() if key != missing}
    with pytest.raises(ValueError, match="Partial distributed Telegram app config"):
        _config(**partial, messaging_public_url=_ORIGIN)


def test_an_app_with_no_public_origin_raises() -> None:
    with pytest.raises(ValueError, match="MESSAGING_PUBLIC_URL"):
        _config(**_APP)


@pytest.mark.parametrize("secret", ["has space", "has/slash", "x" * 257, "ümlaut"])
def test_a_secret_telegram_would_refuse_raises(secret: str) -> None:
    with pytest.raises(ValueError, match="TELEGRAM_APP_WEBHOOK_SECRET"):
        _config(
            **{**_APP, "telegram_app_webhook_secret": secret},
            messaging_public_url=_ORIGIN,
        )


def test_a_token_not_shaped_like_one_raises() -> None:
    with pytest.raises(ValueError, match="TELEGRAM_APP_BOT_TOKEN"):
        _config(
            **{**_APP, "telegram_app_bot_token": "not-a-token"},
            messaging_public_url=_ORIGIN,
        )


@pytest.mark.parametrize("port", [443, 80, 88, 8443])
def test_the_ports_telegram_delivers_to_are_accepted(port: int) -> None:
    _config(**_APP, messaging_public_url=f"https://switch.example:{port}")


def test_any_other_port_raises() -> None:
    with pytest.raises(ValueError, match="8443"):
        _config(**_APP, messaging_public_url="https://switch.example:8080")
