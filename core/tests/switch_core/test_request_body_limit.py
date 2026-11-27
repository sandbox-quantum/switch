from collections.abc import AsyncIterator
from typing import Annotated

import httpx
import pytest
from fastapi import FastAPI, File, Request, UploadFile

from switch_core.config import SwitchConfig
from switch_core.request_body_limit import RequestBodyLimit

LIMIT = 1024
UPLOAD_LIMIT = 8 * 1024


def _app() -> FastAPI:
    app = FastAPI()
    gateway = FastAPI()

    @app.post("/agents/{agent_id}/operations/x")
    async def operation(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    @app.post("/agents/{agent_id}/rooms/{room_id}/media")
    async def media(files: Annotated[list[UploadFile], File()]) -> dict[str, int]:
        return {"size": sum([len(await upload.read()) for upload in files])}

    @gateway.post("/chats/{room_id}/attachments")
    async def attachment(file: Annotated[UploadFile, File()]) -> dict[str, int]:
        return {"size": len(await file.read())}

    @gateway.post("/rooms/import")
    async def import_rooms(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    app.mount("/gateway", gateway)
    app.add_middleware(RequestBodyLimit, max_bytes=LIMIT, upload_max_bytes=UPLOAD_LIMIT)
    return app


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def _chunked(body: bytes) -> AsyncIterator[bytes]:
    for start in range(0, len(body), 256):
        yield body[start : start + 256]


async def test_a_body_within_the_limit_reaches_the_handler(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/agents/a1/operations/x", content=b"x" * LIMIT)

    assert response.status_code == 200
    assert response.json() == {"size": LIMIT}


async def test_a_declared_length_over_the_limit_is_answered_413(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/agents/a1/operations/x", content=b"x" * (LIMIT + 1))

    assert response.status_code == 413
    assert f"{LIMIT}-byte limit" in response.json()["detail"]


async def test_an_undeclared_body_over_the_limit_is_answered_413(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/agents/a1/operations/x", content=_chunked(b"x" * (LIMIT * 4))
    )

    assert response.status_code == 413


async def test_an_undeclared_body_over_the_limit_in_a_mounted_app_is_answered_413(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/gateway/rooms/import", content=_chunked(b"x" * (LIMIT * 4))
    )

    assert response.status_code == 413


async def test_attachment_uploads_have_the_larger_limit(
    client: httpx.AsyncClient,
) -> None:
    files = [("files", ("a.bin", b"x" * 3000)), ("files", ("b.bin", b"y" * 3000))]

    agent = await client.post("/agents/a1/rooms/r1/media", files=files)
    person = await client.post(
        "/gateway/chats/r1/attachments", files={"file": ("a.bin", b"x" * 6000)}
    )

    assert agent.status_code == 200, agent.text
    assert agent.json() == {"size": 6000}
    assert person.status_code == 200, person.text


async def test_an_attachment_upload_over_its_limit_is_answered_413(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/agents/a1/rooms/r1/media",
        files={"files": ("a.bin", b"x" * UPLOAD_LIMIT)},
    )

    assert response.status_code == 413


_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    id_server_name="switch.local",
    agent_registration_token="token",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    gateway_admin_email="admin@example.com",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[arg-type]
        **{
            **_BASE_KWARGS,
            "db_password": "placeholder",  # gitleaks:allow
            "gateway_admin_password": "placeholder",  # gitleaks:allow
            **overrides,
        }
    )


def test_the_default_limits_fit_the_default_attachment() -> None:
    config = _config()

    assert config.request_body_max_bytes > config.agent_media_max_bytes
    assert config.attachment_upload_max_bytes > config.agent_media_max_bytes


def test_the_upload_limit_must_fit_one_attachment() -> None:
    with pytest.raises(ValueError, match="ATTACHMENT_UPLOAD_MAX_BYTES"):
        _config(
            agent_media_max_bytes=20 * 1024 * 1024,
            attachment_upload_max_bytes=20 * 1024 * 1024,
        )
