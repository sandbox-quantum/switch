"""A request the gateway refuses as invalid is not repeated back to the caller.

FastAPI's default 422 carries each error's `input`: the refused value, or for a
missing field the whole body around it. Every endpoint that takes a password
is driven here through the app `create_gateway_app` builds, so the test covers
the handler being registered as well as what it answers with. Validation fails
before any route body runs, so those tests need no database.

A bridge's connection config is validated inside the route instead, against
the platform's config model, and refused as text. A check across fields there
carries the whole config as its `input`, stored bot token included on an edit.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.slack.adapter import SlackConnectionConfig
from switch_core.db.models import Client, CollaborationBridge, User
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, require_admin
from switch_core.gateway.collaborations import create_bridge, update_bridge
from switch_core.gateway.dependencies import get_session, get_system_session
from switch_core.gateway.schemas import BridgeCreateRequest, BridgeUpdateRequest
from tests.switch_core.gateway.test_app_route_mounting import _app
from tests.switch_core.gateway.test_shared_bridge_registration import _Lifecycle

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


BOT_TOKEN = "stored-bot-token-for-tests-only"
_BRIDGE_STORE = CollaborationBridgeStore()
_ADMIN = User(id="admin", name="admin", email="admin@example.invalid", role="admin")


class _SlackLifecycle(_Lifecycle):
    """Validates a connection config the way the real lifecycle does: against
    the platform's own config model."""

    async def register(self, **kwargs: Any) -> None:
        SlackConnectionConfig.model_validate(kwargs["connection_config"])

    async def check_edited_connection_config(self, **kwargs: Any) -> None:
        SlackConnectionConfig.model_validate(kwargs["connection_config"])


def _assert_no_token(detail: object) -> None:
    # `str(ValidationError)` keeps the first ten and last six characters.
    assert BOT_TOKEN[:10] not in str(detail)
    assert BOT_TOKEN[-6:] not in str(detail)


async def test_a_refused_bridge_config_does_not_echo_its_token() -> None:
    with pytest.raises(HTTPException) as refused:
        await create_bridge(
            req=BridgeCreateRequest(
                bridge_type="slack",
                display_name="Acme",
                connection_config={"bot_token": BOT_TOKEN, "workspace_id": "T1"},
            ),
            session=None,  # type: ignore[arg-type]
            bridge_store=_BRIDGE_STORE,
            collab_lifecycle=_SlackLifecycle(),  # type: ignore[arg-type]
            user=_ADMIN,
        )

    assert refused.value.status_code == 422
    _assert_no_token(refused.value.detail)
    assert refused.value.detail == (
        "Value error, app_token is required: without it Switch opens no Socket "
        "Mode connection and this bridge would receive no Slack events at all."
    )


async def test_a_refused_bridge_edit_does_not_echo_the_stored_token(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The edit is validated merged with what is stored, so clearing the app
    token puts the stored bot token, which no response otherwise returns, in
    the error's `input`."""
    async with session_factory() as session:
        client = Client(
            transport_user_id="@bridge-validation-errors:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Acme",
            client_id=client.id,
            status="active",
            connection_config={
                "bot_token": BOT_TOKEN,
                "app_token": "stored-app-token",
                "workspace_id": "T1",
            },
        )
        session.add(bridge)
        await session.commit()

        with pytest.raises(HTTPException) as refused:
            await update_bridge(
                bridge_id=bridge.id,
                payload=BridgeUpdateRequest(connection_config={"app_token": ""}),
                session=session,
                bridge_store=_BRIDGE_STORE,
                room_store=RoomStore(),
                collab_lifecycle=_SlackLifecycle(),  # type: ignore[arg-type]
                user=_ADMIN,
            )

    assert refused.value.status_code == 422
    _assert_no_token(refused.value.detail)
    assert "app_token is required" in str(refused.value.detail)
