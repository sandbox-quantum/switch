"""Where a validated event actually goes.

One narrow seam, with the relay behind it. Everything above this file — the
catalogue, the snapshot, the call sites — is about *what* Switch reports;
everything below is about the wire. Keeping the two apart is what lets the
operational-observability work (`CHOO-2807`) replace the transport without
touching a single call site: the sink is the only thing that knows there is an
HTTP request involved at all.

The wire format is not ours to choose. The relay is already serving Switch
Console, and its expectations are exacting in ways that fail silently rather
than loudly — see :class:`OtlpRelaySink` for the two that bite.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import httpx

from switch_core.telemetry.catalogue import PropertyValue

logger = logging.getLogger(__name__)


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

    **Log records, not metrics or spans.** The relay routes on log records and
    the downstream product-analytics exporter reads them as events; a metric
    would be dropped without complaint.

    **The event name goes in two places** — the log record's own `eventName`
    field and an `event.name` attribute. The relay's filter reads the
    attribute; the exporter reads the field. Sending only one is accepted with
    a 200 at every hop and then quietly discarded, which is the single easiest
    way to believe this is working when it is not.

    No batching and no retry, matching the Console. A dropped event is a lost
    row in an analytics chart, and the alternative — a queue that grows while
    the relay is unreachable, on a process that is already the deployment's
    single point of failure — costs more than it saves. Failures are logged
    with a reason so a deployment reporting nothing is diagnosable rather than
    merely silent.
    """

    def __init__(self, *, endpoint: str, timeout_seconds: float) -> None:
        self._endpoint = endpoint
        self._client = httpx.AsyncClient(
            timeout=timeout_seconds,
            headers={"User-Agent": "switch-core"},
        )

    async def send(self, record: TelemetryRecord) -> None:
        try:
            response = await self._client.post(self._endpoint, json=_payload(record))
        except httpx.TimeoutException:
            logger.warning(
                "Telemetry event %s was not sent: the relay did not answer in "
                "time. The event is dropped; there is no retry.",
                record.name,
            )
            return
        except httpx.HTTPError as exc:
            logger.warning(
                "Telemetry event %s was not sent: %s. The event is dropped.",
                record.name,
                type(exc).__name__,
            )
            return

        if response.status_code >= 400:
            logger.warning(
                "Telemetry event %s was refused by the relay with HTTP %d.",
                record.name,
                response.status_code,
            )
            return

        # A 200 does not mean the record was kept: OTLP answers partial
        # success in the body. Without this a misconfigured deployment reports
        # nothing and looks perfectly healthy doing it.
        rejected = _rejected_count(response)
        if rejected:
            logger.warning(
                "The relay accepted the request for telemetry event %s but "
                "rejected %d record(s) in it.",
                record.name,
                rejected,
            )

    async def aclose(self) -> None:
        await self._client.aclose()


def _rejected_count(response: httpx.Response) -> int:
    """How many records the relay rejected inside a 2xx, best effort.

    A body that is absent, empty, or not JSON is the ordinary success case for
    some collectors, so none of those are worth a warning of their own.
    """
    if not response.content:
        return 0
    try:
        body = response.json()
    except ValueError:
        return 0
    if not isinstance(body, dict):
        return 0
    partial = body.get("partialSuccess")
    if not isinstance(partial, dict):
        return 0
    rejected = partial.get("rejectedLogRecords", 0)
    # OTLP/JSON renders 64-bit integers as strings.
    try:
        return int(rejected)
    except (TypeError, ValueError):
        return 0


def _attribute(key: str, value: PropertyValue) -> dict[str, object]:
    """One OTLP key/value.

    Numbers go as `doubleValue` rather than `intValue`, whose OTLP/JSON
    encoding is a *string* — which arrives in analytics as text and cannot be
    summed or averaged. `bool` is checked before `int` because it is a
    subclass of it and would otherwise be reported as 0 and 1.
    """
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int | float):
        return {"key": key, "value": {"doubleValue": float(value)}}
    return {"key": key, "value": {"stringValue": value}}


def _payload(record: TelemetryRecord) -> dict[str, object]:
    attributes = [
        _attribute("event.name", record.name),
        *(_attribute(key, value) for key, value in record.properties.items()),
    ]
    return {
        "resourceLogs": [
            {
                "resource": {
                    "attributes": [
                        _attribute(key, value) for key, value in record.resource.items()
                    ]
                },
                "scopeLogs": [
                    {
                        "scope": {"name": "switch-core"},
                        "logRecords": [
                            {
                                "timeUnixNano": str(record.timestamp_ns),
                                "observedTimeUnixNano": str(record.timestamp_ns),
                                "severityNumber": 9,
                                "severityText": "INFO",
                                # The name again, as the record's own field.
                                # Both are required; see the class docstring.
                                "eventName": record.name,
                                # Datadog renders this as the log message, and
                                # a blank one makes the event unreadable there.
                                "body": {"stringValue": record.name},
                                "attributes": attributes,
                            }
                        ],
                    }
                ],
            }
        ]
    }
