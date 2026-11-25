import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from tests.switch_core.test_config_max_workspaces import _config

OIDC = dict(
    gateway_sign_in_provider="workos",
    workos_client_id="client_EXAMPLE",
    gateway_oidc_redirect_url="https://switch.example.test/gateway/auth/oidc/callback",
    gateway_signup_mode="invite_only",
)

CONNECT = dict(
    gateway_oidc_issuer_url="https://auth.example.test",
    gateway_oidc_client_id="client_example",
    gateway_oidc_client_secret="placeholder",  # gitleaks:allow
    gateway_oidc_scopes="openid email profile",
    gateway_signup_mode="invite_only",
)


def test_a_server_keeps_its_own_organizations_by_default() -> None:
    assert _config().organization_directory == "local"


def test_workos_with_its_key_and_sign_in_is_accepted() -> None:
    config: SwitchConfig = _config(
        organization_directory="workos",
        workos_api_key="sk_test_example",  # gitleaks:allow
        **OIDC,
    )
    assert config.organization_directory == "workos"


def test_workos_without_its_key_is_refused() -> None:
    with pytest.raises(ValidationError, match="WORKOS_API_KEY"):
        _config(organization_directory="workos", **OIDC)


def test_workos_without_the_sign_in_is_refused() -> None:
    with pytest.raises(ValidationError, match="GATEWAY_SIGN_IN_PROVIDER=workos"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
        )


def test_workos_signing_in_through_a_connect_application_is_refused() -> None:
    with pytest.raises(ValidationError, match="GATEWAY_SIGN_IN_PROVIDER=workos"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
            **CONNECT,
        )


def test_workos_turns_the_password_form_off_by_default() -> None:
    config: SwitchConfig = _config(
        organization_directory="workos",
        workos_api_key="sk_test_example",  # gitleaks:allow
        **OIDC,
    )
    assert not config.gateway_password_login_enabled


def test_workos_keeps_the_password_form_a_deployment_turns_on() -> None:
    config: SwitchConfig = _config(
        organization_directory="workos",
        workos_api_key="sk_test_example",  # gitleaks:allow
        gateway_password_login_enabled=True,
        **OIDC,
    )
    assert config.gateway_password_login_enabled


def test_the_local_directory_keeps_the_password_form_by_default() -> None:
    assert _config().gateway_password_login_enabled


def test_workos_with_open_sign_up_is_accepted() -> None:
    config: SwitchConfig = _config(
        organization_directory="workos",
        workos_api_key="sk_test_example",  # gitleaks:allow
        **{**OIDC, "gateway_signup_mode": "open"},
    )
    assert config.gateway_signup_mode == "open"


def test_workos_with_the_default_tenant_is_refused() -> None:
    with pytest.raises(ValidationError, match="default_tenant"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
            **{**OIDC, "gateway_signup_mode": "default_tenant"},
        )


CHANGES = dict(
    members_service_url="https://members.example.test",
    workos_redirect_url="https://switch.example.test/gateway/auth/workos/callback",
)


def test_changes_sent_to_workos_are_accepted_with_all_three_settings() -> None:
    config: SwitchConfig = _config(
        organization_directory="workos",
        workos_api_key="sk_test_example",  # gitleaks:allow
        **OIDC,
        **CHANGES,
    )
    assert config.members_service_url == "https://members.example.test"


@pytest.mark.parametrize("missing", ["members_service_url", "workos_redirect_url"])
def test_the_members_service_and_its_callback_are_set_together(missing: str) -> None:
    with pytest.raises(ValidationError, match="set together"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
            **OIDC,
            **{key: value for key, value in CHANGES.items() if key != missing},
        )


def test_workos_with_authkit_sign_in_is_accepted() -> None:
    config: SwitchConfig = _config(
        organization_directory="workos",
        gateway_signup_mode="invite_only",
        gateway_sign_in_provider="workos",
        workos_api_key="sk_test_example",  # gitleaks:allow
        workos_client_id="client_EXAMPLE",
        gateway_oidc_redirect_url="https://switch.example.test/gateway/auth/oidc/callback",
    )
    assert config.identity_issuer == "https://api.workos.com/user_management"


def test_changes_sent_to_workos_need_the_workos_directory() -> None:
    with pytest.raises(ValidationError, match="ORGANIZATION_DIRECTORY=workos"):
        _config(**CHANGES)
