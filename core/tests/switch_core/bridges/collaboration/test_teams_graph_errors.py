"""CHOO-2067 — what a Graph refusal says by the time it reaches a person.

These errors are the only account anyone gets of why provisioning failed, and
they now travel out of the API rather than stopping at the log, so their
wording is load-bearing.
"""

from __future__ import annotations

import httpx

from switch_core.bridges.collaboration.models import BridgeOperationError
from switch_core.bridges.collaboration.teams.graph import GraphError, _graph_error

_FORBIDDEN = {
    "error": {
        "code": "Forbidden",
        "message": (
            "Missing role permissions on the request. API requires one of "
            "'Channel.Create, Teamwork.Migrate.All'. Roles on the request ''."
        ),
    }
}


def _resp(
    status: int, *, json: dict[str, object] | None = None, text: str = ""
) -> httpx.Response:
    if json is not None:
        return httpx.Response(status, json=json)
    return httpx.Response(status, text=text)


def test_graph_error_leads_with_graphs_own_message() -> None:
    err = _graph_error("create channel 'Work' in team t1", _resp(403, json=_FORBIDDEN))

    message = str(err)
    assert "create channel 'Work' in team t1 failed (403)" in message
    assert "Forbidden: Missing role permissions" in message
    assert "'Channel.Create, Teamwork.Migrate.All'" in message
    # The JSON scaffolding is gone; only the sentence survives.
    assert "innerError" not in message
    assert '{"error"' not in message


def test_a_body_that_is_not_graphs_shape_is_passed_through_verbatim() -> None:
    # A proxy or WAF answering in place of Graph. Guessing at what an unknown
    # body meant would be worse than showing it.
    err = _graph_error(
        "list subscriptions", _resp(502, text="<html>Bad Gateway</html>")
    )

    assert "list subscriptions failed (502)" in str(err)
    assert "<html>Bad Gateway</html>" in str(err)


def test_an_error_object_without_a_message_falls_back_rather_than_half_reporting() -> (
    None
):
    err = _graph_error("get channel c1", _resp(400, json={"error": {"code": "Bad"}}))

    # No `message` key: the raw body is more honest than the bare code.
    assert '"code":"Bad"' in str(err).replace(" ", "")


def test_a_code_less_error_uses_the_message_alone() -> None:
    err = _graph_error(
        "get channel c1", _resp(404, json={"error": {"message": "no such channel"}})
    )

    assert str(err).endswith("failed (404): no such channel")


def test_graph_errors_are_bridge_operation_errors() -> None:
    # What lets the room-creation door answer 502 with Graph's words instead of
    # dropping an unhandled exception into a 500.
    err = _graph_error("create channel 'Work' in team t1", _resp(403, json=_FORBIDDEN))

    assert isinstance(err, GraphError)
    assert isinstance(err, BridgeOperationError)
    # Still a RuntimeError, so callers that already sorted "the attempt failed"
    # from "the request was wrong" are unaffected.
    assert isinstance(err, RuntimeError)
    assert not isinstance(err, ValueError)
