"""The setup job must not read an errored bridge list as an empty one.

`register_bridge` looks for an existing Mattermost bridge before registering
one. Reading an error status as "there are no bridges" sends it on to register
a second bridge with `set_as_default`, taking the default from whatever held
it. The job is a post-install/post-upgrade Helm hook, so it runs against live
deployments and is retried — and a duplicated bridge cannot be undone by
retrying.

Scoped to error *statuses*: a timeout or a connection failure raises out of the
request itself and never reached the check being fixed here.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
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


def _listing(bridges: list[dict[str, Any]], writes: list[tuple[str, str]]) -> Any:
    """A gateway that lists `bridges`, recording every write it is sent.

    Records anything that is not the GET — not just POSTs — so a test asserting
    an existing bridge was left alone also catches a stray PATCH.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=bridges)
        writes.append((request.method, request.url.path))
        return httpx.Response(200, json={"bridge_id": "bridge-new"})

    return handler


def test_a_failed_bridge_read_registers_nothing(
    setup_script: Any, capsys: pytest.CaptureFixture[str]
) -> None:
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
    # The traceback carries the status but not the body, so the gateway's own
    # explanation only reaches the job log if it is printed.
    out = capsys.readouterr().out
    assert "503" in out and "Service Unavailable" in out


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
    writes: list[tuple[str, str]] = []
    bridges = [
        {"bridge_id": "bridge-1", "bridge_type": "mattermost", "is_default": True}
    ]

    with _client(_listing(bridges, writes)) as client:
        assert setup_script.register_bridge(client) == "bridge-1"

    assert writes == []


def test_an_existing_bridge_is_promoted_when_nothing_holds_the_default(
    setup_script: Any,
) -> None:
    writes: list[tuple[str, str]] = []
    bridges = [
        {"bridge_id": "bridge-1", "bridge_type": "mattermost", "is_default": False}
    ]

    with _client(_listing(bridges, writes)) as client:
        assert setup_script.register_bridge(client) == "bridge-1"

    assert writes == [("POST", "/gateway/collaborations/bridge-1/default")]


def test_a_default_held_by_another_bridge_is_left_alone(setup_script: Any) -> None:
    """The promotion test above is narrower than its old name suggested.

    The check is `any(b.get("is_default") for b in bridges)` — across *all*
    bridges, not the Mattermost one. So an instance where Slack holds the
    default keeps it, and Mattermost stays non-default. Pinned as the behaviour
    it is: setup adopts an unclaimed default, it does not take a held one.
    """
    writes: list[tuple[str, str]] = []
    bridges = [
        {"bridge_id": "bridge-slack", "bridge_type": "slack", "is_default": True},
        {"bridge_id": "bridge-1", "bridge_type": "mattermost", "is_default": False},
    ]

    with _client(_listing(bridges, writes)) as client:
        assert setup_script.register_bridge(client) == "bridge-1"

    assert writes == []


def test_a_bridge_of_another_type_is_not_mistaken_for_the_mattermost_one(
    setup_script: Any,
) -> None:
    """A populated list is not the same as a matching one — a deployment
    holding only a Slack bridge still needs the Mattermost one registered."""
    writes: list[tuple[str, str]] = []
    bridges = [
        {"bridge_id": "bridge-slack", "bridge_type": "slack", "is_default": True}
    ]

    with _client(_listing(bridges, writes)) as client:
        assert setup_script.register_bridge(client) == "bridge-new"

    assert writes == [("POST", "/gateway/collaborations")]


def test_the_callback_address_is_pushed_to_an_existing_bridge(
    setup_script: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one path in the adopt branch the other tests leave unexercised.

    The bridge config is not readable back — it carries the admin password —
    so the callback address is re-sent on every run rather than only when it
    is missing. Read off a module global at import, so it is patched here.
    """
    monkeypatch.setattr(
        setup_script, "MATTERMOST_CALLBACK_BASE_URL", "http://switch-core:8000"
    )
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
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
        sent.append((request.method, request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={})

    with _client(handler) as client:
        assert setup_script.register_bridge(client) == "bridge-1"

    assert sent == [
        (
            "PATCH",
            "/gateway/collaborations/bridge-1",
            {"connection_config": {"callback_base_url": "http://switch-core:8000"}},
        )
    ]


def test_an_empty_list_still_registers_a_bridge(setup_script: Any) -> None:
    """The fall-through the failure cases must not reach is still reachable
    the one way it should be: a read that succeeded and found nothing."""
    writes: list[tuple[str, str]] = []

    with _client(_listing([], writes)) as client:
        assert setup_script.register_bridge(client) == "bridge-new"

    assert writes == [("POST", "/gateway/collaborations")]
