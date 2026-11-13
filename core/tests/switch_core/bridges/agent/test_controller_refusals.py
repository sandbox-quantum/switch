"""A refused controller credential leaves one warning, and an address
that keeps being refused is locked out.

A test once saw a refused, rotated controller token produce no log line at all.
Now each refusal logs one WARN with the reason code, the kind of route, the
method and the address the server resolved: never any part of the token,
never a header or path the client chose. After repeated refusals from one
address, further refusals are answered at once with a 429 and counted, not
logged one by one. A token whose signature checks out is still served from a
locked address, so controllers behind one proxy can't be locked out by
another client's bad token. No database: the authenticator is a stand-in.
"""

from __future__ import annotations

import json
import logging
from collections.abc import MutableMapping
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import HTTPException
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import refusals as refusals_module
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import (
    BearerAuthMiddleware,
    ControllerAuthError,
    ControllerPrincipal,
)
from switch_core.bridges.agent.refusals import (
    RefusalGuard,
    client_address,
    lockout_key,
    method_of,
    route_kind,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway import hosted_controller

LOGGER = "switch_core.bridges.agent.refusals"
GOOD = "swct_good-token-0123456789"
BAD = "swct_bad-token-SECRETPART-9876"
CLIENT = ("203.0.113.9", 51000)


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _FakeControllerAuth:
    """Stands in for `ManagementAuthenticator`: GOOD authenticates, anything
    else is refused as an invalid credential."""

    def __init__(self) -> None:
        self.authenticated: list[str] = []

    def handles(self, path: str) -> bool:
        return path.startswith("/v1/management") or path.startswith("/v1/controllers")

    def is_public(self, path: str) -> bool:
        return path == "/v1/management/controllers/enroll"

    def is_controller_token(self, token: str) -> bool:
        return token.startswith("swct_")

    def signature_valid(self, token: str) -> bool:
        return token == GOOD

    async def authenticate(self, token: str) -> ControllerPrincipal:
        self.authenticated.append(token)
        if token != GOOD:
            raise ControllerAuthError(
                "invalid_credential", "not a valid controller token"
            )
        return ControllerPrincipal(controller_id="c-1", owner_id="o-1", tenant_id="t-1")


def _middleware(
    guard: RefusalGuard, auth: _FakeControllerAuth
) -> tuple[BearerAuthMiddleware, list[str]]:
    served: list[str] = []

    async def app(scope: Any, receive: Any, send: Any) -> None:
        served.append(scope["path"])

    mw = BearerAuthMiddleware(
        app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        # Never reached: the controller paths don't open a session here.
        session_factory=cast("async_sessionmaker[AsyncSession]", None),
        controller_auth=auth,  # type: ignore[arg-type]
        refusals=guard,
    )
    return mw, served


async def _dispatch(
    mw: BearerAuthMiddleware,
    path: str,
    token: str | None,
    *,
    client: tuple[str, int] | None = CLIENT,
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> list[dict[str, Any]]:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request"}

    sent: list[dict[str, Any]] = []

    async def send(message: MutableMapping[str, Any]) -> None:
        sent.append(dict(message))

    headers = [] if token is None else [(b"authorization", f"Bearer {token}".encode())]
    headers += extra_headers or []
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": headers,
        "client": client,
    }
    await mw(scope, receive, send)
    return sent


def _status(sent: list[dict[str, Any]]) -> int | None:
    return sent[0]["status"] if sent else None


def _warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == LOGGER and r.levelno == logging.WARNING
    ]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_refused_token_logs_one_warning_with_no_secret_and_no_client_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    mw, served = _middleware(RefusalGuard(clock=_Clock()), _FakeControllerAuth())

    sent = await _dispatch(
        mw,
        "/v1/controllers/ctl-1/status?note=<script>",
        BAD,
        extra_headers=[(b"x-forwarded-for", b"198.51.100.7, evil text")],
    )

    assert _status(sent) == 401
    assert served == []
    lines = _warnings(caplog)
    assert lines == [
        "Refused a controller credential: reason=invalid_credential route=controller "
        "method=POST client=203.0.113.9"
    ]
    everything = "\n".join(r.getMessage() for r in caplog.records)
    for secret_or_client_text in (
        BAD,
        "SECRETPART",
        "swct_",
        "198.51.100.7",
        "evil",
        "<script>",
        "ctl-1",
    ):
        assert secret_or_client_text not in everything


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_missing_credential_is_logged_too(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    mw, _ = _middleware(RefusalGuard(clock=_Clock()), _FakeControllerAuth())

    sent = await _dispatch(mw, "/v1/management/controllers/ctl-1/status", None)

    assert _status(sent) == 401
    assert _warnings(caplog) == [
        "Refused a controller credential: reason=missing_credential route=management "
        "method=POST client=203.0.113.9"
    ]


async def test_a_good_token_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    mw, served = _middleware(RefusalGuard(clock=_Clock()), _FakeControllerAuth())

    await _dispatch(mw, "/v1/controllers/ctl-1/status", GOOD)

    assert served == ["/v1/controllers/ctl-1/status"]
    assert _warnings(caplog) == []


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_act_as_path_logs_its_refusal_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    mw, served = _middleware(RefusalGuard(clock=_Clock()), _FakeControllerAuth())

    sent = await _dispatch(mw, "/agents/agent-1/ops/post_message", BAD)

    assert _status(sent) == 401
    assert served == []
    assert _warnings(caplog) == [
        "Refused a controller credential: reason=invalid_credential route=agent "
        "method=POST client=203.0.113.9"
    ]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_repeated_refusals_lock_the_address_out_with_a_429_and_no_more_lookups(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    clock = _Clock()
    auth = _FakeControllerAuth()
    mw, served = _middleware(
        RefusalGuard(lockout_after=3, window_s=60, lockout_s=300, clock=clock), auth
    )

    for _ in range(3):
        assert _status(await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)) == 401
    assert len(auth.authenticated) == 3

    locked = await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)
    assert _status(locked) == 429
    assert dict(locked[0]["headers"])[b"retry-after"] == b"301"
    body = json.loads(b"".join(m.get("body", b"") for m in locked[1:]))
    assert body["error"]["code"] == "invalid_credential"
    # Answered at once: the authenticator, and so the database, isn't asked.
    assert len(auth.authenticated) == 3
    assert _status(await _dispatch(mw, "/v1/controllers/ctl-1/status", None)) == 429

    lines = _warnings(caplog)
    assert len(lines) == 4  # three refusals, then one line for the lockout starting
    assert lines[3] == (
        "Controller credential lockout started: client=203.0.113.9 refusals=3 window_s=60 lockout_s=300"
    )

    # When it ends, one line says how many were refused meanwhile, and the address is served again.
    clock.now += 301
    assert _status(await _dispatch(mw, "/v1/controllers/ctl-1/status", GOOD)) is None
    assert served == ["/v1/controllers/ctl-1/status"]
    assert _status(await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)) == 401
    lines = _warnings(caplog)
    assert (
        "Controller credential lockout ended: client=203.0.113.9 refusals_while_locked=2"
        in lines
    )
    assert lines[-1].startswith(
        "Refused a controller credential: reason=invalid_credential"
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_valid_token_is_still_served_from_a_locked_address() -> None:
    clock = _Clock()
    mw, served = _middleware(
        RefusalGuard(lockout_after=2, clock=clock), _FakeControllerAuth()
    )
    for _ in range(2):
        await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)
    assert _status(await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)) == 429

    # Another controller behind the same proxy, with a good token, is not locked out.
    await _dispatch(mw, "/v1/controllers/ctl-2/status", GOOD)
    assert served == ["/v1/controllers/ctl-2/status"]


async def test_another_address_is_not_affected() -> None:
    mw, served = _middleware(
        RefusalGuard(lockout_after=2, clock=_Clock()), _FakeControllerAuth()
    )
    for _ in range(3):
        await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)

    sent = await _dispatch(
        mw, "/v1/controllers/ctl-9/status", BAD, client=("192.0.2.4", 4000)
    )

    assert _status(sent) == 401


async def test_refusals_spread_past_the_window_never_lock_out() -> None:
    clock = _Clock()
    guard = RefusalGuard(lockout_after=3, window_s=60, clock=clock)
    for _ in range(10):
        guard.refused(
            "192.0.2.1", reason="invalid_credential", route="controller", method="GET"
        )
        clock.now += 31
    assert not guard.locked("192.0.2.1")


def test_the_guard_forgets_the_oldest_address_past_its_limit() -> None:
    guard = RefusalGuard(lockout_after=1, max_addresses=2, clock=_Clock())
    for address in ("192.0.2.1", "192.0.2.2", "192.0.2.3"):
        guard.refused(
            address, reason="invalid_credential", route="controller", method="GET"
        )
    assert not guard.locked("192.0.2.1")
    assert guard.locked("192.0.2.2") and guard.locked("192.0.2.3")


def test_log_fields_come_only_from_fixed_lists_or_the_resolved_address() -> None:
    assert client_address({"client": ("2001:db8::1", 1)}) == "2001:db8::1"
    assert client_address({"client": ("not-an-ip", 1)}) == "unknown"
    assert client_address({}) == "unknown"
    assert route_kind("/v1/management/anything") == "management"
    assert route_kind("/v1/controllers/x") == "controller"
    assert route_kind("/agents/x/ops") == "agent"
    assert method_of({"type": "http", "method": "BREW"}) == "OTHER"
    assert method_of({"type": "websocket"}) == "WEBSOCKET"


def _public_middleware(
    guard: RefusalGuard, status: int
) -> tuple[BearerAuthMiddleware, list[str]]:
    """The routes behind enrollment answer `status`, as the real handler
    would for a refused or accepted secret."""
    served: list[str] = []

    async def app(scope: Any, receive: Any, send: Any) -> None:
        served.append(scope["path"])
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    mw = BearerAuthMiddleware(
        app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=cast("async_sessionmaker[AsyncSession]", None),
        controller_auth=_FakeControllerAuth(),  # type: ignore[arg-type]
        refusals=guard,
    )
    return mw, served


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_refused_enrollment_code_logs_one_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    mw, served = _public_middleware(RefusalGuard(clock=_Clock()), 401)

    sent = await _dispatch(mw, "/v1/management/controllers/enroll", None)

    assert _status(sent) == 401
    assert served == ["/v1/management/controllers/enroll"]
    assert _warnings(caplog) == [
        "Refused a controller credential: reason=enrollment_code_invalid "
        "route=management method=POST client=203.0.113.9"
    ]


async def test_an_accepted_enrollment_logs_nothing(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    mw, _ = _public_middleware(RefusalGuard(clock=_Clock()), 201)

    await _dispatch(mw, "/v1/management/controllers/enroll", None)

    assert _warnings(caplog) == []


@pytest.mark.usefixtures("hosted_v2_on")
async def test_enrollment_is_never_locked_out() -> None:
    guard = RefusalGuard(lockout_after=2, clock=_Clock())
    mw, served = _public_middleware(guard, 401)
    for _ in range(4):
        await _dispatch(mw, "/v1/management/controllers/enroll", None)

    assert guard.locked("203.0.113.9")
    # Still handed to the route, not answered with a 429: a lockout would add
    # nothing against guessing a long random code, and could block everyone
    # enrolling from behind the same proxy.
    assert served == ["/v1/management/controllers/enroll"] * 4


def test_an_address_the_server_couldnt_resolve_is_logged_but_never_locked(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    guard = RefusalGuard(lockout_after=2, clock=_Clock())
    for _ in range(5):
        guard.refused(
            "unknown", reason="invalid_credential", route="controller", method="GET"
        )
    assert not guard.locked("unknown")
    assert len(_warnings(caplog)) == 5


def test_ipv6_is_counted_by_its_64() -> None:
    guard = RefusalGuard(lockout_after=3, clock=_Clock())
    for host in ("2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff::9"):
        guard.refused(
            host, reason="invalid_credential", route="controller", method="GET"
        )
    # Rotating inside one /64 doesn't escape the count...
    assert guard.locked("2001:db8:1:2::abcd")
    # ...and the next /64 is a different client.
    assert not guard.locked("2001:db8:1:3::1")
    assert lockout_key("192.0.2.7") == "192.0.2.7"
    assert lockout_key("2001:db8:1:2::1") == "2001:db8:1:2::/64"
    assert lockout_key("unknown") is None


class _Request:
    def __init__(
        self, authorization: str | None, client: tuple[str, int] = CLIENT
    ) -> None:
        self.headers = {} if authorization is None else {"authorization": authorization}
        self.scope = {"type": "http", "method": "GET", "client": client}


class _Session:
    async def __aenter__(self) -> str:
        return "session"

    async def __aexit__(self, *_exc: object) -> None:
        return None


HOSTED_TOKEN = "hosted-SECRET-token-value"


async def _hosted(
    authorization: str | None, *, client: tuple[str, int] = CLIENT
) -> object:
    settings = SimpleNamespace(token=SecretStr(HOSTED_TOKEN))
    gen = hosted_controller.controller_session(
        _Request(authorization, client),  # type: ignore[arg-type]
        settings,  # type: ignore[arg-type]
        lambda: _Session(),  # type: ignore[arg-type]
    )
    return await gen.__anext__()


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_hosted_controller_route_logs_a_wrong_or_missing_token_once(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    monkeypatch.setattr(refusals_module, "_DEFAULT", RefusalGuard(clock=_Clock()))

    with pytest.raises(HTTPException) as wrong:
        await _hosted(f"Bearer {HOSTED_TOKEN}-but-not")
    with pytest.raises(HTTPException) as missing:
        await _hosted(None)

    assert wrong.value.status_code == missing.value.status_code == 401
    assert _warnings(caplog) == [
        "Refused a controller credential: reason=wrong route=hosted_controller method=GET client=203.0.113.9",
        "Refused a controller credential: reason=missing route=hosted_controller method=GET client=203.0.113.9",
    ]
    assert "SECRET" not in "\n".join(r.getMessage() for r in caplog.records)
    # The right token opens a session as before.
    assert await _hosted(f"Bearer {HOSTED_TOKEN}") == "session"


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_hosted_controller_route_locks_out_wrong_tokens_but_serves_the_right_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        refusals_module, "_DEFAULT", RefusalGuard(lockout_after=2, clock=_Clock())
    )
    for _ in range(2):
        with pytest.raises(HTTPException):
            await _hosted("Bearer nope")

    with pytest.raises(HTTPException) as locked:
        await _hosted("Bearer nope")
    assert locked.value.status_code == 429
    assert locked.value.headers == {"Retry-After": "301"}
    # The operator or scaler behind the same address still gets in.
    assert await _hosted(f"Bearer {HOSTED_TOKEN}") == "session"


class TestWithHostedAgentsV2Off:
    """The v1/v2 switch: with v2 off, a refused controller credential is a
    plain 401 as before, with no warning and no lockout."""

    @pytest.fixture(autouse=True)
    def _v2_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from switch_core import hosted_v2

        monkeypatch.setattr(hosted_v2, "_process_on", False)

    async def test_repeated_refusals_never_lock_out_or_log(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        caplog.set_level(logging.INFO, logger=LOGGER)
        auth = _FakeControllerAuth()
        mw, _served = _middleware(
            RefusalGuard(lockout_after=2, window_s=60, lockout_s=300, clock=_Clock()),
            auth,
        )
        for _ in range(4):
            sent = await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)
            assert _status(sent) == 401
        assert len(auth.authenticated) == 4  # every one checked, none answered early
        assert _warnings(caplog) == []

    async def test_the_hosted_controller_route_is_a_plain_401(
        self, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        caplog.set_level(logging.INFO, logger=LOGGER)
        monkeypatch.setattr(
            refusals_module, "_DEFAULT", RefusalGuard(lockout_after=1, clock=_Clock())
        )
        for _ in range(3):
            with pytest.raises(HTTPException) as refused:
                await _hosted("Bearer nope")
            assert refused.value.status_code == 401
        assert _warnings(caplog) == []
        assert await _hosted(f"Bearer {HOSTED_TOKEN}") == "session"

    async def test_each_refusal_is_still_counted_by_reason_and_route(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Observability step 1: with v2 off, no log line and no lockout, but
        each refusal is counted, by reason and kind of route only."""
        from switch_core.observability.metrics import (
            MetricsRegistry,
            install,
            uninstall,
        )

        registry = MetricsRegistry()
        install(registry)
        try:
            auth = _FakeControllerAuth()
            mw, _served = _middleware(
                RefusalGuard(
                    lockout_after=2, window_s=60, lockout_s=300, clock=_Clock()
                ),
                auth,
            )
            for _ in range(3):
                await _dispatch(mw, "/v1/controllers/ctl-1/status", BAD)
            with pytest.raises(HTTPException):
                await _hosted("Bearer nope")
            counted = {
                (dict(point.attributes)["reason"], dict(point.attributes)["route"]): (
                    point.value
                )
                for payload in registry.collect()
                if payload.name == "switch.controller.credential_refusals"
                for point in payload.numbers
            }
        finally:
            uninstall()
        assert counted == {
            ("invalid_credential", "controller"): 3.0,
            ("wrong", "hosted_controller"): 1.0,
        }
