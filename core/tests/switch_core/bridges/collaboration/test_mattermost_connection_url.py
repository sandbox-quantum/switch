"""Mattermost driver URLs match the server URL accepted by the connector."""

from __future__ import annotations

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


@pytest.mark.parametrize(
    ("url", "api_url"),
    [
        ("https://[2001:db8::1]", "https://[2001:db8::1]:443/api/v4"),
        (
            "https://chat.example.invalid/mattermost/",
            "https://chat.example.invalid:443/mattermost/api/v4",
        ),
        ("chat.example.invalid:8067", "http://chat.example.invalid:8067/api/v4"),
        ("chat.example.invalid", "http://chat.example.invalid:8065/api/v4"),
    ],
)
def test_driver_uses_the_configured_server_url(url: str, api_url: str) -> None:
    config = MattermostConnectionConfig(
        url=url, admin_user="example", admin_password="placeholder", team_name="example"
    )
    driver = MattermostAdapter(config=config)._create_driver()
    assert driver.client.url == api_url
