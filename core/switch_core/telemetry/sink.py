"""Where a validated event actually goes.

One narrow seam, with the relay behind it. Everything above this file — the
catalogue, the snapshot, the call sites — is about *what* Switch reports;
everything below is about the wire. The sink is the only thing that knows there
is an HTTP request involved at all.

**The wire format is not ours.** `switch_core.observability.otlp` owns it, for
both this and the operational export: one encoder, one client, one set of
resource attributes, and one place where the protobuf-JSON rules that nothing
else would catch are written down and tested. A second copy here would be a
second thing to keep correct, and the failure would be invisible — the relay
answers 200 to a malformed payload and drops it.

What this file adds is the two things that are specific to a product event:
the `eventName` field the relay's exporter reads, and a failure policy that
never lets a reporting problem reach the caller.
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
    """Drops everything, for when telemetry is off.

    The service holds a sink unconditionally so that no call site has to ask
    whether telemetry is on — a question every call site would eventually
    answer differently. Off is a sink that discards, not a `None` to check.
    """

    async def send(self, record: TelemetryRecord) -> None:
        return None

    async def aclose(self) -> None:
        return None


class OtlpRelaySink:
    """Posts one OTLP log record per event to the relay.

    **Log records, not metrics.** The relay routes on log records and the
    product-analytics exporter beyond it reads them as events; a metric would
    be dropped without complaint. That is why this does not go through the
    operational export's metric path even though both end at the same relay by
    default — and why the two endpoints stay separately configurable, since a
    deployment pointing its metrics at its own collector must not thereby send
    its usage analytics there too.

    **The event name goes in two places** — the log record's own `eventName`
    field and an `event.name` attribute. The relay's filter reads the
    attribute; the exporter reads the field. Sending only one is accepted with
    a 200 at every hop and then quietly discarded, which is the single easiest
    way to believe this is working when it is not. `build_logs_payload` writes
    the attribute; the field is added here, because it is meaningful for a
    product event and not for an operational log line.

    No batching and no retry, matching both the Console and the operational
    exporter. A dropped event is a lost row in a chart, and the alternative —
    a queue growing while the relay is unreachable, in the process that is
    already this deployment's single point of failure — costs more than it
    saves.
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
            # Logged and dropped. The relay being slow, unreachable or unhappy
            # is an operational condition with nothing to do with whatever was
            # being reported, and Switch working while analytics is down is the
            # only acceptable behaviour.
            logger.warning(
                "Telemetry event %s was not sent: %s. The event is dropped; "
                "there is no retry.",
                record.name,
                exc,
            )

    async def aclose(self) -> None:
        # Nothing to do: `telemetry/setup.py` opens the HTTP client and
        # `main._drain_telemetry` closes it, under a timeout that shutdown
        # depends on. Closing it here as well would be a second close on the
        # same object and would move the work out from under that budget.
        return None


def _resource_from(record: TelemetryRecord) -> OtlpResource:
    """The record's resource attributes, as the shared encoder wants them.

    The service builds the map (it is the same map on every event of a run);
    this turns it back into the dataclass rather than having the service depend
    on the observability package, so the seam stays one file wide.
    """
    return OtlpResource(
        service_name=record.resource["service.name"],
        service_version=record.resource.get("service.version"),
        environment=record.resource.get("deployment.environment"),
        deployment_id=record.resource["flint.client_id"],
    )


def _add_event_name(payload: dict[str, Any], name: str) -> None:
    """Set the log record's own `eventName` field.

    Not part of `build_logs_payload`, because an operational log line has no
    event name and a field that is sometimes absent is worse than one this
    caller adds deliberately. Reaching into the payload keeps the shared
    encoder unaware of product events; the test pins that both places carry it.
    """
    for resource_log in payload["resourceLogs"]:
        for scope_log in resource_log["scopeLogs"]:
            for record in scope_log["logRecords"]:
                record["eventName"] = name
