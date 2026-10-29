"""What a GitHub App's settings must be, and a refusal that names what is wrong."""

from __future__ import annotations

import pytest

from switch_core.providers.github import GitHubConnections


def _connections(**overrides: str) -> GitHubConnections:
    settings = {
        "client_id": "example-client",
        "client_secret": "SYNTHETIC-PLACEHOLDER",
        "slug": "example-app",
        "origin": "https://switch.example.com",
        **overrides,
    }
    return GitHubConnections(**settings)


@pytest.mark.parametrize(
    "origin",
    [
        "https://switch.example.com",
        "https://switch.example.com/",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://[::1]:8000",
    ],
)
def test_github_calls_back_to_https_or_to_loopback_http(origin: str) -> None:
    connections = _connections(origin=origin)
    assert connections.callback == (
        origin.rstrip("/") + "/gateway/provider-connections/github/callback"
    )


def test_any_other_http_origin_is_refused_for_what_it_is() -> None:
    with pytest.raises(ValueError) as refused:
        _connections(origin="http://switch.example.com")
    assert str(refused.value) == (
        "The GitHub App's origin 'http://switch.example.com' is neither https nor "
        "loopback http (localhost, 127.0.0.1 or ::1): GitHub sends people back to "
        "Switch only there."
    )


@pytest.mark.parametrize(
    "origin",
    [
        "https://switch.example.com/switch",
        "https://switch.example.com?x=1",
        "https://user@switch.example.com",
        "http://127.0.0.1:8000/path",
    ],
)
def test_an_origin_with_more_than_scheme_and_host_is_refused(origin: str) -> None:
    with pytest.raises(ValueError, match="is not a bare origin"):
        _connections(origin=origin)


def test_a_slug_github_would_not_have_is_refused() -> None:
    with pytest.raises(ValueError, match="slug 'Example App'"):
        _connections(slug="Example App")


@pytest.mark.parametrize("missing", ["client_id", "client_secret"])
def test_a_missing_client_id_or_secret_is_refused(missing: str) -> None:
    with pytest.raises(ValueError, match="needs a client id and a client secret"):
        _connections(**{missing: ""})
