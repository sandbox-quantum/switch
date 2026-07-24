from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from switch_core.bridges.agent.auth import BearerAuthMiddleware, _is_public_path
from switch_core.bridges.agent.deeplink import router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, follow_redirects=False)


def _client_with_auth() -> TestClient:
    """The route behind the real Bearer middleware, as it runs on the
    agent-bridge app — reproducing the no-token click from an external channel."""
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(
        BearerAuthMiddleware,
        agent_store=None,  # type: ignore[arg-type]
        api_key_store=None,  # type: ignore[arg-type]
        session_factory=None,  # type: ignore[arg-type]
    )
    return TestClient(app, follow_redirects=False)


class TestDeeplinkRedirect:
    def test_302_redirects_to_switchdash_deeplink(self) -> None:
        resp = _client().get(
            "/deeplink/session",
            params={"server": "https://s", "agent": "a", "room": "r", "session": "x"},
        )
        assert resp.status_code == 302
        location = resp.headers["location"]
        assert location.startswith("switchdash://session?")
        assert "room=r" in location
        assert "agent=a" in location

    def test_no_query_redirects_to_bare_deeplink(self) -> None:
        resp = _client().get("/deeplink/session")
        assert resp.status_code == 302
        assert resp.headers["location"] == "switchdash://session"


class TestDeeplinkIsPublic:
    """The redirect must bypass the agent-bridge Bearer auth — it is clicked
    from an external channel with no token (the 401 CHOO-1588 originally hit)."""

    def test_deeplink_session_path_is_public(self) -> None:
        assert _is_public_path("/deeplink/session") is True

    def test_deeplink_prefix_is_public(self) -> None:
        assert _is_public_path("/deeplink") is True

    def test_unrelated_path_is_not_public(self) -> None:
        assert _is_public_path("/agents/x") is False

    def test_redirect_works_through_bearer_middleware_without_token(self) -> None:
        # The exact CHOO-1588 regression: a no-token click returned 401
        # "Missing or invalid Authorization header" before /deeplink was public.
        resp = _client_with_auth().get(
            "/deeplink/session", params={"server": "https://s", "room": "r"}
        )
        assert resp.status_code == 302
        assert resp.headers["location"].startswith("switchdash://session?")
