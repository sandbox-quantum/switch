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

_SMTP = dict(
    gateway_smtp_host="smtp.example.com",
    gateway_smtp_from="invites@example.com",
    frontend_base_url="https://switch.example.com",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_mail_is_off_by_default() -> None:
    assert _config().invite_email_enabled is False


def test_a_host_with_a_sender_and_a_link_origin_turns_it_on() -> None:
    assert _config(**_SMTP).invite_email_enabled is True


@pytest.mark.parametrize(
    ("missing", "named"),
    [
        ("gateway_smtp_from", "GATEWAY_SMTP_FROM"),
        ("frontend_base_url", "FRONTEND_BASE_URL"),
    ],
)
def test_a_host_without_what_the_e_mail_needs_refuses_to_start(
    missing: str, named: str
) -> None:
    with pytest.raises(ValueError, match=named):
        _config(**{**_SMTP, missing: None})


@pytest.mark.parametrize(
    "credentials",
    [{"gateway_smtp_username": "relay-user"}, {"gateway_smtp_password": "placeholder"}],
)
def test_half_a_credential_refuses_to_start(credentials: dict[str, str]) -> None:
    with pytest.raises(ValueError, match="set together"):
        _config(**_SMTP, **credentials)


def test_the_daily_cap_must_allow_at_least_one() -> None:
    with pytest.raises(ValueError, match="GATEWAY_INVITE_EMAILS_PER_DAY"):
        _config(gateway_invite_emails_per_day=0)


def test_empty_values_from_an_uncommented_env_file_mean_unset() -> None:
    config = _config(
        gateway_smtp_host="", gateway_smtp_username="", gateway_smtp_password=""
    )

    assert config.invite_email_enabled is False
