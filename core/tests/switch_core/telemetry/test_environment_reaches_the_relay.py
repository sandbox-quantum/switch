"""A deployment's TELEMETRY_ENVIRONMENT reaches the relay as `flint_env`.

The relay files each event under the Amplitude project that attribute names. A
server that read the setting and then sent something else would land its
usage in the wrong project with nothing anywhere reporting a fault, so this
follows the value from configuration to the request body.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import DeploymentIdentity
from switch_core.telemetry import setup as telemetry_setup


def _config(environment: str) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[call-arg]
        db_host="h",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        matrix_server_name="test",
        agent_registration_token="t",
        jwt_secret_key="k",
        gateway_admin_email="a@b.test",
        gateway_admin_password="pw",
        telemetry_enabled=True,
        telemetry_endpoint="https://relay.example",
        telemetry_environment=environment,
        telemetry_internal=False,
    )


@pytest.mark.parametrize("environment", ["prod", "staging", "dev", "local"])
async def test_the_configured_environment_is_sent_as_flint_env(
    environment: str,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with session_factory() as session:
        await session.execute(delete(DeploymentIdentity))
        session.add(DeploymentIdentity(id=1, client_id=str(uuid.uuid4())))
        await session.commit()
    bodies: list[dict[str, Any]] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200)

    transport = httpx.MockTransport(_handle)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        telemetry_setup.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )

    service, _, http = await telemetry_setup.build_telemetry(
        _config(environment), session_factory, "1.0.0"
    )
    service.emit("deployment_started", tenant_count=1)
    await service.aclose()
    assert http is not None
    await http.aclose()

    [body] = bodies
    resource = {
        a["key"]: a["value"] for a in body["resourceLogs"][0]["resource"]["attributes"]
    }
    assert resource["flint_env"] == {"stringValue": environment}
    assert resource["flint_internal"] == {"stringValue": "false"}
