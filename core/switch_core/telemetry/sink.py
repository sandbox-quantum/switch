"""Where a validated event actually goes: the only thing that knows there is an
HTTP request involved.

The wire format belongs to `switch_core.observability.otlp`, shared with the
operational export. What is here is what a product event needs on top: the
`eventName` field the relay's exporter reads, and a failure policy that never
lets a reporting problem reach the caller.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

from switch_core.observability.otlp import (
    LogRecord,
    OtlpClient,
    OtlpResource,
    OtlpSendError,
    build_logs_payload,
)
from switch_core.telemetry.catalogue import PropertyValue

logger = logging.getLogger(__name__)

# OTLP's severity number for INFO. A product event is not a log line, but the
# relay carries it as one, and a record with no severity is rendered by some
# receivers as an error.
_SEVERITY_INFO = 9


@dataclass(frozen=True)
class TelemetryRecord:
    """One validated event, ready to send.

    `name` is already prefixed. `properties` has already been checked against
    the catalogue: a sink must not have to trust or re-check its caller, and
    must never be the thing that decides what is allowed to leave.
    """

    name: str
    properties: dict[str, PropertyValue]
    resource: dict[str, str]
    timestamp_ns: int


class TelemetrySink(Protocol):
    """The seam. One method, and it never raises."""

    async def send(self, record: TelemetryRecord) -> None: ...

    async def aclose(self) -> None: ...


class NullSink:
    """Drops everything. Off is a sink that discards, so no call site has to
    ask whether telemetry is on."""

    async def send(self, record: TelemetryRecord) -> None:
        return None

    async def aclose(self) -> None:
        return None


class OtlpRelaySink:
    """Posts one OTLP log record per event to the relay.

    Log records, not metrics: the relay routes on them and the analytics
    exporter reads them as events. A metric would be dropped without complaint.

    **The event name goes in two places** — the record's `eventName` field and
    an `event.name` attribute. The relay filters on the attribute, the exporter
    reads the field, and sending only one is accepted with a 200 at every hop
    and then discarded. That is the easiest way to believe this works when it
    does not.

    No batching and no retry, matching the operational exporter.
    """

    def __init__(self, *, client: OtlpClient) -> None:
        self._client = client

    async def send(self, record: TelemetryRecord) -> None:
        payload = build_logs_payload(
            [
                LogRecord(
                    # Datadog renders this as the log message, and a blank one
                    # makes the event unreadable there.
                    body=record.name,
                    severity_text="INFO",
                    severity_number=_SEVERITY_INFO,
                    time_nanos=record.timestamp_ns,
                    attributes={"event.name": record.name, **record.properties},
                )
            ],
            _resource_from(record),
        )
        _add_event_name(payload, record.name)

        try:
            await self._client.post("logs", payload)
        except OtlpSendError as exc:
            # Switch has to keep working while analytics is down.
            logger.warning(
                "Telemetry event %s was not sent: %s. The event is dropped; "
                "there is no retry.",
                record.name,
                exc,
            )

    async def aclose(self) -> None:
        # `telemetry/setup.py` opens the client and `main._drain_telemetry`
        # closes it, under a timeout shutdown depends on.
        return None


def _resource_from(record: TelemetryRecord) -> OtlpResource:
    """The record's resource attributes, as the shared encoder wants them.

    Rebuilt here rather than in the service, so only this file depends on the
    observability package.
    """
    return OtlpResource(
        service_name=record.resource["service.name"],
        service_version=record.resource.get("service.version"),
        environment=record.resource.get("deployment.environment"),
        deployment_id=record.resource["flint.client_id"],
    )


def _add_event_name(payload: dict[str, Any], name: str) -> None:
    """Set the record's own `eventName` field, which `build_logs_payload` does
    not: an operational log line has no event name."""
    for resource_log in payload["resourceLogs"]:
        for scope_log in resource_log["scopeLogs"]:
            for record in scope_log["logRecords"]:
                record["eventName"] = name
