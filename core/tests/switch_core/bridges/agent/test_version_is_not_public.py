"""Version disclosure is authenticated on every surface (CHOO-1865).

An exact release string maps directly to known CVEs, and Switch is deployed
publicly by people we will never meet. The rule is easy to break by accident —
adding one prefix to an allowlist is a one-line change — so it is pinned here
rather than left to review.
"""

from __future__ import annotations

import pytest

from switch_core.bridges.agent.auth import PUBLIC_PATH_PREFIXES, _is_public_path


@pytest.mark.parametrize(
    "path",
    ["/version", "/gateway/version", "/agents/a1/events"],
)
def test_version_bearing_paths_are_not_in_the_public_allowlist(path: str) -> None:
    # /gateway is allowlisted as a whole because the gateway runs its own
    # cookie auth rather than the bearer middleware — it is not unauthenticated.
    assert path not in PUBLIC_PATH_PREFIXES


def test_the_agent_bridge_version_endpoint_requires_authentication() -> None:
    assert _is_public_path("/version") is False


def test_the_unauthenticated_allowlist_has_not_grown() -> None:
    """A new public prefix must be a deliberate change, reviewed on purpose.

    Whoever adds one should have to update this test and say why in the commit
    — particularly for anything that could carry a version.
    """
    assert set(PUBLIC_PATH_PREFIXES) == {
        "/health",
        "/.well-known",
        "/oauth",
        "/gateway",
        "/deeplink",
        # Workspace installs of the distributed messaging apps: the OAuth
        # callback and the platforms' event webhooks. Public because the
        # callers are Slack and a browser mid-redirect, neither of which holds
        # a credential of ours. Nothing under it discloses a version, and each
        # route checks the platform's signature before it acts.
        "/messaging",
    }
