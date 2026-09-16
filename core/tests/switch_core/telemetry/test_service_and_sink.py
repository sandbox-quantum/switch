"""Consent, the wire format, and what happens when the relay misbehaves."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from switch_core.telemetry.catalogue import TelemetryCatalogueError
from switch_core.telemetry.service import TelemetryService, emit_safely
from switch_core.telemetry.sink import NullSink, OtlpRelaySink, TelemetryRecord


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []
        self.closed = False

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        self.closed = True


def _service(sink: object, *, enabled: bool = True) -> TelemetryService:
    return TelemetryService(
        sink=sink,  # type: ignore[arg-type]
        enabled=enabled,
        client_id="deployment-uuid",
        service_name="switch-core",
        version="1.2.3",
        environment="pilot",
    )


class TestConsent:
    async def test_nothing_is_sent_when_telemetry_is_off(self) -> None:
        sink = _RecordingSink()
        service = _service(sink, enabled=False)

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert sink.sent == []

    async def test_a_bad_event_is_still_caught_when_telemetry_is_off(self) -> None:
        """Validation runs regardless, so a mistake in a rarely-taken branch is
        found by whichever test exercises it rather than lying dormant until
        the day a deployment switches reporting on."""
        service = _service(_RecordingSink(), enabled=False)
        with pytest.raises(TelemetryCatalogueError):
            service.emit("deployment_started", tenant_count="one")  # type: ignore[arg-type]

    async def test_events_are_sent_when_telemetry_is_on(self) -> None:
        sink = _RecordingSink()
        service = _service(sink)

        service.emit("deployment_started", tenant_count=2)
        await service.aclose()

        assert [record.name for record in sink.sent] == [
            "switch_core.deployment_started"
        ]


class TestTagging:
    async def test_every_event_carries_the_deployment_and_service(self) -> None:
        sink = _RecordingSink()
        service = _service(sink)

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert sink.sent[0].resource == {
            "service.name": "switch-core",
            "flint.client_id": "deployment-uuid",
            "service.version": "1.2.3",
            "deployment.environment": "pilot",
        }

    async def test_an_unset_environment_is_omitted_rather_than_empty(self) -> None:
        """An absent attribute reads as "not configured"; an empty string reads
        as a real environment named nothing."""
        sink = _RecordingSink()
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id="deployment-uuid",
            service_name="switch-core",
            version=None,
            environment=None,
        )

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert "deployment.environment" not in sink.sent[0].resource
        assert "service.version" not in sink.sent[0].resource


class TestFailuresDoNotReachTheCaller:
    async def test_a_sink_that_raises_does_not_surface(self) -> None:
        class _Broken:
            async def send(self, record: TelemetryRecord) -> None:
                raise RuntimeError("relay on fire")

            async def aclose(self) -> None:
                return None

        service = _service(_Broken())
        service.emit("deployment_started", tenant_count=1)
        await service.aclose()  # must not raise

    def test_emit_safely_swallows_a_catalogue_mistake(self) -> None:
        """A bad event must not take down the room creation that reported it."""
        service = _service(_RecordingSink())
        emit_safely(service, "deployment_started", {"tenant_count": "one"})

    def test_emit_safely_tolerates_no_service_at_all(self) -> None:
        emit_safely(None, "deployment_started", {"tenant_count": 1})

    def test_emit_outside_an_event_loop_does_not_raise(self) -> None:
        """Reported from a management command or a sync helper."""
        service = _service(_RecordingSink())
        service.emit("deployment_started", tenant_count=1)


class TestTheWireFormat:
    """The relay's expectations, which fail silently rather than loudly."""

    async def _capture(self, handler: object) -> dict:
        captured: dict = {}

        def _handle(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return handler(request)  # type: ignore[operator]

        sink = OtlpRelaySink(
            endpoint="https://relay.example/v1/logs", timeout_seconds=5
        )
        sink._client = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        await sink.send(
            TelemetryRecord(
                name="switch_core.usage_snapshot",
                properties={"room_count": 7, "from_template": True, "kind": "user"},
                resource={"service.name": "switch-core"},
                timestamp_ns=1_700_000_000_000_000_000,
            )
        )
        await sink.aclose()
        return captured

    async def test_the_event_name_is_sent_in_both_required_places(self) -> None:
        """The relay filters on the attribute and the exporter reads the field.
        Sending only one is accepted with a 200 and silently discarded."""
        body = await self._capture(lambda request: httpx.Response(200))
        record = body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]

        assert record["eventName"] == "switch_core.usage_snapshot"
        attributes = {a["key"]: a["value"] for a in record["attributes"]}
        assert attributes["event.name"] == {"stringValue": "switch_core.usage_snapshot"}

    async def test_a_count_is_a_number_not_a_string(self) -> None:
        """OTLP renders `intValue` as a JSON string, which arrives in analytics
        as text and cannot be summed."""
        body = await self._capture(lambda request: httpx.Response(200))
        record = body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
        attributes = {a["key"]: a["value"] for a in record["attributes"]}

        assert attributes["room_count"] == {"doubleValue": 7.0}

    async def test_a_boolean_stays_a_boolean(self) -> None:
        body = await self._capture(lambda request: httpx.Response(200))
        record = body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
        attributes = {a["key"]: a["value"] for a in record["attributes"]}

        assert attributes["from_template"] == {"boolValue": True}

    async def test_the_body_carries_the_name_so_the_log_line_is_not_blank(
        self,
    ) -> None:
        body = await self._capture(lambda request: httpx.Response(200))
        record = body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]

        assert record["body"] == {"stringValue": "switch_core.usage_snapshot"}

    async def test_no_credential_is_sent(self) -> None:
        """The relay takes none, and holds the vendor keys itself."""
        seen: dict[str, str] = {}

        def _handle(request: httpx.Request) -> httpx.Response:
            seen.update(request.headers)
            return httpx.Response(200)

        sink = OtlpRelaySink(
            endpoint="https://relay.example/v1/logs", timeout_seconds=5
        )
        sink._client = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        await sink.send(TelemetryRecord("switch_core.x", {}, {"service.name": "s"}, 1))
        await sink.aclose()

        assert "authorization" not in seen
        assert "x-api-key" not in seen


class TestTheRelayMisbehaving:
    async def _send_against(self, handler: object) -> None:
        sink = OtlpRelaySink(
            endpoint="https://relay.example/v1/logs", timeout_seconds=5
        )
        sink._client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)  # type: ignore[arg-type]
        )
        await sink.send(TelemetryRecord("switch_core.x", {}, {"service.name": "s"}, 1))
        await sink.aclose()

    async def test_a_refusal_is_swallowed(self) -> None:
        await self._send_against(lambda request: httpx.Response(503))

    async def test_a_network_error_is_swallowed(self) -> None:
        def _boom(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route")

        await self._send_against(_boom)

    async def test_a_timeout_is_swallowed(self) -> None:
        def _slow(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("too slow")

        await self._send_against(_slow)

    async def test_a_partial_success_inside_a_200_is_noticed(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A 200 does not mean the record was kept. Without reading the body a
        misconfigured deployment reports nothing and looks healthy doing it."""
        with caplog.at_level("WARNING"):
            await self._send_against(
                lambda request: httpx.Response(
                    200, json={"partialSuccess": {"rejectedLogRecords": "3"}}
                )
            )

        assert "rejected 3 record(s)" in caplog.text

    async def test_an_empty_200_is_not_treated_as_a_rejection(self) -> None:
        await self._send_against(lambda request: httpx.Response(200))


class TestNullSink:
    async def test_it_discards_and_closes(self) -> None:
        sink = NullSink()
        await sink.send(TelemetryRecord("switch_core.x", {}, {}, 1))
        await sink.aclose()


class TestShutdown:
    async def test_in_flight_sends_are_awaited(self) -> None:
        """The events worth losing least are the ones emitted just before the
        process goes away."""
        started = asyncio.Event()

        class _Slow:
            def __init__(self) -> None:
                self.finished = False

            async def send(self, record: TelemetryRecord) -> None:
                started.set()
                await asyncio.sleep(0.05)
                self.finished = True

            async def aclose(self) -> None:
                return None

        sink = _Slow()
        service = _service(sink)
        service.emit("deployment_started", tenant_count=1)
        await started.wait()
        await service.aclose()

        assert sink.finished
