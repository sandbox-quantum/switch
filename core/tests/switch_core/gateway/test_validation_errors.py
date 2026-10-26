"""A request the gateway refuses as invalid is not repeated back to the caller.

FastAPI's default 422 carries each error's `input`: the refused value, or for a
missing field the whole body around it. Every endpoint that takes a password
is driven here through the app `create_gateway_app` builds, so the test covers
the handler being registered as well as what it answers with. Validation fails
before any route body runs, so nothing here needs a database.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.dependencies import get_session, get_system_session
from tests.switch_core.gateway.test_app_route_mounting import _app

SECRET = "correct horse battery staple"
SHORT_SECRET = "short7!"


async def _no_session() -> AsyncIterator[MagicMock]:
    yield MagicMock()


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    app: Any = _app()
    admin = SimpleNamespace(id="admin-id", email="admin@example.invalid", role="admin")
    app.dependency_overrides[get_session] = _no_session
    app.dependency_overrides[get_system_session] = _no_session
    app.dependency_overrides[get_current_user] = lambda: admin
    app.dependency_overrides[require_admin] = lambda: admin
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest.mark.parametrize(
    ("method", "path", "body", "secrets", "field"),
    [
        pytest.param(
            "POST",
            "/auth/signup",
            {"email": "new@example.invalid", "password": SHORT_SECRET},
            [SHORT_SECRET],
            "password",
            id="signup-short-password",
        ),
        pytest.param(
            "POST",
            "/auth/signup",
            {"password": SECRET},
            [SECRET],
            "email",
            id="signup-missing-email",
        ),
        pytest.param(
            "POST",
            "/auth/login",
            {"password": SECRET},
            [SECRET],
            "email",
            id="login-missing-email",
        ),
        pytest.param(
            "PUT",
            "/auth/me/password",
            {"current_password": SECRET, "new_password": SHORT_SECRET},
            [SECRET, SHORT_SECRET],
            "new_password",
            id="change-password-short-new-password",
        ),
        pytest.param(
            "PUT",
            "/auth/me/password",
            {"current_password": SECRET},
            [SECRET],
            "new_password",
            id="change-password-missing-new-password",
        ),
        pytest.param(
            "POST",
            "/users",
            {"name": "Ada", "email": "ada@example.invalid", "password": SHORT_SECRET},
            [SHORT_SECRET],
            "password",
            id="create-user-short-password",
        ),
        pytest.param(
            "POST",
            "/users",
            {"email": "ada@example.invalid", "password": SECRET},
            [SECRET],
            "name",
            id="create-user-missing-name",
        ),
    ],
)
async def test_a_refused_request_does_not_echo_its_password(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    body: dict[str, str],
    secrets: list[str],
    field: str,
) -> None:
    response = await client.request(method, path, json=body)

    assert response.status_code == 422, response.text
    for secret in secrets:
        assert secret not in response.text
    [error] = response.json()["detail"]
    assert set(error) == {"type", "loc", "msg"}
    assert error["loc"] == ["body", field]


async def test_the_answer_still_says_what_is_wrong(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/auth/signup", json={"email": "new@example.invalid", "password": "x" * 80}
    )

    assert response.status_code == 422, response.text
    assert response.json() == {
        "detail": [
            {
                "type": "value_error",
                "loc": ["body", "password"],
                "msg": "Value error, Password must be at most 72 bytes.",
            }
        ]
    }
