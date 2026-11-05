"""The Mattermost the e2e harness launches is told not to call Mattermost Inc.

Left at its defaults, Mattermost fetches in-product notices from
notices.mattermost.com and reports its server id, version, user and team
counts to securityupdatecheck.mattermost.com on boot and daily after that.
Its admin plugin marketplace calls api.integrations.mattermost.com, and with
diagnostics on, its crash reports go to Sentry. A test run has no business
reporting anything to anyone.
"""

from pathlib import Path

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


def test_e2e_mattermost_does_not_phone_home() -> None:
    services = yaml.safe_load(
        (_REPO / "deploy/local/docker-compose.e2e-mattermost.yml").read_text()
    )["services"]
    environment = services["mattermost"]["environment"]
    assert {key: environment.get(key) for key in _NO_PHONE_HOME} == _NO_PHONE_HOME
