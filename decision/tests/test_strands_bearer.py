"""The Strands server's bearer token (model-servers/strands/bearer.py), tested
without serve.py, which needs torch and loads the model when imported."""

import importlib.util
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_PATH = Path(__file__).parents[1] / "model-servers" / "strands" / "bearer.py"
_spec = importlib.util.spec_from_file_location("strands_bearer", _PATH)
assert _spec is not None and _spec.loader is not None
bearer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bearer)


def _app(key: str | None) -> TestClient:
    app = FastAPI()
    bearer.require_bearer(app, key)

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.post("/v1/systemone")
    def systemone() -> dict:
        return {"answers": {}}

    return TestClient(app)


@pytest.mark.parametrize(
    ("header", "ok"),
    [
        ("Bearer s3cret", True),
        ("bearer  s3cret ", True),
        ("Bearer wrong", False),
        ("Bearer s3cret2", False),
        ("Basic s3cret", False),
        ("s3cret", False),
        ("", False),
        (None, False),
    ],
)
def test_authorized(header, ok):
    assert bearer.authorized(header, "s3cret") is ok


def test_with_a_key_only_health_is_open():
    tc = _app("s3cret")
    assert tc.get("/health").status_code == 200
    assert tc.post("/v1/systemone", json={}).status_code == 401
    wrong = {"Authorization": "Bearer wrong"}
    assert tc.post("/v1/systemone", json={}, headers=wrong).status_code == 401
    right = {"Authorization": "Bearer s3cret"}
    assert tc.post("/v1/systemone", json={}, headers=right).status_code == 200
    # Only GET /health: any other method or path needs the key.
    assert tc.post("/health").status_code == 401
    assert tc.get("/docs").status_code == 401


@pytest.mark.parametrize("key", [None, ""])
def test_without_a_key_everything_is_open(key):
    tc = _app(key)
    assert tc.post("/v1/systemone", json={}).status_code == 200
    assert tc.get("/health").status_code == 200
