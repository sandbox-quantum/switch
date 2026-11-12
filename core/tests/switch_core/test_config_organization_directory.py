import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from tests.switch_core.test_config_max_workspaces import _config

OIDC = dict(
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
    with pytest.raises(ValidationError, match="GATEWAY_OIDC"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
        )


@pytest.mark.parametrize("mode", ["open", "default_tenant"])
def test_workos_with_self_service_sign_up_is_refused(mode: str) -> None:
    with pytest.raises(ValidationError, match="invite_only"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
            **{**OIDC, "gateway_signup_mode": mode},
        )


CHANGES = dict(
    members_service_url="https://members.example.test",
    workos_client_id="client_EXAMPLE",
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


@pytest.mark.parametrize("missing", sorted(CHANGES))
def test_changes_sent_to_workos_need_all_three_settings(missing: str) -> None:
    with pytest.raises(ValidationError, match="set together"):
        _config(
            organization_directory="workos",
            workos_api_key="sk_test_example",  # gitleaks:allow
            **OIDC,
            **{key: value for key, value in CHANGES.items() if key != missing},
        )


def test_changes_sent_to_workos_need_the_workos_directory() -> None:
    with pytest.raises(ValidationError, match="ORGANIZATION_DIRECTORY=workos"):
        _config(**CHANGES)
