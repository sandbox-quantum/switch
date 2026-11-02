import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from tests.switch_core.test_config_max_workspaces import _config

OIDC = dict(
    gateway_oidc_issuer_url="https://auth.example.test",
    gateway_oidc_client_id="client_example",
    gateway_oidc_client_secret="placeholder",  # gitleaks:allow
    gateway_oidc_scopes="openid email profile",
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
