"""The connector apps and broker startup builds, under SERVICE_ACCESS_PROFILES.

Every app a sign-in goes through, the server's and each organization's, asks
for what the profile does, and sessions are given its skill.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from switch_core.connections.adapters.oauth import OAuthClientCredentials
from switch_core.connections.loader import CATALOG
from switch_core.connections.organization_apps import OrganizationApps
from switch_core.connections.registry import ClientRegistration
from switch_core.db.stores.organization_app_credential_store import (
    OrganizationAppCredentialStore,
)
from switch_core.main import build_connector_apps, build_service_broker
from tests.conftest import TEST_KEYRING
from tests.switch_core.connections.adapters.test_github import _config

GOOGLE = "google-workspace"


async def test_every_google_app_offers_the_profile_the_server_chose(
    session_factory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client_file = tmp_path / "google.json"
    client_file.write_text(
        json.dumps({"client_id": "server-client", "client_secret": "example-secret"})
    )
    monkeypatch.setenv("GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH", str(client_file))
    config = _config(
        gateway_public_url="https://switch.example.test",
        service_access_profiles={GOOGLE: "drive-file"},
    )
    registration = ClientRegistration(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        public_url=config.gateway_public_url,
        server_name="switch.local",
    )
    async with httpx.AsyncClient() as http:
        apps = build_connector_apps(
            config,
            session_factory=session_factory,
            http=http,
            registration=registration,
        )
        await apps.load()
        organization_apps = OrganizationApps(
            apps=apps, store=OrganizationAppCredentialStore(TEST_KEYRING)
        )
        broker = build_service_broker(
            config,
            apps,
            organization_apps,
            session_factory=session_factory,
            http=http,
            registration=registration,
            telemetry=None,
        )

    profile = CATALOG[GOOGLE].definition.access_profiles["drive-file"]
    skill = CATALOG[GOOGLE].skill_files[profile.skill]
    assert apps.definition(GOOGLE).access == profile.access
    assert broker._catalog[GOOGLE].definition.access == profile.access
    assert broker._catalog[GOOGLE].skill_files["SKILL.md"] == skill
    assert broker._adapters[GOOGLE]._definition.access == profile.access  # type: ignore[attr-defined]
    # An organization's app is built by the same ConnectorApps.
    organization_adapter = apps.build(
        GOOGLE,
        github_app=None,
        oauth_client=OAuthClientCredentials(
            client_id="organization-client",
            client_secret="example-secret",
            authentication=None,
        ),
    )
    assert organization_adapter is not None
    assert organization_adapter._definition.access == profile.access  # type: ignore[attr-defined]
    assert broker._organization_apps is organization_apps
