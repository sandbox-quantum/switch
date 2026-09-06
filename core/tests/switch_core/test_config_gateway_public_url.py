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


def test_unset_gateway_public_url_is_allowed() -> None:
    assert _config().gateway_public_url is None


@pytest.mark.parametrize(
    "url",
    ["https://gateway.example", "https://gateway.example/", "http://localhost:8000"],
)
def test_scheme_and_host_only_url_is_accepted(url: str) -> None:
    assert _config(gateway_public_url=url).gateway_public_url == url


@pytest.mark.parametrize(
    "url",
    ["https://gateway.example/api", "gateway.example", "/deeplink", "https://"],
)
def test_url_with_path_or_missing_host_raises(url: str) -> None:
    with pytest.raises(ValueError, match="GATEWAY_PUBLIC_URL"):
        _config(gateway_public_url=url)
