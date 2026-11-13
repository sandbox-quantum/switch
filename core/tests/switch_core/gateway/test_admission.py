"""Gateway requests take turns per caller and per process, and reads run under
a statement timeout (`gateway/admission.py`). A fake app stands in for the
gateway, so a request runs exactly as long as a test holds it."""

from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from starlette.types import Receive, Scope, Send

from switch_core.db.statement_timeout import current_statement_timeout
from switch_core.gateway import admission
from switch_core.gateway.admission import GatewayAdmission, _Line
from switch_core.gateway.auth import create_jwt
from switch_core.keys import Keyring

_KEYRING = Keyring.parse("test:" + secrets.token_hex(32), legacy_secret=None)


def _session(user_id: str, keyring: Keyring = _KEYRING) -> str:
    return create_jwt(
        user_id,
        f"{user_id}@example.com",
        "user",
        keyring,
        None,
        session_version=0,
        auth_time=datetime.now(UTC),
    )


class _Gateway:
    """An app whose requests run until the test lets them finish."""

    def __init__(self) -> None:
        self.started: list[str] = []
        self.release = asyncio.Event()
        self.raise_on: dict[str, BaseException] = {}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope["path"]
        self.started.append(path)
        if path in self.raise_on:
            raise self.raise_on[path]
        if path.startswith("/hold"):
            await self.release.wait()
        body = (current_statement_timeout() or "none").encode()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": body})


def _admission(
    gateway: _Gateway, *, limit: int = 10, per_caller: int = 2
) -> GatewayAdmission:
    return GatewayAdmission(
        gateway,  # type: ignore[arg-type]
        limit=limit,
        per_caller=per_caller,
        read_timeout="10s",
        keyring=_KEYRING,
    )


def _client(app: Any, session: str | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": session} if session else None,
    )


@pytest.fixture(autouse=True)
def _short_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(admission, "WAIT_S", 0.3)


async def _until(condition: Any) -> None:
    for _ in range(200):
        if condition():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition never held")


async def test_a_callers_requests_past_its_share_wait_their_turn() -> None:
    gateway = _Gateway()
    app = _admission(gateway, per_caller=2)
    async with _client(app, _session("ada")) as client:
        first = [asyncio.create_task(client.get(f"/hold/{i}")) for i in range(2)]
        await _until(lambda: len(gateway.started) == 2)
        third = asyncio.create_task(client.get("/third"))
        await asyncio.sleep(0.05)
        assert gateway.started == ["/hold/0", "/hold/1"]
        gateway.release.set()
        answers = await asyncio.gather(*first, third)

    assert [a.status_code for a in answers] == [200, 200, 200]
    assert gateway.started[-1] == "/third"


async def test_past_the_wait_a_caller_is_answered_429_and_nothing_runs() -> None:
    gateway = _Gateway()
    app = _admission(gateway, per_caller=1)
    async with _client(app, _session("ada")) as client:
        held = asyncio.create_task(client.get("/hold"))
        await _until(lambda: gateway.started == ["/hold"])
        refused = await client.get("/more")
        gateway.release.set()
        await held

    assert refused.status_code == 429
    assert refused.headers["retry-after"] == "1"
    assert "too many requests" in refused.json()["detail"]
    assert gateway.started == ["/hold"]


async def test_one_caller_does_not_hold_back_another() -> None:
    gateway = _Gateway()
    app = _admission(gateway, per_caller=1)
    async with (
        _client(app, _session("ada")) as ada,
        _client(app, _session("bob")) as bob,
    ):
        held = asyncio.create_task(ada.get("/hold"))
        await _until(lambda: gateway.started == ["/hold"])
        answer = await bob.get("/rooms")
        gateway.release.set()
        await held

    assert answer.status_code == 200


async def test_the_process_turns_away_past_its_limit_with_503() -> None:
    gateway = _Gateway()
    app = _admission(gateway, limit=2, per_caller=5)
    async with (
        _client(app, _session("ada")) as ada,
        _client(app, _session("bob")) as bob,
        _client(app, _session("cy")) as cy,
    ):
        held = [
            asyncio.create_task(ada.get("/hold/a")),
            asyncio.create_task(bob.get("/hold/b")),
        ]
        await _until(lambda: len(gateway.started) == 2)
        refused = await cy.get("/rooms")
        gateway.release.set()
        await asyncio.gather(*held)

    assert refused.status_code == 503
    assert "busy" in refused.json()["detail"]
    assert "/rooms" not in gateway.started


async def test_streams_are_not_counted() -> None:
    gateway = _Gateway()
    app = _admission(gateway, limit=1, per_caller=1)
    async with _client(app, _session("ada")) as client:
        held = asyncio.create_task(client.get("/hold"))
        await _until(lambda: gateway.started == ["/hold"])
        streams = [
            await client.get("/chats/events"),
            await client.get("/chats/activity/events"),
        ]
        gateway.release.set()
        await held

    assert [s.status_code for s in streams] == [200, 200]


async def test_a_session_is_counted_against_its_person_and_a_forged_one_is_not() -> (
    None
):
    gateway = _Gateway()
    app = _admission(gateway, per_caller=1)
    forged = _session(
        "ada", Keyring.parse("test:" + secrets.token_hex(32), legacy_secret=None)
    )
    async with (
        _client(app, _session("ada")) as ada,
        _client(app, _session("ada")) as ada_again,
        _client(app, forged) as impostor,
    ):
        held = asyncio.create_task(ada.get("/hold"))
        await _until(lambda: gateway.started == ["/hold"])
        # Another session of the same person shares their turns.
        same_person = await ada_again.get("/rooms")
        # A token signed with another key names nobody: it is counted
        # against its address, and cannot use up anyone else's turns.
        not_ada = await impostor.get("/rooms")
        gateway.release.set()
        await held

    assert same_person.status_code == 429
    assert not_ada.status_code == 200


async def test_callers_with_nothing_running_are_forgotten() -> None:
    gateway = _Gateway()
    gateway.release.set()
    app = _admission(gateway)
    for name in ("ada", "bob", "cy"):
        async with _client(app, _session(name)) as client:
            assert (await client.get("/rooms")).status_code == 200

    assert app._callers == {}
    assert app._process.idle


async def test_reads_run_under_the_statement_timeout_and_writes_do_not() -> None:
    gateway = _Gateway()
    gateway.release.set()
    app = _admission(gateway)
    async with _client(app, _session("ada")) as client:
        read = await client.get("/rooms")
        write = await client.post("/rooms")

    assert (read.text, write.text) == ("10s", "none")


class _Cancelled(Exception):
    sqlstate = "57014"


async def test_a_read_stopped_by_its_timeout_is_answered_503_and_a_write_is_not() -> (
    None
):
    gateway = _Gateway()
    timed_out = _Cancelled("canceling statement due to statement timeout")
    gateway.raise_on["/slow"] = timed_out
    app = _admission(gateway)
    async with _client(app, _session("ada")) as client:
        read = await client.get("/slow")
        with pytest.raises(_Cancelled):
            await client.post("/slow")

    assert read.status_code == 503
    assert "took longer than Switch allows" in read.json()["detail"]
    assert app._callers == {} and app._process.idle


async def test_any_other_error_still_reaches_the_server() -> None:
    gateway = _Gateway()
    gateway.raise_on["/broken"] = _Cancelled("canceling statement due to user request")
    app = _admission(gateway)
    async with _client(app, _session("ada")) as client:
        with pytest.raises(_Cancelled):
            await client.get("/broken")


async def test_a_turn_handed_to_a_request_that_went_away_passes_to_the_next() -> None:
    line = _Line(1)
    assert await line.take(1.0)
    leaving = asyncio.create_task(line.take(1.0))
    staying = asyncio.create_task(line.take(1.0))
    await asyncio.sleep(0.01)
    leaving.cancel()
    await asyncio.sleep(0.01)
    line.give_back()

    assert await staying
    with pytest.raises(asyncio.CancelledError):
        await leaving
    line.give_back()
    assert line.idle
