import logging
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient, Response
from pydantic import BaseModel, field_validator

from switch_core.bridges.agent.app import log_http_exceptions, log_validation_errors


class _Body(BaseModel):
    text: str


class _Checked(BaseModel):
    room: str

    @field_validator("room")
    @classmethod
    def _refuse(cls, value: str) -> str:
        raise ValueError("no such room")


def _app() -> FastAPI:
    app = FastAPI()
    app.add_exception_handler(HTTPException, log_http_exceptions)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, log_validation_errors)  # type: ignore[arg-type]

    @app.get("/refused/{status}")
    async def refused(status: int) -> None:
        raise HTTPException(
            status_code=status, detail="post_message does not accept: room_id"
        )

    @app.post("/typed")
    async def typed(body: _Body) -> None:
        return None

    @app.post("/checked")
    async def checked(body: _Checked) -> None:
        return None

    return app


async def _send(
    caplog: pytest.LogCaptureFixture, method: str, path: str, body: dict[str, Any]
) -> tuple[Response, list[logging.LogRecord]]:
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="switch_core.bridges.agent.app"):
        async with AsyncClient(
            transport=ASGITransport(app=_app()), base_url="http://test"
        ) as client:
            response = await client.request(method, path, json=body)
    records = [r for r in caplog.records if r.name == "switch_core.bridges.agent.app"]
    return response, records


async def _records(
    caplog: pytest.LogCaptureFixture, method: str, path: str
) -> list[logging.LogRecord]:
    _, records = await _send(caplog, method, path, {})
    return records


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "level"),
    [
        (400, logging.WARNING),
        (404, logging.WARNING),
        (500, logging.ERROR),
        (503, logging.ERROR),
    ],
)
async def test_a_refused_request_logs_a_warning_and_a_server_failure_an_error(
    caplog: pytest.LogCaptureFixture, status: int, level: int
) -> None:
    records = await _records(caplog, "GET", f"/refused/{status}")
    assert [r.levelno for r in records] == [level]
    assert (
        f"→ {status}: post_message does not accept: room_id" in records[0].getMessage()
    )


@pytest.mark.asyncio
async def test_a_request_that_fails_validation_logs_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    records = await _records(caplog, "POST", "/typed")
    assert [r.levelno for r in records] == [logging.WARNING]
    assert "→ 422 validation" in records[0].getMessage()


@pytest.mark.asyncio
async def test_a_request_that_fails_validation_is_not_repeated_in_the_answer_or_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A missing field's error carries the whole body as its `input`, so a
    secret sent beside it would come back and be logged."""
    secret = "sk-test-not-a-real-key"
    response, records = await _send(caplog, "POST", "/typed", {"token": secret})

    assert response.status_code == 422
    assert secret not in response.text
    assert secret not in records[0].getMessage()
    assert response.json() == {
        "detail": [
            {"type": "missing", "loc": ["body", "text"], "msg": "Field required"}
        ]
    }


@pytest.mark.asyncio
async def test_a_validator_that_raises_is_a_422_not_a_server_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The error's `ctx` holds the ValueError itself, which is not JSON."""
    response, _ = await _send(caplog, "POST", "/checked", {"room": "nowhere"})

    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Value error, no such room"
