import pytest

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    gateway_admin_email="admin@example.com",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[arg-type]
        **{
            **_BASE_KWARGS,
            "db_password": "placeholder",  # gitleaks:allow
            "gateway_admin_password": "placeholder",  # gitleaks:allow
            **overrides,
        }
    )


def test_agent_oidc_off_needs_no_audience() -> None:
    assert _config().oauth_audience is None


def test_an_issuer_with_an_audience_is_accepted() -> None:
    config = _config(
        oauth_issuer_url="https://idp.example.invalid/realms/switch",
        oauth_audience="switch",
    )
    assert config.oauth_audience == "switch"


@pytest.mark.parametrize("audience", [None, ""])
def test_an_issuer_without_an_audience_raises(audience: str | None) -> None:
    # Without an audience, a token the IdP minted for any other application
    # would authenticate an agent here.
    with pytest.raises(ValueError, match="OAUTH_AUDIENCE"):
        _config(
            oauth_issuer_url="https://idp.example.invalid/realms/switch",
            oauth_audience=audience,
        )
