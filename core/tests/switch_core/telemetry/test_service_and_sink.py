"""Consent, the wire format, and what happens when the relay misbehaves."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from switch_core.observability.otlp import OtlpClient
from switch_core.telemetry.catalogue import TelemetryCatalogueError
from switch_core.telemetry.service import TelemetryService, emit_safely
from switch_core.telemetry.sink import NullSink, OtlpRelaySink, TelemetryRecord


def _relay_sink(
    http: httpx.AsyncClient,
    *,
    flush_interval_seconds: float = 60.0,
    max_batch: int = 200,
    max_buffered: int = 10_000,
) -> OtlpRelaySink:
    """A relay sink whose timer will not fire inside a test unless asked to:
    a test posts by closing it, or by filling a batch."""
    return OtlpRelaySink(
        client=OtlpClient("https://relay.example", 5, {}, http),
        flush_interval_seconds=flush_interval_seconds,
        max_batch=max_batch,
        max_buffered=max_buffered,
    )


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []
        self.closed = False

    def send(self, record: TelemetryRecord) -> None:
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
        telemetry_environment="prod",
        telemetry_internal=False,
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
            "flint_env": "prod",
            "flint_internal": "false",
            "service.version": "1.2.3",
            "deployment.environment": "pilot",
        }

    @pytest.mark.parametrize("environment", ["prod", "staging", "dev", "local"])
    async def test_every_event_says_which_amplitude_project_it_belongs_in(
        self, environment: str
    ) -> None:
        """The relay sends each event to the Amplitude project its `flint_env`
        names, so a development server's usage never lands in production's."""
        sink = _RecordingSink()
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id="deployment-uuid",
            service_name="switch-core",
            version="1.2.3",
            environment=None,
            telemetry_environment=environment,
            telemetry_internal=False,
        )

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert sink.sent[0].resource["flint_env"] == environment

    @pytest.mark.parametrize(("internal", "sent"), [(True, "true"), (False, "false")])
    async def test_every_event_says_whether_the_deployment_is_the_companys_own(
        self, internal: bool, sent: str
    ) -> None:
        """So staff usage can be told from adoption without any identifier."""
        sink = _RecordingSink()
        service = TelemetryService(
            sink=sink,  # type: ignore[arg-type]
            enabled=True,
            client_id="deployment-uuid",
            service_name="switch-core",
            version="1.2.3",
            environment=None,
            telemetry_environment="prod",
            telemetry_internal=internal,
        )

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert sink.sent[0].resource["flint_internal"] == sent

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
            telemetry_environment="prod",
            telemetry_internal=False,
        )

        service.emit("deployment_started", tenant_count=1)
        await service.aclose()

        assert "deployment.environment" not in sink.sent[0].resource
        assert "service.version" not in sink.sent[0].resource


class TestFailuresDoNotReachTheCaller:
    async def test_a_sink_that_raises_does_not_surface(self) -> None:
        class _Broken:
            def send(self, record: TelemetryRecord) -> None:
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
    """The relay's expectations, which fail silently rather than loudly.

    The encoding itself belongs to `observability/otlp.py` and is tested
    there; what is pinned here is the part specific to a product event — that
    the name reaches both places the relay needs it, and that the shared
    encoder is being handed what it expects.
    """

    async def _capture(self, handler: object) -> dict:
        captured: dict = {}

        def _handle(request: httpx.Request) -> httpx.Response:
            captured.update(json.loads(request.content))
            return handler(request)  # type: ignore[operator]

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http)
        sink.send(
            TelemetryRecord(
                name="switch_core.usage_snapshot",
                properties={"room_count": 7, "from_template": True, "kind": "user"},
                resource={
                    "service.name": "switch-core",
                    "flint.client_id": "deployment-uuid",
                    "flint_env": "dev",
                    "flint_internal": "false",
                },
                timestamp_ns=1_700_000_000_000_000_000,
            )
        )
        await sink.aclose()
        await http.aclose()
        return captured

    def _record(self, body: dict) -> dict:
        return body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]

    async def test_the_event_name_is_sent_in_both_required_places(self) -> None:
        """The relay filters on the attribute and the exporter reads the field.
        Sending only one is accepted with a 200 and silently discarded."""
        record = self._record(await self._capture(lambda r: httpx.Response(200)))

        assert record["eventName"] == "switch_core.usage_snapshot"
        attributes = {a["key"]: a["value"] for a in record["attributes"]}
        assert attributes["event.name"] == {"stringValue": "switch_core.usage_snapshot"}

    async def test_a_count_is_a_number_not_a_string(self) -> None:
        """OTLP renders `intValue` as a JSON string, which arrives in analytics
        as text and cannot be summed."""
        record = self._record(await self._capture(lambda r: httpx.Response(200)))
        attributes = {a["key"]: a["value"] for a in record["attributes"]}

        assert attributes["room_count"] == {"doubleValue": 7.0}

    async def test_a_boolean_stays_a_boolean(self) -> None:
        record = self._record(await self._capture(lambda r: httpx.Response(200)))
        attributes = {a["key"]: a["value"] for a in record["attributes"]}

        assert attributes["from_template"] == {"boolValue": True}

    async def test_a_false_and_a_zero_are_sent_rather_than_dropped(self) -> None:
        """Falsy values are where an encoder that tests `if value:` loses them,
        and a missing property reads downstream exactly like one never sent."""
        body: dict = {}

        def _handle(request: httpx.Request) -> httpx.Response:
            body.update(json.loads(request.content))
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http)
        sink.send(
            TelemetryRecord(
                name="switch_core.connector_added",
                properties={
                    "is_preconfigured": False,
                    "failed_attempts_before_success": 0,
                },
                resource={
                    "service.name": "switch-core",
                    "flint.client_id": "deployment-uuid",
                    "flint_env": "prod",
                    "flint_internal": "false",
                },
                timestamp_ns=1_700_000_000_000_000_000,
            )
        )
        await sink.aclose()
        await http.aclose()
        attributes = {a["key"]: a["value"] for a in self._record(body)["attributes"]}

        assert attributes["is_preconfigured"] == {"boolValue": False}
        assert attributes["failed_attempts_before_success"] == {"doubleValue": 0.0}

    async def test_the_body_carries_the_name_so_the_log_line_is_not_blank(
        self,
    ) -> None:
        record = self._record(await self._capture(lambda r: httpx.Response(200)))

        assert record["body"] == {"stringValue": "switch_core.usage_snapshot"}

    async def test_the_deployment_is_identified_on_the_resource(self) -> None:
        body = await self._capture(lambda r: httpx.Response(200))
        resource = {
            a["key"]: a["value"]
            for a in body["resourceLogs"][0]["resource"]["attributes"]
        }

        assert resource["flint.client_id"] == {"stringValue": "deployment-uuid"}
        assert resource["service.name"] == {"stringValue": "switch-core"}
        # The relay sends each event to the Amplitude project this names.
        assert resource["flint_env"] == {"stringValue": "dev"}
        assert resource["flint_internal"] == {"stringValue": "false"}

    async def test_it_posts_to_the_logs_signal(self) -> None:
        """Not `/v1/metrics`: the relay routes on log records, and a metric
        would be dropped without complaint."""
        seen: list[str] = []

        def _handle(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http)
        sink.send(_a_record())
        await sink.aclose()
        await http.aclose()

        assert seen == ["https://relay.example/v1/logs"]

    async def test_no_credential_is_sent(self) -> None:
        """The relay takes none, and holds the vendor keys itself."""
        seen: dict[str, str] = {}

        def _handle(request: httpx.Request) -> httpx.Response:
            seen.update(request.headers)
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http)
        sink.send(_a_record())
        await sink.aclose()
        await http.aclose()

        assert "authorization" not in seen
        assert "x-api-key" not in seen


class TestTheRelayMisbehaving:
    """Every failure is logged and dropped. None reaches the caller."""

    async def _send_against(self, handler: object) -> None:
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(handler)  # type: ignore[arg-type]
        )
        sink = _relay_sink(http)
        sink.send(_a_record())
        await sink.aclose()
        await http.aclose()

    async def test_a_refusal_is_swallowed(self) -> None:
        await self._send_against(lambda r: httpx.Response(503))

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
        """A 200 does not mean the record was kept. Without this a
        misconfigured deployment reports nothing and looks healthy doing it."""
        with caplog.at_level("WARNING"):
            await self._send_against(
                lambda r: httpx.Response(
                    200, json={"partialSuccess": {"rejectedLogRecords": "1"}}
                )
            )

        assert "rejected 1 of 1" in caplog.text

    async def test_a_partial_success_reports_what_was_lost_not_the_batch(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """One rejected record out of a batch is one lost, not the batch:
        reporting the whole batch as unsent misstates the loss and sends an
        operator after the wrong problem."""
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(
                    200,
                    json={
                        "partialSuccess": {
                            "rejectedLogRecords": "1",
                            "errorMessage": "too many attributes",
                        }
                    },
                )
            )
        )
        sink = _relay_sink(http)
        for _ in range(3):
            sink.send(_a_record())
        with caplog.at_level("WARNING"):
            await sink.aclose()
        await http.aclose()

        assert "rejected 1 of 3" in caplog.text
        assert "too many attributes" in caplog.text
        assert "was not sent" not in caplog.text

    async def test_an_empty_200_is_not_treated_as_a_rejection(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level("WARNING"):
            await self._send_against(lambda r: httpx.Response(200))

        assert "was not sent" not in caplog.text


def _a_record() -> TelemetryRecord:
    return TelemetryRecord(
        name="switch_core.deployment_started",
        properties={"tenant_count": 1},
        resource={
            "service.name": "switch-core",
            "flint.client_id": "deployment-uuid",
            "flint_env": "dev",
            "flint_internal": "false",
        },
        timestamp_ns=1,
    )


class TestBatching:
    """The message events fire once per message, so the relay sink posts many
    events per request rather than one request per event."""

    async def test_events_wait_and_go_together(self) -> None:
        bodies: list[dict] = []

        def _handle(request: httpx.Request) -> httpx.Response:
            bodies.append(json.loads(request.content))
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http)
        for name in ("switch_core.room_message_sent", "switch_core.agent_message_sent"):
            sink.send(TelemetryRecord(name, {}, _a_record().resource, 1))

        assert bodies == []
        await sink.aclose()
        await http.aclose()

        assert len(bodies) == 1
        records = bodies[0]["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        # Each record keeps its own name, in both places the relay reads it.
        assert [r["eventName"] for r in records] == [
            "switch_core.room_message_sent",
            "switch_core.agent_message_sent",
        ]
        assert [r["body"]["stringValue"] for r in records] == [
            r["eventName"] for r in records
        ]

    async def test_a_full_batch_goes_without_waiting_for_the_timer(self) -> None:
        posted = asyncio.Event()
        sizes: list[int] = []

        def _handle(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            sizes.append(len(body["resourceLogs"][0]["scopeLogs"][0]["logRecords"]))
            posted.set()
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http, max_batch=3)
        for _ in range(3):
            sink.send(_a_record())

        async with asyncio.timeout(2):
            await posted.wait()
        await sink.aclose()
        await http.aclose()

        assert sizes == [3]

    async def test_events_arriving_mid_post_wait_for_the_next_flush(self) -> None:
        """A flush posts what it found and no more. Draining until empty would,
        under steady traffic, post back to back in batches of a few events and
        never return to waiting — the per-event request load batching is for."""
        sizes: list[int] = []
        in_flight = asyncio.Event()
        release = asyncio.Event()

        async def _handle(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            sizes.append(len(body["resourceLogs"][0]["scopeLogs"][0]["logRecords"]))
            in_flight.set()
            await release.wait()
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http, max_batch=2)
        sink.send(_a_record())
        sink.send(_a_record())
        async with asyncio.timeout(2):
            await in_flight.wait()
        sink.send(_a_record())
        release.set()
        await asyncio.sleep(0.05)

        assert sizes == [2]
        await sink.aclose()
        await http.aclose()
        assert sizes == [2, 1]

    async def test_the_timer_posts_a_partial_batch(self) -> None:
        posted = asyncio.Event()

        def _handle(request: httpx.Request) -> httpx.Response:
            posted.set()
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http, flush_interval_seconds=0.01)
        sink.send(_a_record())

        async with asyncio.timeout(2):
            await posted.wait()
        await sink.aclose()
        await http.aclose()

    async def test_a_full_buffer_drops_rather_than_grows(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        bodies: list[dict] = []

        def _handle(request: httpx.Request) -> httpx.Response:
            bodies.append(json.loads(request.content))
            return httpx.Response(200)

        http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        sink = _relay_sink(http, max_batch=100, max_buffered=2)
        with caplog.at_level("WARNING"):
            for _ in range(3):
                sink.send(_a_record())
        await sink.aclose()
        await http.aclose()

        assert "buffer is full" in caplog.text
        sent = [
            r
            for body in bodies
            for r in body["resourceLogs"][0]["scopeLogs"][0]["logRecords"]
        ]
        assert len(sent) == 2

    async def test_drops_after_the_last_warning_are_reported_at_shutdown(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The warning is rate-limited, so drops after it would otherwise never
        be logged if no later drop came along to carry them."""
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(200))
        )
        sink = _relay_sink(http, max_batch=100, max_buffered=1)
        sink.send(_a_record())
        with caplog.at_level("WARNING"):
            for _ in range(4):
                sink.send(_a_record())
            await sink.aclose()
        await http.aclose()

        warnings = [
            r.getMessage() for r in caplog.records if "buffer is full" in r.getMessage()
        ]
        assert len(warnings) == 2
        assert "1 event(s) dropped" in warnings[0]
        assert "3 event(s) dropped" in warnings[1]

    async def test_a_failed_batch_names_what_it_lost(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(503))
        )
        sink = _relay_sink(http)
        sink.send(_a_record())
        with caplog.at_level("WARNING"):
            await sink.aclose()
        await http.aclose()

        assert "switch_core.deployment_started" in caplog.text


class TestNullSink:
    async def test_it_discards_and_closes(self) -> None:
        sink = NullSink()
        sink.send(TelemetryRecord("switch_core.x", {}, {}, 1))
        await sink.aclose()


class TestHandOff:
    async def test_the_sink_has_the_event_as_soon_as_emit_returns(self) -> None:
        """No task per event: the message events fire once per message, and the
        sink only buffers, so a task would be pure overhead on the loop."""
        sink = _RecordingSink()
        service = _service(sink)

        service.emit("deployment_started", tenant_count=1)

        assert [record.name for record in sink.sent] == [
            "switch_core.deployment_started"
        ]

    async def test_closing_the_service_closes_the_sink(self) -> None:
        """The sink posts what it still holds when closed: the events worth
        losing least are the ones emitted just before the process goes away."""
        sink = _RecordingSink()
        service = _service(sink)

        await service.aclose()

        assert sink.closed
