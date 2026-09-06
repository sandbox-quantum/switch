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


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_default_ssl_mode_is_disable_and_yields_no_connect_args() -> None:
    config = _config()
    assert config.db_ssl_mode == "disable"
    assert config.db_connect_args == {}


@pytest.mark.parametrize(
    "mode", ["allow", "prefer", "require", "verify-ca", "verify-full"]
)
def test_non_disable_ssl_mode_forwards_ssl_connect_arg(mode: str) -> None:
    config = _config(db_ssl_mode=mode)
    assert config.db_connect_args == {"ssl": mode}


def test_invalid_ssl_mode_raises() -> None:
    with pytest.raises(ValueError, match="DB_SSL_MODE"):
        _config(db_ssl_mode="bogus")
