"""Building the one deployment-level Teams app from `SwitchConfig`.

`TEAMS_APP_*` settings are validated in `test_config_teams_app.py`; this is
what `TeamsSharedApp.from_config` builds from them once they have passed —
which of the three credential shapes it constructs, and that a retired
notification key is still held for decrypting what was encrypted under it.
"""

from __future__ import annotations

from pathlib import Path

from switch_core.bridges.collaboration.teams.auth import (
    ClientCertificate,
    ClientSecret,
    FederatedTokenFile,
)
from switch_core.bridges.collaboration.teams.shared_app import (
    TeamsSharedApp,
    _notification_certificate_id,
)
from tests.switch_core.test_config_teams_app import (
    _APP,
    _CREDENTIAL_CERT,
    _CREDENTIAL_KEY,
    _TENANT,
    _config,
    _keypair,
    _without,
)


def test_a_secret_configuration_builds_a_secret_credential() -> None:
    app = TeamsSharedApp.from_config(_config(**_APP))

    assert app.app_id == _APP["teams_app_client_id"]
    assert isinstance(app.credential, ClientSecret)
    assert app.credential.secret == "secret"


def test_a_certificate_configuration_builds_a_certificate_credential() -> None:
    config = _config(
        **_without(
            "teams_app_client_secret",
            teams_app_certificate=_CREDENTIAL_CERT,
            teams_app_certificate_private_key=_CREDENTIAL_KEY,
        )
    )

    app = TeamsSharedApp.from_config(config)

    assert isinstance(app.credential, ClientCertificate)


def test_a_federated_token_file_configuration_builds_a_federated_credential(
    tmp_path: Path,
) -> None:
    token = tmp_path / "token"
    token.write_text("eyJ...")
    config = _config(
        **_without("teams_app_client_secret", teams_app_federated_token_file=str(token))
    )

    app = TeamsSharedApp.from_config(config)

    assert isinstance(app.credential, FederatedTokenFile)
    assert app.credential.path == str(token)


def test_a_retired_key_decrypts_what_a_live_key_cannot() -> None:
    """Graph goes on delivering notifications encrypted under a key being
    retired until its subscription runs out, so `from_config` must keep it
    rather than dropping it the moment a new current key is configured."""
    _, previous_key = _keypair()
    config = _config(**_APP, teams_app_notification_previous_private_key=previous_key)

    app = TeamsSharedApp.from_config(config)

    retired_id = _notification_certificate_id(previous_key)
    current_id = _notification_certificate_id(
        _APP["teams_app_notification_private_key"]
    )
    assert app._keyring.certificate_id == current_id
    assert retired_id != current_id
    assert retired_id in app._keyring._keys


def test_an_identity_is_built_for_the_organisation_asked_for_not_the_home_tenant() -> (
    None
):
    app = TeamsSharedApp.from_config(_config(**_APP))
    org_tenant = "99999999-0000-0000-0000-000000000009"

    identity = app.identity_for(org_tenant)

    assert identity.org_tenant_id == org_tenant
    assert identity.org_tenant_id != _TENANT
    assert identity.app_id == app.app_id
