"""The gateway app is the one place every router is wired together.

A router that is built and tested on its own (`teams_placements.router`, say)
still has to actually be mounted for a request to reach it. This is the one
place that checks the mounting itself rather than the handlers behind it.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from switch_core.gateway.app import create_gateway_app


def _app() -> object:
    config = MagicMock()
    config.jwt_secret_key = "s" * 32
    config.gateway_oidc_enabled = False
    return create_gateway_app(
        agent_store=MagicMock(),
        room_store=MagicMock(),
        room_group_store=MagicMock(),
        room_service=MagicMock(),
        bridge_store=MagicMock(),
        client_lifecycle=MagicMock(),
        collab_lifecycle=MagicMock(),
        connector_lifecycle=MagicMock(),
        connector_store=MagicMock(),
        event_buffer=MagicMock(),
        session_factory=MagicMock(),
        user_store=MagicMock(),
        external_user_store=MagicMock(),
        api_key_store=MagicMock(),
        invitation_store=MagicMock(),
        join_domain_store=MagicMock(),
        template_store=MagicMock(),
        usage_store=MagicMock(),
        budget_store=MagicMock(),
        resource_service=MagicMock(),
        protocol=MagicMock(),
        install_service=None,
        invite_mailer=None,
        config=config,
    )


def test_the_teams_placement_routes_are_mounted_under_gateway_collaborations() -> None:
    app = _app()
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]

    assert "/collaborations/{bridge_id}/teams" in paths
    assert "/collaborations/{bridge_id}/teams/{team_id}" in paths
    assert "/collaborations/{bridge_id}/teams-package" in paths


def test_it_shares_the_prefix_with_the_ordinary_collaborations_routes() -> None:
    """Both routers answer under the same `/collaborations` prefix a bridge id
    is already namespaced under, rather than a prefix of their own."""
    app = _app()
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]

    assert "/collaborations/{bridge_id}" in paths  # the ordinary update route
    assert "/collaborations/{bridge_id}/teams" in paths  # the placement route
