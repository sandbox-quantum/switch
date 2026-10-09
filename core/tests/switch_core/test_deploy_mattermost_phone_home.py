"""Every Mattermost that Switch launches is told not to call Mattermost Inc.

Left at its defaults, Mattermost fetches in-product notices from
notices.mattermost.com and reports its server id, version, user and team
counts to securityupdatecheck.mattermost.com on boot and daily after that.
Its admin plugin marketplace calls api.integrations.mattermost.com, and with
diagnostics on, its crash reports go to Sentry. A bundled Mattermost is
Switch's to keep patched, so none of that is the operator's to discover.
"""

import re
from pathlib import Path

import pytest
import yaml

_REPO = Path(__file__).resolve().parents[3]

_NO_PHONE_HOME = {
    "MM_LOGSETTINGS_ENABLEDIAGNOSTICS": "false",
    "MM_LOGSETTINGS_ENABLESENTRY": "false",
    "MM_SERVICESETTINGS_ENABLESECURITYFIXALERT": "false",
    "MM_ANNOUNCEMENTSETTINGS_ADMINNOTICESENABLED": "false",
    "MM_ANNOUNCEMENTSETTINGS_USERNOTICESENABLED": "false",
    "MM_PLUGINSETTINGS_ENABLEREMOTEMARKETPLACE": "false",
}


@pytest.mark.parametrize(
    "compose",
    [
        "deploy/local/docker-compose.yml",
        "deploy/local/standalone-docker-compose.yml",
        "console/apps/switch-console-desktop/src/main/core/managed-switch-server/resources/standalone-docker-compose.pinned.yml",
    ],
)
def test_compose_mattermost_does_not_phone_home(compose: str) -> None:
    services = yaml.safe_load((_REPO / compose).read_text())["services"]
    environment = services["mattermost"]["environment"]
    assert {key: environment.get(key) for key in _NO_PHONE_HOME} == _NO_PHONE_HOME


def test_helm_mattermost_does_not_phone_home() -> None:
    template = (
        _REPO / "deploy/remote/helm/switch/templates/mattermost/deployment.yaml"
    ).read_text()
    found = {
        key: match.group(1)
        for key in _NO_PHONE_HOME
        if (match := re.search(rf'- name: {key}\n\s+value: "([^"]*)"', template))
    }
    assert found == _NO_PHONE_HOME
