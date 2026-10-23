import logging

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from switch_core.bridges.agent.app import log_http_exceptions, log_validation_errors


class _Body(BaseModel):
    text: str


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

    return app


async def _records(
    caplog: pytest.LogCaptureFixture, method: str, path: str
) -> list[logging.LogRecord]:
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="switch_core.bridges.agent.app"):
        async with AsyncClient(
            transport=ASGITransport(app=_app()), base_url="http://test"
        ) as client:
            await client.request(method, path, json={})
    return [r for r in caplog.records if r.name == "switch_core.bridges.agent.app"]


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
