from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from switch_core.gateway.deeplink import router
from switch_core.gateway.dependencies import get_config


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    # The route only depends on get_config; a stub keeps the test self-contained.
    app.dependency_overrides[get_config] = lambda: object()
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
