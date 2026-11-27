"""The agent `/status` route answers a status line Switch refuses the way
`/message` answers a message: too long is 422, too fast is 429, never the
404 of an unknown room or a 500."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from switch_core.bridges.agent.api import handlers
from switch_core.delivery.send_limits import (
    MessageRefused,
    MessageTooLong,
    SendRateLimited,
)


class _RefusingProtocol:
    def __init__(self, refusal: MessageRefused) -> None:
        self._refusal = refusal

    async def update_status(self, agent_id: str, room_id: str, detail: str) -> None:
        raise self._refusal


@pytest.mark.parametrize(
    ("refusal", "status"),
    [
        (MessageTooLong(70_000, 65_536), 422),
        (SendRateLimited(retry_after=1.0, burst=30, per_second=2.0, first=True), 429),
    ],
)
async def test_a_refused_status_line_answers_as_a_refused_message_does(
    refusal: MessageRefused, status: int
) -> None:
    app = FastAPI()
    app.include_router(handlers.router, prefix="/agents")
    app.dependency_overrides[handlers.get_agent_from_scope] = lambda: SimpleNamespace(
        id="agent-1"
    )
    app.dependency_overrides[handlers.get_protocol] = lambda: _RefusingProtocol(refusal)

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/agents/agent-1/status", json={"room_id": "room-1", "detail": "working"}
        )

    assert response.status_code == status
    assert response.json() == {"detail": str(refusal)}
