"""The setup job must not read a failed bridge list as an empty one.

`register_bridge` looks for an existing Mattermost bridge before registering
one. Reading a failure as "there are no bridges" sends it on to register a
second bridge with `set_as_default`, taking the default from whatever held it.
The job is a post-install/post-upgrade Helm hook, so it runs against live
deployments and can be retried — which a duplicated bridge cannot.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[4]
_SETUP_PY = _REPO_ROOT / "deploy" / "shared_resources" / "setup.py"

# setup.py reads its configuration at import time, by design — it is a
# single-shot container entrypoint, not a library.
_ENV = {
    "SWITCH_URL": "http://switch-core:8000",
    "GATEWAY_ADMIN_EMAIL": "admin@example.invalid",
    "GATEWAY_ADMIN_PASSWORD": "setup-test-password",
    "MATTERMOST_URL": "http://mattermost:8065",
    "MATTERMOST_ADMIN_USER": "admin",
    "MATTERMOST_ADMIN_PASSWORD": "setup-test-password",
    "MATTERMOST_TEAM_NAME": "switch",
    "MATTERMOST_USER": "user",
    "MATTERMOST_USER_PASSWORD": "setup-test-password",
}


@pytest.fixture(scope="module")
def setup_script() -> Any:
    saved = {k: os.environ.get(k) for k in _ENV}
    os.environ.update(_ENV)
    try:
        spec = importlib.util.spec_from_file_location("_switch_setup", _SETUP_PY)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules["_switch_setup"] = module
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop("_switch_setup", None)
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _client(handler: Any) -> httpx.Client:
    return httpx.Client(
        base_url="http://switch-core:8000", transport=httpx.MockTransport(handler)
    )


def test_a_failed_bridge_read_registers_nothing(setup_script: Any) -> None:
    """A 503 on the read must stop, not fall through to a second bridge."""
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posted.append(str(request.url))
            return httpx.Response(200, json={"bridge_id": "should-not-happen"})
        return httpx.Response(503, json={"detail": "Service Unavailable"})

    with _client(handler) as client, pytest.raises(httpx.HTTPStatusError):
        setup_script.register_bridge(client)

    assert posted == []


def test_an_unauthorized_bridge_read_registers_nothing(setup_script: Any) -> None:
    """The same for a 401 — the shape this first took in production."""
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posted.append(str(request.url))
            return httpx.Response(200, json={"bridge_id": "should-not-happen"})
        return httpx.Response(401, json={"detail": "Not authenticated"})

    with _client(handler) as client, pytest.raises(httpx.HTTPStatusError):
        setup_script.register_bridge(client)

    assert posted == []


def test_an_existing_default_bridge_is_adopted_untouched(setup_script: Any) -> None:
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posted.append(str(request.url))
            return httpx.Response(200, json={})
        return httpx.Response(
            200,
            json=[
                {
                    "bridge_id": "bridge-1",
                    "bridge_type": "mattermost",
                    "is_default": True,
                }
            ],
        )

    with _client(handler) as client:
        assert setup_script.register_bridge(client) == "bridge-1"

    assert posted == []


def test_an_existing_bridge_that_is_not_default_is_promoted(
    setup_script: Any,
) -> None:
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posted.append(request.url.path)
            return httpx.Response(200, json={})
        return httpx.Response(
            200,
            json=[
                {
                    "bridge_id": "bridge-1",
                    "bridge_type": "mattermost",
                    "is_default": False,
                }
            ],
        )

    with _client(handler) as client:
        assert setup_script.register_bridge(client) == "bridge-1"

    assert posted == ["/gateway/collaborations/bridge-1/default"]


def test_an_empty_list_still_registers_a_bridge(setup_script: Any) -> None:
    """The fall-through the failure cases must not reach is still reachable
    the one way it should be: a read that succeeded and found nothing."""
    posted: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            posted.append(request.url.path)
            return httpx.Response(200, json={"bridge_id": "bridge-new"})
        return httpx.Response(200, json=[])

    with _client(handler) as client:
        assert setup_script.register_bridge(client) == "bridge-new"

    assert posted == ["/gateway/collaborations"]
