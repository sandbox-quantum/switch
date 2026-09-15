"""Half-configuring the distributed Slack app has to be a startup error.

Each of the three credentials fails differently and none of them fails
usefully. Without the client id and secret the code exchange is refused by
Slack; without the signing secret there is nothing distinguishing a real event
from a post by anyone who found the URL. A deployment that sets two of three
looks configured, offers the button, and breaks at the worst moment — so it
does not start.
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
    slack_app_client_id="1234.5678",
    slack_app_client_secret="secret",
    slack_app_signing_secret="signing",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_setting_none_of_them_is_the_ordinary_case() -> None:
    assert _config().slack_app_client_id is None


def test_setting_all_three_with_a_public_origin_is_accepted() -> None:
    config = _config(**_APP, gateway_public_url="https://switch.example")
    assert config.slack_app_signing_secret == "signing"


@pytest.mark.parametrize("missing", sorted(_APP))
def test_setting_some_of_them_raises(missing: str) -> None:
    partial = {key: value for key, value in _APP.items() if key != missing}
    with pytest.raises(ValueError, match="Partial distributed Slack app config"):
        _config(**partial, gateway_public_url="https://switch.example")


def test_an_app_with_no_public_origin_raises() -> None:
    """The redirect and the events URL are both built from it.

    Slack compares the redirect against the one registered with the app, so
    building it against nothing is an install that fails at Slack with nothing
    in our logs.
    """
    with pytest.raises(ValueError, match="GATEWAY_PUBLIC_URL"):
        _config(**_APP)
