"""The decision client against stub decision services on real sockets: a
good answer, every way of not getting one, where each workspace's decisions
go, the Test button's classified errors, and what is reported to telemetry."""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.db.models import TENANT_ZERO_ID, Tenant
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.decision.client import (
    ContextMessage,
    Decided,
    DecisionAgent,
    DecisionAnswer,
    DecisionMessage,
    DecisionRequest,
    DecisionRoom,
    DynamicDecisionClient,
    Failed,
    Unavailable,
    confidence_bucket,
    decide_url,
)
from switch_core.decision.machine import MachineDecisions
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.keys import Keyring
from switch_core.outbound import OutboundPolicy, guarded_async_client
from switch_core.telemetry.catalogue import validate
from tests.conftest import TEST_KEYRING

_GOOD = {
    "agent": "deploy",
    "model_choice": "deploy",
    "confidence": 0.91,
    "threshold": 0.6,
    "reason": "the question is about a deploy",
    "model": "clef-flash",
    "latency_ms": 312,
}


@dataclass
class _Stub:
    """A decision service on 127.0.0.1 that answers every request with
    `status` and `body`, after `delay` seconds, and records what it was
    sent."""

    status: int = 200
    body: bytes = json.dumps(_GOOD).encode()
    delay: float = 0.0
    received: list[tuple[dict[str, str], dict[str, Any]]] = field(default_factory=list)
    url: str = ""

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode().split("\r\n")
        headers = {
            name.strip().lower(): value.strip()
            for name, _, value in (line.partition(":") for line in lines[1:] if line)
        }
        body = await reader.readexactly(int(headers.get("content-length", "0")))
        self.received.append((headers, json.loads(body)))
        await asyncio.sleep(self.delay)
        reason = {
            200: "OK",
            400: "Bad Request",
            401: "Unauthorized",
            500: "Internal Server Error",
            502: "Bad Gateway",
        }
        writer.write(
            f"HTTP/1.1 {self.status} {reason.get(self.status, 'Status')}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(self.body)}\r\n"
            "Connection: close\r\n\r\n".encode()
            + self.body
        )
        await writer.drain()
        writer.close()


@pytest.fixture
async def stub() -> AsyncIterator[_Stub]:
    service = _Stub()
    server = await asyncio.start_server(service.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    service.url = f"http://127.0.0.1:{port}/decide"
    async with server:
        yield service
        server.close()


@pytest.fixture
async def other() -> AsyncIterator[_Stub]:
    """A second decision service: a workspace's own endpoint."""
    service = _Stub()
    server = await asyncio.start_server(service.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    service.url = f"http://127.0.0.1:{port}/decide"
    async with server:
        yield service
        server.close()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


class _Telemetry:
    """Records what is reported, after checking it against the catalogue, as
    the real service does."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    def emit(self, event: str, **properties: Any) -> None:
        validate(event, properties)
        self.events.append((event, properties))


TENANT_B = "decision-client-tenant-b"


def _client(
    session_factory: async_sessionmaker[AsyncSession],
    http: httpx.AsyncClient,
    url: str | None,
    *,
    api_key: str | None = None,
    bedrock: bool = False,
    enabled: bool = True,
    telemetry: _Telemetry | None = None,
    cache_seconds: float = 0,
    keyring: Keyring = TEST_KEYRING,
    allowed: str = "127.0.0.1",
) -> DynamicDecisionClient:
    return DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability(
            enabled=enabled,
            server=ServerDefault(
                endpoint_url=url, api_key=api_key, bedrock_enabled=bedrock
            ),
            store=DecisionSettingsStore(),
            controllers=AgentControllerStore(),
        ),
        keyring=keyring,
        client=http,
        guarded_client=guarded_async_client(OutboundPolicy.parse(allowed)),
        outbound_policy=OutboundPolicy.parse(allowed),
        timeout_seconds=0.5,
        telemetry=telemetry,  # type: ignore[arg-type]
        cache_seconds=cache_seconds,
        machines=MachineDecisions(ControllerPresence(on_bound=lambda _agent_id: None)),
    )


async def _save(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    *,
    backend: str,
    endpoint: str | None = None,
    api_key: str | None = None,
    threshold: float | None = None,
) -> None:
    async with session_factory() as session:
        await DecisionSettingsStore().save(
            session,
            tenant_id,
            backend=backend,
            endpoint=endpoint,
            api_key_encrypted=TEST_KEYRING.encrypt(api_key) if api_key else None,
            threshold=threshold,
        )
        await session.commit()


async def _tenant_b(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
        await session.commit()


def _request() -> DecisionRequest:
    return DecisionRequest(
        room=DecisionRoom(name="ops", instructions="Keep it short."),
        message=DecisionMessage(
            sender="alice",
            text="can someone check why last night's deploy failed?",
            thread_id=None,
        ),
        agents=[
            DecisionAgent(name="deploy", description="Runs deploys", role=None),
            DecisionAgent(name="billing", description="Invoices", role="finance"),
        ],
        thread=[],
        recent=[
            ContextMessage(
                sender="alice",
                sender_kind="person",
                text="@deploy is the pipeline green?",
                addressed=["deploy"],
            ),
            ContextMessage(
                sender="deploy", sender_kind="agent", text="Yes", addressed=[]
            ),
        ],
    )


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


async def _decide(client: DynamicDecisionClient, tenant_id: str = TENANT_ZERO_ID):
    return await client.decide(_request(), tenant_id=tenant_id, room_id="room-1")


class TestTheServerDefault:
    async def test_a_good_answer(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        outcome = await _decide(
            _client(session_factory, http, stub.url, api_key="placeholder")
        )

        assert isinstance(outcome, Decided)
        assert outcome.backend == "server_default"
        assert outcome.answer == DecisionAnswer(
            agent="deploy",
            model_choice="deploy",
            confidence=0.91,
            threshold=0.6,
            reason="the question is about a deploy",
            model="clef-flash",
            latency_ms=312.0,
        )
        [(headers, body)] = stub.received
        assert headers["authorization"] == "Bearer placeholder"
        assert "x-decision-backend" not in headers
        assert body == _request().model_dump(mode="json")
        assert "confidence_threshold" not in body

    async def test_no_key_sends_no_authorization(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _decide(_client(session_factory, http, stub.url))

        [(headers, _)] = stub.received
        assert "authorization" not in headers

    async def test_nobody_is_an_answer(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        stub.body = json.dumps(
            {**_GOOD, "agent": None, "model_choice": "billing", "confidence": 0.45}
        ).encode()

        outcome = await _decide(_client(session_factory, http, stub.url))

        assert isinstance(outcome, Decided)
        assert outcome.answer.agent is None
        assert outcome.answer.model_choice == "billing"

    async def test_no_server_default_and_no_choice_is_unavailable(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        http: httpx.AsyncClient,
    ) -> None:
        outcome = await _decide(_client(session_factory, http, None))

        assert isinstance(outcome, Unavailable)
        assert outcome.reason is not None
        assert "Decision routing" in outcome.reason

    async def test_the_flag_off_is_unavailable(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        client = _client(session_factory, http, stub.url, enabled=False)

        assert isinstance(await _decide(client), Unavailable)
        async with session_factory() as session:
            assert not await client.available(session, TENANT_ZERO_ID)
        assert stub.received == []


class TestFailures:
    async def test_a_timeout(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        stub.delay = 2.0

        with caplog.at_level(logging.WARNING):
            outcome = await _decide(_client(session_factory, http, stub.url))

        assert isinstance(outcome, Failed) and outcome.reason == "timeout"
        assert "did not answer within 0.5s" in caplog.text
        assert "room-1" in caplog.text

    async def test_a_service_that_is_not_running(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        http: httpx.AsyncClient,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        url = f"http://127.0.0.1:{_closed_port()}/decide"

        with caplog.at_level(logging.WARNING):
            outcome = await _decide(_client(session_factory, http, url))

        assert isinstance(outcome, Failed) and outcome.reason == "unreachable"
        assert "could not be reached" in caplog.text
        assert url in caplog.text

    @pytest.mark.parametrize("status", [500, 502, 401, 201])
    async def test_any_status_but_200(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
        caplog: pytest.LogCaptureFixture,
        status: int,
    ) -> None:
        stub.status = status
        stub.body = b'{"detail": "model server unreachable"}'

        with caplog.at_level(logging.WARNING):
            outcome = await _decide(_client(session_factory, http, stub.url))

        assert isinstance(outcome, Failed) and outcome.reason == "error_status"
        assert f"answered {status}" in caplog.text
        assert "model server unreachable" in caplog.text

    @pytest.mark.parametrize(
        "body",
        [
            b"not json",
            b"[]",
            json.dumps({k: v for k, v in _GOOD.items() if k != "agent"}).encode(),
            json.dumps({**_GOOD, "agent": 7}).encode(),
            json.dumps({**_GOOD, "confidence": "high"}).encode(),
            json.dumps({**_GOOD, "threshold": None}).encode(),
        ],
    )
    async def test_a_malformed_body(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
        caplog: pytest.LogCaptureFixture,
        body: bytes,
    ) -> None:
        stub.body = body

        with caplog.at_level(logging.WARNING):
            outcome = await _decide(_client(session_factory, http, stub.url))

        assert isinstance(outcome, Failed) and outcome.reason == "bad_answer"
        assert "answered something other than a decision" in caplog.text

    async def test_a_name_that_was_not_a_candidate(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        stub.body = json.dumps({**_GOOD, "agent": "docs"}).encode()

        with caplog.at_level(logging.WARNING):
            outcome = await _decide(_client(session_factory, http, stub.url))

        assert isinstance(outcome, Failed) and outcome.reason == "bad_answer"
        [record] = [
            r for r in caplog.records if "not one of the candidates" in r.message
        ]
        assert record.levelno == logging.ERROR
        assert "'docs'" in record.message

    async def test_a_key_the_server_cannot_decrypt(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _save(
            session_factory,
            TENANT_ZERO_ID,
            backend="endpoint",
            endpoint=other.url,
            api_key="lost-key",
        )
        rotated = Keyring.parse("other:" + "z" * 40, legacy_secret=None)

        outcome = await _decide(
            _client(session_factory, http, stub.url, keyring=rotated)
        )

        assert isinstance(outcome, Failed) and outcome.reason == "key_unreadable"
        assert other.received == [] and stub.received == []


class TestEachWorkspacesBackend:
    async def test_a_saved_endpoint_applies_to_its_workspace_only(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _tenant_b(session_factory)
        client = _client(session_factory, http, stub.url, api_key="server-key")
        await _decide(client, TENANT_ZERO_ID)
        await _decide(client, TENANT_B)
        assert len(stub.received) == 2

        await _save(
            session_factory,
            TENANT_ZERO_ID,
            backend="endpoint",
            endpoint=other.url,
            api_key="workspace-key",
            threshold=0.75,
        )
        outcome = await _decide(client, TENANT_ZERO_ID)
        await _decide(client, TENANT_B)

        assert isinstance(outcome, Decided) and outcome.backend == "endpoint"
        [(headers, body)] = other.received
        assert headers["authorization"] == "Bearer workspace-key"
        assert body["confidence_threshold"] == 0.75
        assert len(stub.received) == 3
        assert stub.received[-1][0]["authorization"] == "Bearer server-key"

    async def test_none_overrides_the_server_default(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _tenant_b(session_factory)
        await _save(session_factory, TENANT_ZERO_ID, backend="none")
        client = _client(session_factory, http, stub.url)

        outcome = await _decide(client, TENANT_ZERO_ID)
        async with session_factory() as session:
            assert not await client.available(session, TENANT_ZERO_ID)
            assert await client.available(session, TENANT_B)

        assert isinstance(outcome, Unavailable)
        assert outcome.reason is not None and "turned auto-route off" in outcome.reason
        assert stub.received == []

    async def test_haiku_goes_to_the_servers_service_with_the_backend_header(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _save(
            session_factory,
            TENANT_ZERO_ID,
            backend="haiku_anthropic",
            api_key="fake-key-AwcA",
        )
        client = _client(session_factory, http, stub.url, api_key="server-key")

        outcome = await _decide(client)

        assert isinstance(outcome, Decided) and outcome.backend == "haiku_anthropic"
        [(headers, _)] = stub.received
        assert headers["x-decision-backend"] == "anthropic"
        assert headers["x-decision-anthropic-key"] == "fake-key-AwcA"
        assert headers["authorization"] == "Bearer server-key"

    async def test_bedrock_is_asked_for_only_where_the_server_allows_it(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _save(session_factory, TENANT_ZERO_ID, backend="haiku_bedrock")

        refused = await _decide(_client(session_factory, http, stub.url))
        allowed = await _decide(_client(session_factory, http, stub.url, bedrock=True))

        assert isinstance(refused, Unavailable)
        assert isinstance(allowed, Decided) and allowed.backend == "haiku_bedrock"
        [(headers, _)] = stub.received
        assert headers["x-decision-backend"] == "bedrock"
        assert "x-decision-anthropic-key" not in headers

    async def test_a_cached_setting_is_dropped_on_forget(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        client = _client(session_factory, http, stub.url, cache_seconds=60)
        await _decide(client)
        await _save(session_factory, TENANT_ZERO_ID, backend="none")

        assert isinstance(await _decide(client), Decided)
        client.forget(TENANT_ZERO_ID)
        assert isinstance(await _decide(client), Unavailable)


class TestTelemetry:
    async def test_a_decision_reports_counts_and_timings_only(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        telemetry = _Telemetry()
        client = _client(session_factory, http, stub.url, telemetry=telemetry)

        await _decide(client)
        stub.body = json.dumps({**_GOOD, "agent": None, "confidence": None}).encode()
        await _decide(client)

        [(made, first), (_, second)] = telemetry.events
        assert made == "decision_made"
        assert set(first) == {"backend", "outcome", "confidence", "latency_ms"}
        assert first["backend"] == "server_default"
        assert first["outcome"] == "agent"
        assert first["confidence"] == "0.9_1.0"
        assert isinstance(first["latency_ms"], int) and first["latency_ms"] >= 0
        assert second["outcome"] == "none" and second["confidence"] == "none"
        flat = json.dumps(telemetry.events)
        for identifier in ("room-1", "deploy", "alice", "ops", "pipeline"):
            assert identifier not in flat

    async def test_a_failure_reports_its_reason(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        http: httpx.AsyncClient,
    ) -> None:
        telemetry = _Telemetry()
        url = f"http://127.0.0.1:{_closed_port()}/decide"

        await _decide(_client(session_factory, http, url, telemetry=telemetry))

        assert telemetry.events == [
            ("decision_failed", {"backend": "server_default", "reason": "unreachable"})
        ]

    @pytest.mark.parametrize(
        ("confidence", "bucket"),
        [
            (None, "none"),
            (0.2, "lt_0.5"),
            (0.5, "0.5_0.6"),
            (0.65, "0.6_0.7"),
            (0.79, "0.7_0.8"),
            (0.8, "0.8_0.9"),
            (0.95, "0.9_1.0"),
            (1.0, "0.9_1.0"),
        ],
    )
    def test_confidence_buckets(self, confidence: float | None, bucket: str) -> None:
        assert confidence_bucket(confidence) == bucket


class TestTheTestButton:
    async def test_a_working_endpoint(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        other.body = json.dumps({**_GOOD, "agent": "deploy-bot"}).encode()

        outcome = await _client(session_factory, http, None).test(
            backend="endpoint", endpoint=other.url, api_key="k", threshold=0.5
        )

        assert outcome.ok and outcome.agent == "deploy-bot"
        assert outcome.confidence == 0.91
        assert outcome.latency_ms is not None
        [(headers, body)] = other.received
        assert headers["authorization"] == "Bearer k"
        assert body["confidence_threshold"] == 0.5
        assert {a["name"] for a in body["agents"]} == {
            "deploy-bot",
            "billing-bot",
            "docs-bot",
        }

    async def test_an_endpoint_that_does_not_answer(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        http: httpx.AsyncClient,
    ) -> None:
        outcome = await _client(session_factory, http, None).test(
            backend="endpoint",
            endpoint=f"http://127.0.0.1:{_closed_port()}/decide",
            api_key=None,
            threshold=None,
        )

        assert not outcome.ok and outcome.error_code == "unreachable"

    async def test_a_slow_endpoint(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        other.delay = 2.0

        outcome = await _client(session_factory, http, None).test(
            backend="endpoint", endpoint=other.url, api_key=None, threshold=None
        )

        assert outcome.error_code == "timeout"

    @pytest.mark.parametrize(
        ("backend", "status", "body", "code"),
        [
            ("endpoint", 401, b'{"detail": "bad token"}', "unauthorized"),
            (
                "haiku_anthropic",
                502,
                b'{"detail": "anthropic: 401 invalid x-api-key"}',
                "key_refused",
            ),
            (
                "haiku_anthropic",
                400,
                b'{"detail": "no", "code": "backend_unavailable"}',
                "backend_unavailable",
            ),
            ("endpoint", 500, b'{"detail": "boom"}', "bad_answer"),
            ("endpoint", 200, b"[]", "bad_answer"),
        ],
    )
    async def test_classified_errors(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
        backend: str,
        status: int,
        body: bytes,
        code: str,
    ) -> None:
        stub.status, stub.body = status, body

        outcome = await _client(session_factory, http, stub.url).test(
            backend=backend,  # type: ignore[arg-type]
            endpoint=stub.url if backend == "endpoint" else None,
            api_key="fake-key",
            threshold=None,
        )

        assert not outcome.ok and outcome.error_code == code
        assert outcome.error_message

    async def test_haiku_without_a_server_service_or_key(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        no_service = await _client(session_factory, http, None).test(
            backend="haiku_anthropic", endpoint=None, api_key="k", threshold=None
        )
        no_key = await _client(session_factory, http, stub.url).test(
            backend="haiku_anthropic", endpoint=None, api_key=None, threshold=None
        )
        bedrock = await _client(session_factory, http, stub.url).test(
            backend="haiku_bedrock", endpoint=None, api_key=None, threshold=None
        )

        assert no_service.error_code == "not_configured"
        assert no_key.error_code == "not_configured"
        assert bedrock.error_code == "backend_unavailable"
        assert stub.received == []

    async def test_the_server_default_with_the_servers_own_key(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        outcome = await _client(
            session_factory, http, stub.url, api_key="server-key"
        ).test(
            backend="default",
            endpoint=None,
            api_key="workspace-key",
            threshold=None,
        )
        missing = await _client(session_factory, http, None).test(
            backend="default", endpoint=None, api_key=None, threshold=None
        )

        assert outcome.ok and outcome.agent == "deploy"
        [(headers, _)] = stub.received
        assert headers["authorization"] == "Bearer server-key"
        assert "x-decision-backend" not in headers
        assert missing.error_code == "not_configured"


@pytest.mark.parametrize(
    ("url", "posted"),
    [
        ("http://decision.test", "http://decision.test/decide"),
        ("http://decision.test:8230/", "http://decision.test:8230/decide"),
        ("http://decision.test/decide", "http://decision.test/decide"),
        ("https://proxy.test/team/decide", "https://proxy.test/team/decide"),
    ],
)
def test_a_base_url_gets_the_decide_route(url: str, posted: str) -> None:
    assert decide_url(url) == posted


class TestTheOutboundPolicy:
    async def test_a_workspace_endpoint_it_refuses_is_a_failure_and_not_sent(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _save(
            session_factory, TENANT_ZERO_ID, backend="endpoint", endpoint=other.url
        )
        telemetry = _Telemetry()

        outcome = await _decide(
            _client(session_factory, http, stub.url, allowed="", telemetry=telemetry)
        )

        assert isinstance(outcome, Failed) and outcome.reason == "endpoint_refused"
        assert other.received == [] and stub.received == []
        assert telemetry.events == [
            ("decision_failed", {"backend": "endpoint", "reason": "endpoint_refused"})
        ]

    async def test_a_listed_private_endpoint_is_reached(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        await _save(
            session_factory, TENANT_ZERO_ID, backend="endpoint", endpoint=other.url
        )

        outcome = await _decide(
            _client(session_factory, http, stub.url, allowed="127.0.0.0/8")
        )

        assert isinstance(outcome, Decided) and outcome.backend == "endpoint"
        assert len(other.received) == 1

    async def test_the_server_default_and_haiku_are_not_checked(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        stub: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        client = _client(session_factory, http, stub.url, allowed="")

        default = await _decide(client)
        await _save(
            session_factory,
            TENANT_ZERO_ID,
            backend="haiku_anthropic",
            api_key="fake-key",
        )
        haiku = await _decide(client)

        assert isinstance(default, Decided) and default.backend == "server_default"
        assert isinstance(haiku, Decided) and haiku.backend == "haiku_anthropic"
        assert len(stub.received) == 2

    async def test_the_test_button_says_refused(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        other: _Stub,
        http: httpx.AsyncClient,
    ) -> None:
        outcome = await _client(session_factory, http, None, allowed="").test(
            backend="endpoint", endpoint=other.url, api_key=None, threshold=None
        )

        assert outcome.error_code == "refused"
        assert outcome.error_message is not None
        assert "OUTBOUND_ALLOWED_PRIVATE_HOSTS" in outcome.error_message
        assert other.received == []
