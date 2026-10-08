"""Where a validated event actually goes: the only thing that knows there is an
HTTP request involved.

The wire format belongs to `switch_core.observability.otlp`, shared with the
operational export. What is here is what a product event needs on top: the
`eventName` field the relay's exporter reads, and a failure policy that never
lets a reporting problem reach the caller.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from switch_core.observability.otlp import (
    LogRecord,
    OtlpClient,
    OtlpPartialRejection,
    OtlpResource,
    OtlpSendError,
    build_logs_payload,
    otlp_attributes,
)
from switch_core.telemetry.catalogue import PropertyValue
from switch_core.telemetry.throttle import WarningThrottle

logger = logging.getLogger(__name__)

# OTLP's severity number for INFO. A product event is not a log line, but the
# relay carries it as one, and a record with no severity is rendered by some
# receivers as an error.
_SEVERITY_INFO = 9

_DROP_WARNING_INTERVAL_SECONDS = 60.0


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
    """The seam. `send` hands a record over and returns at once: it never
    raises and never waits on the network, so it is safe to call once per
    message. Called with an event loop running."""

    def send(self, record: TelemetryRecord) -> None: ...

    async def aclose(self) -> None: ...


class NullSink:
    """Drops everything. Off is a sink that discards, so no call site has to
    ask whether telemetry is on."""

    def send(self, record: TelemetryRecord) -> None:
        return None

    async def aclose(self) -> None:
        return None


class OtlpRelaySink:
    """Posts events to the relay as OTLP log records, a batch at a time.

    Log records, not metrics: the relay routes on them and the analytics
    exporter reads them as events. A metric would be dropped without complaint.

    **The event name goes in two places** — the record's `eventName` field and
    an `event.name` attribute. The relay filters on the attribute, the exporter
    reads the field, and sending only one is accepted with a 200 at every hop
    and then discarded. That is the easiest way to believe this works when it
    does not.

    **Batched**, because the message events fire once per message: a busy
    server posting one request per event would be a load the relay was never
    sized for, and would trip the rate limit it keys on the sender's address.
    `send` only buffers; one task posts every `flush_interval_seconds`, or as
    soon as `max_batch` records are waiting, and `aclose` posts what is left.
    A flush posts what was buffered when it began and no more: what arrives
    while it is posting waits for the next interval or a full batch, or a
    steady trickle would become a request per event again.

    No retry, matching the operational exporter, and the buffer is bounded: a
    relay that stops answering costs the events it misses, never memory.
    """

    def __init__(
        self,
        *,
        client: OtlpClient,
        flush_interval_seconds: float,
        max_batch: int,
        max_buffered: int,
    ) -> None:
        self._client = client
        self._flush_interval = flush_interval_seconds
        self._max_batch = max_batch
        self._max_buffered = max_buffered
        self._buffer: list[TelemetryRecord] = []
        self._wake = asyncio.Event()
        self._flusher: asyncio.Task[None] | None = None
        self._closing = False
        self._drops = WarningThrottle(_DROP_WARNING_INTERVAL_SECONDS)

    def send(self, record: TelemetryRecord) -> None:
        if self._closing:
            # Shutdown has already taken the final batch; posting this one
            # would race the client being closed.
            logger.warning(
                "Telemetry event %s arrived after shutdown began and was dropped.",
                record.name,
            )
            return
        if len(self._buffer) >= self._max_buffered:
            if (dropped := self._drops.note()) is not None:
                self._warn_dropped(dropped)
            return
        self._buffer.append(record)
        if self._flusher is None or self._flusher.done():
            # A fresh context, so its warnings do not carry the log fields of
            # whichever request happened to emit first.
            self._flusher = asyncio.get_running_loop().create_task(
                self._run(), context=contextvars.Context()
            )
        if len(self._buffer) >= self._max_batch:
            self._wake.set()

    def _warn_dropped(self, dropped: int) -> None:
        logger.warning(
            "Telemetry buffer is full (%d events waiting on the relay): %d "
            "event(s) dropped since the last warning.",
            self._max_buffered,
            dropped,
        )

    async def _run(self) -> None:
        while not self._closing:
            try:
                async with asyncio.timeout(self._flush_interval):
                    await self._wake.wait()
            except TimeoutError:
                pass
            self._wake.clear()
            await self._flush_logging_bugs()
        await self._flush_logging_bugs()

    async def _flush_logging_bugs(self) -> None:
        # A relay failure is already handled in `_post`; anything reaching
        # here is a bug in building the batch, and must not end the task that
        # every later event depends on.
        try:
            await self._flush()
        except Exception:
            logger.exception("Telemetry batch could not be built; it is dropped.")

    async def _flush(self) -> None:
        pending, self._buffer = self._buffer, []
        for start in range(0, len(pending), self._max_batch):
            await self._post(pending[start : start + self._max_batch])

    async def _post(self, batch: Sequence[TelemetryRecord]) -> None:
        # Every record a service emits carries the same resource, so this is
        # one payload in practice; grouping keeps two services sharing a sink
        # from being reported under each other's identity.
        by_resource: dict[tuple[tuple[str, str], ...], list[TelemetryRecord]] = {}
        for record in batch:
            key = tuple(sorted(record.resource.items()))
            by_resource.setdefault(key, []).append(record)

        for records in by_resource.values():
            payload = build_logs_payload(
                [
                    LogRecord(
                        # Datadog renders this as the log message, and a blank
                        # one makes the event unreadable there.
                        body=record.name,
                        severity_text="INFO",
                        severity_number=_SEVERITY_INFO,
                        time_nanos=record.timestamp_ns,
                        attributes={"event.name": record.name, **record.properties},
                    )
                    for record in records
                ],
                _resource_from(records[0]),
            )
            _add_event_names(payload, [record.name for record in records])
            _add_relay_context(payload, records[0].resource)

            names = ", ".join(sorted({record.name for record in records}))
            try:
                await self._client.post("logs", payload)
            except OtlpPartialRejection as exc:
                logger.warning(
                    "The relay rejected %d of %d telemetry event(s) in a batch "
                    "(%s): %s. The rest were accepted; there is no retry.",
                    exc.rejected,
                    len(records),
                    names,
                    exc.reason,
                )
            except OtlpSendError as exc:
                # Switch has to keep working while analytics is down.
                logger.warning(
                    "Telemetry batch of %d event(s) (%s) was not sent: %s. The "
                    "batch is dropped; there is no retry.",
                    len(records),
                    names,
                    exc,
                )

    async def aclose(self) -> None:
        """Post everything still buffered.

        `telemetry/setup.py` opens the HTTP client and `main._drain_telemetry`
        closes it, under a timeout shutdown depends on.
        """
        self._closing = True
        self._wake.set()
        if self._flusher is not None:
            await self._flusher
        else:
            await self._flush()
        if dropped := self._drops.take_pending():
            self._warn_dropped(dropped)


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
        commit_sha=None,
        repository_url=None,
    )


def _add_relay_context(payload: dict[str, Any], resource: Mapping[str, str]) -> None:
    """Add `flint_env` and `flint_internal` to the resource, which the shared
    encoder's resource has no fields for: it describes the process to an
    operator's own collector, where they mean nothing. The relay sends each
    event to the Amplitude project `flint_env` names, and drops one it cannot
    place; `flint_internal` tells staff usage from adoption."""
    context = {key: resource[key] for key in ("flint_env", "flint_internal")}
    for resource_log in payload["resourceLogs"]:
        resource_log["resource"]["attributes"].extend(otlp_attributes(context))


def _add_event_names(payload: dict[str, Any], names: Sequence[str]) -> None:
    """Set each record's own `eventName` field, which `build_logs_payload` does
    not: an operational log line has no event name. `names` is in the order
    the records were handed to the encoder, which keeps it."""
    encoded = [
        record
        for resource_log in payload["resourceLogs"]
        for scope_log in resource_log["scopeLogs"]
        for record in scope_log["logRecords"]
    ]
    for record, name in zip(encoded, names, strict=True):
        record["eventName"] = name
