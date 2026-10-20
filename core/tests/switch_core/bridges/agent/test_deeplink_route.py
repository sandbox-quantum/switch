from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
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
        api_key_cache=ApiKeyCache(ttl_seconds=0, max_entries=1),
        session_factory=None,  # type: ignore[arg-type]
    )
    return TestClient(app, follow_redirects=False)


class TestDeeplinkHandoff:
    """The click lands here and has to reach the desktop app.

    It used to be a bare 302. A browser handing off to a desktop app leaves the
    tab on whatever it last rendered, and a 302 renders nothing — so on Teams
    the tab sat on Defender's "Verifying link . . ." interstitial long after
    Switch Console had opened, reading as a link that hung.
    """

    def test_the_page_points_at_the_switchdash_deeplink(self) -> None:
        resp = _client().get(
            "/deeplink/session",
            params={"server": "https://s", "agent": "a", "room": "r", "session": "x"},
        )

        assert resp.status_code == 200
        assert "switchdash://session?" in resp.text
        assert "room=r" in resp.text
        assert "agent=a" in resp.text

    def test_no_query_still_reaches_the_bare_deeplink(self) -> None:
        resp = _client().get("/deeplink/session")

        assert resp.status_code == 200
        assert 'href="switchdash://session"' in resp.text

    def test_page_shows_waiting_and_success_states(self) -> None:
        resp = _client().get("/deeplink/session", params={"room": "r"})

        assert "window.close()" not in resp.text
        assert "visibilitychange" in resp.text
        assert "Opening Switch Console" in resp.text
        assert "Switch Console is open" in resp.text
        assert "Open manually" in resp.text

    def test_a_manual_link_survives_without_javascript(self) -> None:
        resp = _client().get("/deeplink/session", params={"room": "r"})

        assert 'href="switchdash://session?room=r"' in resp.text
        assert "Open manually" in resp.text


class TestDeeplinkQueryIsEscaped:
    """The endpoint is public and its query comes from whoever clicked it, so
    the target now lands in HTML rather than a Location header."""

    def test_a_quote_in_the_query_cannot_break_out_of_the_attribute(self) -> None:
        resp = _client().get('/deeplink/session?room="><script>alert(1)</script>')

        assert "<script>alert(1)</script>" not in resp.text
        assert "&lt;script&gt;" in resp.text or "%3Cscript%3E" in resp.text

    def test_the_scheme_cannot_be_changed_by_the_caller(self) -> None:
        resp = _client().get("/deeplink/session?room=javascript:alert(1)")

        # The anchor is anchored: scheme and host are constants prepended here.
        assert 'href="switchdash://session?' in resp.text
        assert 'href="javascript:' not in resp.text


class TestDeeplinkIsPublic:
    """The handoff must bypass the agent-bridge Bearer auth — it is clicked
    from an external channel with no token (the 401 CHOO-1588 originally hit)."""

    def test_deeplink_session_path_is_public(self) -> None:
        assert _is_public_path("/deeplink/session") is True

    def test_deeplink_prefix_is_public(self) -> None:
        assert _is_public_path("/deeplink") is True

    def test_unrelated_path_is_not_public(self) -> None:
        assert _is_public_path("/agents/x") is False

    def test_handoff_works_through_bearer_middleware_without_token(self) -> None:
        # The exact CHOO-1588 regression: a no-token click returned 401
        # "Missing or invalid Authorization header" before /deeplink was public.
        resp = _client_with_auth().get(
            "/deeplink/session", params={"server": "https://s", "room": "r"}
        )

        assert resp.status_code == 200
        assert "switchdash://session?" in resp.text


class TestConsolePageHandoff:
    """`/deeplink/open/<page>`: the https form of a link to a Console page,
    which bridges post where the platform cannot open `switchdash://`."""

    def test_a_valid_page_hands_off_to_its_console_link(self) -> None:
        resp = _client().get("/deeplink/open/agent/abc", params={"tab": "settings"})

        assert resp.status_code == 200
        assert 'href="switchdash://open/agent/abc?tab=settings"' in resp.text
        assert "your agent&#x27;s settings" in resp.text
        assert "Get Switch Console" in resp.text
        assert "Open manually" in resp.text

    def test_a_page_whose_name_has_a_slash(self) -> None:
        resp = _client().get("/deeplink/open/messaging-apps/connect")

        assert resp.status_code == 200
        assert 'href="switchdash://open/messaging-apps/connect"' in resp.text

    @pytest.mark.parametrize(
        "path",
        [
            "/deeplink/open/nowhere",
            "/deeplink/open/agent",
            "/deeplink/open/",
            "/deeplink/open/agent/abc?tab=logs",
            "/deeplink/open/room/%3Cscript%3E",
        ],
    )
    def test_anything_console_does_not_open_is_not_found(self, path: str) -> None:
        assert _client().get(path).status_code == 404

    def test_the_query_cannot_break_out_of_the_attribute(self) -> None:
        resp = _client().get('/deeplink/open/home?server="><script>alert(1)</script>')

        assert resp.status_code == 200
        assert "<script>alert(1)</script>" not in resp.text

    def test_it_is_public(self) -> None:
        assert _is_public_path("/deeplink/open/home") is True
        resp = _client_with_auth().get("/deeplink/open/rooms")

        assert resp.status_code == 200
        assert 'href="switchdash://open/rooms"' in resp.text
