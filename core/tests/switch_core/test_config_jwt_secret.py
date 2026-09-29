import pytest

from switch_core.config import SwitchConfig

# Exactly at the floor, so shortening it by one character is a boundary test
# rather than a different scenario. Not a key: it is a literal in a public
# repository, which is the one thing a real one can never be.
_AT_THE_FLOOR = "not-a-secret-placeholder-000000!"  # gitleaks:allow

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key=_AT_THE_FLOOR,
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_the_placeholder_is_the_length_the_tests_below_assume() -> None:
    assert len(_AT_THE_FLOOR) == 32


def test_a_key_at_the_floor_is_accepted() -> None:
    assert _config().jwt_secret_key == _AT_THE_FLOOR


def test_a_longer_key_is_accepted() -> None:
    generated = "0" * 64
    assert _config(jwt_secret_key=generated).jwt_secret_key == generated


@pytest.mark.parametrize("secret", ["", "abcdefgh", _AT_THE_FLOOR[:-1]])
def test_a_short_key_raises(secret: str) -> None:
    with pytest.raises(ValueError, match="JWT_SECRET_KEY"):
        _config(jwt_secret_key=secret)


def test_the_error_reports_the_length_and_not_the_key() -> None:
    # The message is headed for a log and a terminal, so it may say how short
    # the key is and must not say what it is.
    secret = "abcdefgh"
    with pytest.raises(ValueError) as excinfo:
        _config(jwt_secret_key=secret)
    message = str(excinfo.value)
    assert "got 8" in message
    assert secret not in message
