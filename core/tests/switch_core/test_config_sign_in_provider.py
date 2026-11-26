import pytest
from pydantic import ValidationError

from switch_core.config import WORKOS_IDENTITY_ISSUER, SwitchConfig
from tests.switch_core.test_config_max_workspaces import _config

AUTHKIT = dict(
    gateway_sign_in_provider="workos",
    workos_client_id="client_EXAMPLE",
    workos_api_key="sk_test_example",  # gitleaks:allow
    gateway_oidc_redirect_url="https://switch.example.test/gateway/auth/oidc/callback",
)

OIDC = dict(
    gateway_oidc_issuer_url="https://idp.example.test",
    gateway_oidc_client_id="client_example",
    gateway_oidc_client_secret="placeholder",  # gitleaks:allow
    gateway_oidc_scopes="openid email profile",
)


def test_the_generic_client_is_the_default_and_off_until_configured() -> None:
    config = _config()
    assert config.gateway_sign_in_provider == "oidc"
    assert not config.gateway_sso_enabled
    assert config.identity_issuer is None


def test_the_generic_client_keeps_identities_under_its_issuer() -> None:
    config = _config(**OIDC)
    assert config.gateway_sso_enabled
    assert not config.gateway_workos_sign_in
    assert config.identity_issuer == "https://idp.example.test"


def test_authkit_sign_in_is_single_sign_on_under_a_fixed_issuer() -> None:
    config: SwitchConfig = _config(**AUTHKIT)
    assert config.gateway_sso_enabled
    assert config.gateway_workos_sign_in
    assert not config.gateway_oidc_enabled
    assert config.identity_issuer == WORKOS_IDENTITY_ISSUER


@pytest.mark.parametrize(
    "missing", ["workos_client_id", "workos_api_key", "gateway_oidc_redirect_url"]
)
def test_authkit_sign_in_needs_its_application_key_and_callback(missing: str) -> None:
    with pytest.raises(ValidationError, match=missing.upper()):
        _config(**{key: value for key, value in AUTHKIT.items() if key != missing})


@pytest.mark.parametrize("setting", sorted(OIDC))
def test_authkit_sign_in_refuses_the_generic_client(setting: str) -> None:
    with pytest.raises(ValidationError, match=setting.upper()):
        _config(**AUTHKIT, **{setting: OIDC[setting]})


def test_authkit_sign_in_refuses_login_options() -> None:
    with pytest.raises(ValidationError, match="GATEWAY_OIDC_LOGIN_OPTIONS"):
        _config(
            **AUTHKIT,
            gateway_oidc_login_options=[
                {
                    "id": "google",
                    "label": "Google",
                    "params": {"provider": "GoogleOAuth"},
                }
            ],
        )


def test_password_sign_up_stays_off_under_authkit() -> None:
    config = _config(**AUTHKIT, gateway_signup_enabled=True)
    assert not config.gateway_signup_open
