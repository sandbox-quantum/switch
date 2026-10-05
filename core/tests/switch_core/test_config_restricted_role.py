import pytest

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    id_server_name="switch.local",
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


@pytest.mark.parametrize("mode", ["default_tenant", "invite_only"])
def test_opting_out_is_accepted_where_people_cannot_make_workspaces(
    mode: str,
) -> None:
    config = _config(db_require_restricted_role=False, gateway_signup_mode=mode)
    assert config.db_require_restricted_role is False


def test_opting_out_with_open_signup_raises() -> None:
    with pytest.raises(ValueError, match="DB_REQUIRE_RESTRICTED_ROLE"):
        _config(db_require_restricted_role=False, gateway_signup_mode="open")


def test_open_signup_with_the_check_on_is_accepted() -> None:
    assert _config(gateway_signup_mode="open").gateway_signup_mode == "open"
