import pytest
from starlette.types import Receive, Scope, Send

from switch_core.logging_context import LogContext, current_log_context
from switch_core.request_context import RequestContextMiddleware


class _Recorder:
    """An ASGI app that records the log context it was called under."""

    def __init__(self) -> None:
        self.seen: list[LogContext] = []

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.seen.append(current_log_context())


def _scope(headers: list[tuple[bytes, bytes]]) -> Scope:
    return {"type": "http", "path": "/agents", "headers": headers}


async def _call(app: _Recorder, headers: list[tuple[bytes, bytes]]) -> LogContext:
    await RequestContextMiddleware(app)(_scope(headers), _receive, _send)
    return app.seen[-1]


async def _receive() -> dict:
    return {"type": "http.request"}


async def _send(message: dict) -> None:
    return None


async def test_a_request_id_is_generated_when_none_is_supplied() -> None:
    app = _Recorder()

    context = await _call(app, [])

    assert context.request_id
    assert len(context.request_id) == 32


async def test_two_requests_get_different_ids() -> None:
    app = _Recorder()

    first = await _call(app, [])
    second = await _call(app, [])

    assert first.request_id != second.request_id


async def test_a_supplied_request_id_is_used() -> None:
    app = _Recorder()

    context = await _call(app, [(b"x-request-id", b"upstream-42")])

    assert context.request_id == "upstream-42"


async def test_a_hostile_request_id_cannot_forge_log_lines() -> None:
    app = _Recorder()

    context = await _call(
        app, [(b"x-request-id", b"a\nERROR everything is fine " + b"x" * 200)]
    )

    assert context.request_id is not None
    assert "\n" not in context.request_id
    assert " " not in context.request_id
    assert len(context.request_id) == 64


async def test_the_context_is_unbound_after_the_request() -> None:
    app = _Recorder()

    await _call(app, [])

    assert current_log_context().request_id is None


async def test_the_context_is_unbound_when_the_app_raises() -> None:
    class _Failing:
        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        await RequestContextMiddleware(_Failing())(_scope([]), _receive, _send)

    assert current_log_context().request_id is None


async def test_lifespan_traffic_is_passed_through_untouched() -> None:
    app = _Recorder()

    await RequestContextMiddleware(app)({"type": "lifespan"}, _receive, _send)

    assert app.seen[-1].request_id is None
