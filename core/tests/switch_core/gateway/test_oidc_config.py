from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from switch_core.gateway.auth import hash_password, verify_password


def _kwargs(**overrides: object) -> dict[str, object]:
    """A minimal but complete set of required SwitchConfig fields.

    OIDC fields are passed explicitly (defaulting to None) so ambient env vars
    can't leak into these tests.
    """
    base: dict[str, object] = dict(
        db_host="h",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        matrix_server_name="m",
        agent_registration_token="t",
        jwt_secret_key="secret",
        gateway_admin_email="a@b.c",
        gateway_admin_password="pw",
        gateway_oidc_issuer_url=None,
        gateway_oidc_client_id=None,
        gateway_oidc_client_secret=None,
    )
    base.update(overrides)
    return base


class TestGatewayOidcConfig:
    def test_disabled_when_none_set(self) -> None:
        config = SwitchConfig(**_kwargs())  # type: ignore[arg-type]
        assert config.gateway_oidc_enabled is False
        # Password login is on by default.
        assert config.gateway_password_login_enabled is True

    def test_enabled_when_all_three_set(self) -> None:
        config = SwitchConfig(
            **_kwargs(
                gateway_oidc_issuer_url="https://idp.example/realms/x",
                gateway_oidc_client_id="cid",
                gateway_oidc_client_secret="secret",
            )  # type: ignore[arg-type]
        )
        assert config.gateway_oidc_enabled is True
        assert config.gateway_oidc_metadata_url == (
            "https://idp.example/realms/x/.well-known/openid-configuration"
        )

    def test_partial_config_fails_loud(self) -> None:
        # Issuer set but client id/secret missing must raise at construction,
        # not silently disable OIDC.
        with pytest.raises(ValidationError):
            SwitchConfig(
                **_kwargs(gateway_oidc_issuer_url="https://idp.example")  # type: ignore[arg-type]
            )


class TestVerifyPassword:
    def test_none_hash_is_false_not_error(self) -> None:
        # OIDC-provisioned users have password_hash=None; password login must
        # fail cleanly rather than raising.
        assert verify_password("anything", None) is False

    def test_roundtrip(self) -> None:
        h = hash_password("hunter2")
        assert verify_password("hunter2", h) is True
        assert verify_password("wrong", h) is False
