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


def test_a_server_that_chooses_nothing_offers_every_entry_as_shipped() -> None:
    assert _config().service_access_profiles == {}


def test_a_server_names_a_profile_per_service() -> None:
    config = _config(service_access_profiles={"google-workspace": "drive-file"})
    assert config.service_access_profiles == {"google-workspace": "drive-file"}


def test_the_setting_is_read_from_the_environment_as_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SERVICE_ACCESS_PROFILES", '{"google-workspace": "drive-file"}')
    assert _config().service_access_profiles == {"google-workspace": "drive-file"}


@pytest.mark.parametrize(
    ("profiles", "message"),
    [
        ({"Google Workspace": "drive-file"}, "invalid service"),
        ({"google-workspace": "Drive File"}, "invalid profile for google-workspace"),
        ({"google-workspace": ""}, "invalid profile for google-workspace"),
    ],
)
def test_a_malformed_setting_stops_the_server(profiles: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        _config(service_access_profiles=profiles)
