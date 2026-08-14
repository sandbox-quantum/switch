"""Configuration and registration.

The config model is also the admin form: the gateway serves its JSON Schema and
the SPA renders it, so what is declared here is what an operator is asked for.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.bridges.agent.server_connectors.agui.connector import (
    AgUiConnectionConfig,
    AgUiConnector,
)
from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)


def _config(**overrides: object) -> AgUiConnectionConfig:
    values: dict[str, object] = {
        "endpoint_url": "https://agent.example/agui",
        "agent_name": "research-bot",
    }
    values.update(overrides)
    return AgUiConnectionConfig.model_validate(values)


# ── Required and optional fields ──────────────────────────────────────────────


def test_endpoint_and_name_are_required() -> None:
    schema = AgUiConnectionConfig.model_json_schema()
    assert set(schema["required"]) == {"endpoint_url", "agent_name"}


def test_the_token_is_rendered_as_a_password_field() -> None:
    # The only protection the stored config gets is that the form masks it and
    # the gateway never reads it back.
    schema = AgUiConnectionConfig.model_json_schema()
    assert schema["properties"]["bearer_token"]["format"] == "password"


def test_an_unauthenticated_endpoint_is_allowed() -> None:
    # AG-UI defines no authentication at all, so plenty of endpoints have none.
    assert _config().bearer_token == ""


def test_defaults_are_usable_without_tuning() -> None:
    config = _config()
    assert config.history_limit > 0
    assert config.max_iterations > 0
    assert config.read_timeout_seconds > 0
    assert config.run_timeout_seconds > config.read_timeout_seconds


# ── Endpoint validation ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "ftp://agent.example/agui",
        "file:///etc/passwd",
        "gopher://agent.example",
        "agent.example/agui",
        "",
    ],
)
def test_non_http_endpoints_are_rejected(url: str) -> None:
    with pytest.raises(ValidationError):
        _config(endpoint_url=url)


def test_an_endpoint_without_a_host_is_rejected() -> None:
    with pytest.raises(ValidationError, match="no host"):
        _config(endpoint_url="https:///agui")


def test_credentials_embedded_in_the_url_are_rejected() -> None:
    # They would end up in logs and error messages; the token field exists.
    with pytest.raises(ValidationError, match="must not embed credentials"):
        _config(endpoint_url="https://user:secret@agent.example/agui")


def test_localhost_is_allowed() -> None:
    # An agent running beside Switch is the ordinary development case, so the
    # network boundary confines reachability, not this validator.
    assert _config(endpoint_url="http://localhost:8000/agui").endpoint_url


def test_surrounding_whitespace_is_trimmed() -> None:
    assert _config(endpoint_url="  https://agent.example/agui  ").endpoint_url == (
        "https://agent.example/agui"
    )


@pytest.mark.parametrize("field", ["history_limit", "max_iterations"])
def test_nonsensical_bounds_are_rejected(field: str) -> None:
    with pytest.raises(ValidationError):
        _config(**{field: 0})


# ── Registration ──────────────────────────────────────────────────────────────


def _lifecycle() -> ServerSideConnectorLifecycleService:
    service = ServerSideConnectorLifecycleService(
        connector_store=None,  # type: ignore[arg-type]
        api_key_store=None,  # type: ignore[arg-type]
        protocol=None,  # type: ignore[arg-type]
        session_factory=None,  # type: ignore[arg-type]
        encryption_secret="secret",
    )
    service.register_connector_type("agui", AgUiConnector, AgUiConnectionConfig)
    return service


def test_the_connector_type_registers() -> None:
    assert "agui" in _lifecycle().get_registered_types()


def test_the_gateway_can_serve_the_config_schema() -> None:
    # This is what the admin UI renders, so it has to be reachable by type name.
    schema = _lifecycle().get_config_schema("agui")
    assert "endpoint_url" in schema["properties"]
    assert "bearer_token" in schema["properties"]


def test_main_registers_the_agui_connector_type() -> None:
    # Registration is two lines in main.py and easy to forget; without them the
    # whole connector is unreachable however complete it is.
    import inspect

    from switch_core import main

    source = inspect.getsource(main)
    assert '"agui", AgUiConnector, AgUiConnectionConfig' in source
