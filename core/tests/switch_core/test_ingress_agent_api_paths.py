"""Every path the agent bridge serves must be routed to switch-core by the ingress.

A Helm install sends `ingress.agentApiPaths` to switch-core and everything else
to the gateway, whose SPA answers any unknown path with `200 text/html` and any
POST with `405`. So a top-level prefix the agent bridge serves but the ingress
does not list fails in production only, and fails badly: a session host that
asks for JSON is handed the SPA's `<!doctype html>` and gives up mid-turn. That
is what happened to `/agent-sessions`, which reached neither the chart's
defaults nor the sample Ingress when it was added.
"""

from pathlib import Path
from typing import Any

import yaml

from switch_core.bridges.agent.app import create_agent_bridge_app
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.keys import Keyring
from switch_core.management.controller_routes import router as controller_router

_CHART = Path(__file__).resolve().parents[3] / "deploy/remote/helm/switch"

# FastAPI's own pages; nothing routes them from outside.
_NOT_PUBLISHED = {"/docs", "/openapi.json", "/redoc", "/docs/oauth2-redirect"}

# Added to the agent bridge app in `main.run` rather than in
# `create_agent_bridge_app`. `/gateway` is absent on purpose: it is reached
# through the gateway, which proxies it to switch-core.
_ADDED_IN_MAIN = {"/health", "/messaging"}


def _config() -> Any:
    class _Config:
        agent_auth_cache_ttl_seconds = 1
        agent_auth_cache_max_entries = 16
        keyring = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
        oauth_issuer_url = None
        oauth_audience = None
        oauth_verify_issuer = True
        id_server_name = "test"

    return _Config()


def _served_prefixes() -> set[str]:
    app, _ = create_agent_bridge_app(
        agent_store=object(),  # type: ignore[arg-type]
        agent_session_store=object(),  # type: ignore[arg-type]
        room_store=object(),  # type: ignore[arg-type]
        room_service=object(),  # type: ignore[arg-type]
        client_lifecycle=object(),  # type: ignore[arg-type]
        collab_lifecycle=object(),  # type: ignore[arg-type]
        event_buffer=EventBuffer(sequence_base=0),
        task_store=object(),  # type: ignore[arg-type]
        resource_service=object(),  # type: ignore[arg-type]
        api_key_store=object(),  # type: ignore[arg-type]
        external_user_store=object(),  # type: ignore[arg-type]
        bridge_store=object(),  # type: ignore[arg-type]
        session_factory=object(),
        config=_config(),
        approval_outcomes=object(),  # type: ignore[arg-type]
        controller_auth=None,
    )
    prefixes = set(_ADDED_IN_MAIN)
    # The agents controller's routes join the agent bridge app only when agent
    # management is on (`management/wiring.py`), so they are read from their
    # router here.
    for route in [*app.routes, *controller_router.routes]:
        path = getattr(route, "path", "")
        if path in _NOT_PUBLISHED:
            continue
        prefixes.add("/" + path.strip("/").split("/")[0])
    return prefixes


def _chart_default_paths() -> set[str]:
    values = yaml.safe_load((_CHART / "values.yaml").read_text())
    return set(values["ingress"]["agentApiPaths"])


def _sample_ingress_paths() -> set[str]:
    ingress = yaml.safe_load((_CHART / "samples/ingress.example.yaml").read_text())
    paths: set[str] = set()
    for rule in ingress["spec"]["rules"]:
        for entry in rule["http"]["paths"]:
            service = entry["backend"]["service"]
            if (
                service["name"].endswith("switch-core")
                and service["port"]["number"] == 8000
            ):
                paths.add(entry["path"])
    return paths


def test_the_charts_default_ingress_routes_every_agent_bridge_prefix() -> None:
    missing = sorted(_served_prefixes() - _chart_default_paths())
    assert not missing, (
        f"The agent bridge serves {missing}, but ingress.agentApiPaths in "
        "deploy/remote/helm/switch/values.yaml does not route them to "
        "switch-core, so they reach the gateway SPA instead."
    )


def test_the_sample_ingress_routes_every_agent_bridge_prefix() -> None:
    missing = sorted(_served_prefixes() - _sample_ingress_paths())
    assert not missing, (
        f"The agent bridge serves {missing}, but "
        "deploy/remote/helm/switch/samples/ingress.example.yaml does not "
        "route them to switch-core on port 8000."
    )
