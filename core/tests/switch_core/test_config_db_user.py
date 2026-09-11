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


@pytest.mark.parametrize(
    "role", ["postgres", "switch_runtime", "_leading_underscore", "a" * 63]
)
def test_a_plain_identifier_is_accepted(role: str) -> None:
    assert _config(db_user=role).db_user == role


@pytest.mark.parametrize(
    "role",
    [
        'foo"bar',
        "foo';bar",
        "foo bar",
        "foo\\bar",
        "аdmin",  # Cyrillic а (U+0430), not Latin
        "1leading_digit",
        "a" * 64,
        "",
    ],
)
def test_a_role_name_outside_the_identifier_shape_raises(role: str) -> None:
    with pytest.raises(ValueError, match="DB_USER"):
        _config(db_user=role)
