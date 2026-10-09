import json

from starlette.types import Message, Receive, Scope, Send

from switch_core.refusal_breaker import (
    INITIAL_COOLDOWN_S,
    REFUSALS_TO_TRIP,
    RefusalBreaker,
)


class _App:
    """Answers every request with `status`, and counts what reached it."""

    def __init__(self, status: int) -> None:
        self.status = status
        self.calls = 0
        self.bodies: list[bytes] = []

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.calls += 1
        message = await receive()
        self.bodies.append(message.get("body", b""))
        await send(
            {"type": "http.response.start", "status": self.status, "headers": []}
        )
        await send({"type": "http.response.body", "body": b"{}"})


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def _request(
    breaker: RefusalBreaker,
    path: str,
    *,
    bearer: str | None = "token-a",
    method: str = "GET",
    body: bytes = b"",
) -> tuple[int, dict[bytes, bytes], dict]:
    headers = [(b"authorization", f"Bearer {bearer}".encode())] if bearer else []
    sent: list[Message] = []

    async def receive() -> Message:
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: Message) -> None:
        sent.append(message)

    scope = {"type": "http", "method": method, "path": path, "headers": headers}
    await breaker(scope, receive, send)
    start = sent[0]
    payload = json.loads(sent[1]["body"])
    return start["status"], dict(start["headers"]), payload


async def test_a_repeated_refusal_is_answered_429_without_reaching_the_app() -> None:
    app, clock = _App(403), _Clock()
    breaker = RefusalBreaker(app, clock=clock)
    for _ in range(REFUSALS_TO_TRIP):
        assert (await _request(breaker, "/agents/a1/events"))[0] == 403

    status, headers, payload = await _request(breaker, "/agents/a1/events")
    assert status == 429
    assert headers[b"retry-after"] == str(int(INITIAL_COOLDOWN_S)).encode()
    assert "detail" in payload
    assert app.calls == REFUSALS_TO_TRIP

    # Another caller, and a request naming no caller at all, are not held back.
    assert (await _request(breaker, "/agents/a1/events", bearer="token-b"))[0] == 403
    for _ in range(REFUSALS_TO_TRIP + 2):
        assert (await _request(breaker, "/agents/a1/events", bearer=None))[0] == 403
        assert (await _request(breaker, "/gateway/agents/a1"))[0] == 403


async def test_after_the_wait_one_request_goes_through_and_its_answer_decides() -> None:
    app, clock = _App(404), _Clock()
    breaker = RefusalBreaker(app, clock=clock)
    for _ in range(REFUSALS_TO_TRIP):
        await _request(breaker, "/agents/a1/connection/beat", method="POST")

    clock.now += INITIAL_COOLDOWN_S
    assert (await _request(breaker, "/agents/a1/connection/beat", method="POST"))[
        0
    ] == 404
    status, headers, _ = await _request(
        breaker, "/agents/a1/connection/beat", method="POST"
    )
    assert status == 429
    assert headers[b"retry-after"] == str(int(INITIAL_COOLDOWN_S * 2)).encode()

    clock.now += INITIAL_COOLDOWN_S * 2
    app.status = 200
    assert (await _request(breaker, "/agents/a1/connection/beat", method="POST"))[
        0
    ] == 200
    app.status = 404
    assert (await _request(breaker, "/agents/a1/connection/beat", method="POST"))[
        0
    ] == 404


async def test_a_controller_token_exchange_is_told_apart_by_its_credential() -> None:
    app, clock = _App(401), _Clock()
    breaker = RefusalBreaker(app, clock=clock)
    path = "/v1/management/controllers/c1/token"
    stale = b'{"credential": "stale"}'
    for _ in range(REFUSALS_TO_TRIP):
        await _request(breaker, path, bearer=None, method="POST", body=stale)
    assert app.bodies[-1] == stale

    status, _, payload = await _request(
        breaker, path, bearer=None, method="POST", body=stale
    )
    assert status == 429
    assert payload["error"]["code"] == "rate_limited"
    assert payload["error"]["retry_after_s"] == int(INITIAL_COOLDOWN_S)

    app.status = 200
    fresh = b'{"credential": "fresh"}'
    assert (await _request(breaker, path, bearer=None, method="POST", body=fresh))[
        0
    ] == 200
