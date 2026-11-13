"""With no keyed-id key, the operator action routes answer 503 "Visibility
isn't set up on this server", as every other visibility route does, never a
500. Start-up leaves the hosted action sweeps out, so nothing keyless is left
on the app for the routes to pick up."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

import switch_core.main  # noqa: F401  (import order, as in test_route_guards)
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.hosted_operator_bearer import require_operator_bearer
from switch_core.main import _sweep_hosted_actions
from switch_core.visibility.guards import require_operator
from switch_core.visibility.keyed_id import KeyedIdKey
from switch_core.visibility.operator_action_routes import router
from switch_core.visibility.operator_actions import OperatorActions

ACTION = "00000000-0000-0000-0000-000000000000"
# A keyed id in form only; the dependency answers before the route reads it.
KEYED = "k1-" + "ab" * 16
REASON = {"reason": "a test reason"}

#: Every route that takes `get_operator_actions`, with a body that passes
#: validation, so only the dependency decides the answer.
ROUTES = (
    ("POST", f"/shared-cloud/boxes/{KEYED}/restart", REASON),
    ("POST", f"/shared-cloud/machines/{KEYED}/drain", REASON),
    ("GET", "/hosted-controller/actions?kind=restart", None),
    (
        "POST",
        f"/hosted-controller/actions/{ACTION}/steps",
        {"step": "claimed", "state": "running"},
    ),
)


def _no_database():
    raise AssertionError("no database call is expected without a keyed-id key")


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.state.keyed_id_key = None
    # Callers already authenticated: only the keyed-id key is under test.
    app.dependency_overrides[require_operator] = lambda: SimpleNamespace(id="u-op")
    app.dependency_overrides[require_operator_bearer] = lambda: None
    app.dependency_overrides[get_session_factory] = lambda: _no_database
    return app


async def _answers(app: FastAPI) -> list[tuple[str, int, object]]:
    found = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="https://switch.example.com",
    ) as client:
        for method, path, body in ROUTES:
            response = await client.request(method, path, json=body)
            found.append((path, response.status_code, response.json()))
    return found


@pytest.mark.parametrize("left_by_start_up", [False, True])
async def test_each_operator_action_route_answers_503_without_a_key(
    left_by_start_up: bool,
) -> None:
    """Also when an instance built without a key was left on the app, as
    start-up used to leave one."""
    app = _app()
    if left_by_start_up:
        app.state.operator_actions = OperatorActions(
            session_factory=_no_database,  # type: ignore[arg-type]
            key=None,  # type: ignore[arg-type]
        )
    for path, status, body in await _answers(app):
        assert status == 503, path
        assert body == {"detail": "Visibility isn't set up on this server"}, path


async def test_a_new_key_replaces_an_instance_built_without_one() -> None:
    app = _app()
    app.state.operator_actions = OperatorActions(
        session_factory=_no_database,  # type: ignore[arg-type]
        key=None,  # type: ignore[arg-type]
    )
    key = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")
    app.state.keyed_id_key = key
    from switch_core.visibility.operator_action_routes import get_operator_actions

    request = SimpleNamespace(app=app)
    actions = get_operator_actions(request, _no_database)  # type: ignore[arg-type]
    assert actions.key is key
    assert app.state.operator_actions is actions


async def test_start_up_skips_the_hosted_action_sweeps_without_a_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Nothing keyless is built or swept (the session factory is never used),
    and the skip is logged once."""
    app = FastAPI()
    app.state.keyed_id_key = None
    with caplog.at_level(logging.WARNING, logger="switch_core.main"):
        await _sweep_hosted_actions(
            app,
            _no_database,  # type: ignore[arg-type]
            SimpleNamespace(service=None),  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
        )
    assert getattr(app.state, "operator_actions", None) is None
    assert getattr(app.state, "hosted_access", None) is None
    skipped = [
        r
        for r in caplog.records
        if "Skipping the hosted action sweeps" in r.getMessage()
    ]
    assert len(skipped) == 1
