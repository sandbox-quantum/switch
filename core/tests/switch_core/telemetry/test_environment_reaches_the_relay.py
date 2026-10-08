"""What a deployment's configuration puts on the relay's resource, and what it
must not.

The relay files each event under the Amplitude project `flint_env` names. A
server that read TELEMETRY_ENVIRONMENT and then sent something else would land
its usage in the wrong project with nothing anywhere reporting a fault, so this
follows the value from configuration to the request body.

The other direction matters as much. ENVIRONMENT and SERVICE_NAME are free text
an operator sets for their own log pipeline, and may name their company; the
same request body is checked for them, whole, rather than attribute by
attribute, so a new attribute that forwards one is caught too.
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


def _config(telemetry_environment: str, **overrides: Any) -> SwitchConfig:
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
        secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        telemetry_enabled=True,
        telemetry_endpoint="https://relay.example",
        telemetry_environment=telemetry_environment,
        telemetry_internal=False,
        **overrides,
    )


async def _send_one(
    config: SwitchConfig,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, dict[str, Any]]:
    """Emit one event through the service `main` would build, and return the
    raw request body with its resource attributes."""
    async with session_factory() as session:
        await session.execute(delete(DeploymentIdentity))
        session.add(DeploymentIdentity(id=1, client_id=str(uuid.uuid4())))
        await session.commit()
    bodies: list[str] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content.decode())
        return httpx.Response(200)

    transport = httpx.MockTransport(_handle)
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        telemetry_setup.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )

    service, _, http = await telemetry_setup.build_telemetry(
        config, session_factory, "1.0.0"
    )
    service.emit("deployment_started", tenant_count=1)
    await service.aclose()
    assert http is not None
    await http.aclose()

    [raw] = bodies
    body = json.loads(raw)
    resource = {
        a["key"]: a["value"] for a in body["resourceLogs"][0]["resource"]["attributes"]
    }
    return raw, resource


@pytest.mark.parametrize("environment", ["prod", "staging", "dev", "local"])
async def test_the_configured_environment_is_sent_as_flint_env(
    environment: str,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, resource = await _send_one(_config(environment), session_factory, monkeypatch)

    assert resource["flint_env"] == {"stringValue": environment}
    assert resource["flint_internal"] == {"stringValue": "false"}


async def test_operator_chosen_names_never_reach_the_relay(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(
        "prod", environment="acme-corp-prod", service_name="acme-corp-switch"
    )

    raw, resource = await _send_one(config, session_factory, monkeypatch)

    assert "acme" not in raw
    assert resource["service.name"] == {"stringValue": "switch-core"}
    assert "deployment.environment" not in resource
