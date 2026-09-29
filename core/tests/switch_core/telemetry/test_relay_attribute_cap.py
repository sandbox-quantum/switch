"""Every event fits through the relay's attribute cap, with room to spare.

The relay drops any log record carrying more than 128 attributes, and still
answers 200. An event that grew past that would vanish from the dashboard with
nothing anywhere reporting a fault. It is the one silent drop at the relay that
Switch itself controls, so the margin is held here, beside the catalogue.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from switch_core.observability.otlp import OtlpClient
from switch_core.telemetry.catalogue import BOOLEAN, CATALOGUE, NUMBER, PropertyType
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import OtlpRelaySink, TelemetryRecord

# `filter/guard` in the relay's collector config: `Len(attributes) > 128`.
RELAY_ATTRIBUTE_CAP = 128
# Headroom, so an event growing toward the cap is caught in review rather than
# after its records have started disappearing.
MAX_ATTRIBUTES = 100


class _Capture:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _example(kind: PropertyType) -> Any:
    """A value the catalogue accepts for a property of this kind."""
    if kind is NUMBER:
        return 1
    if kind is BOOLEAN:
        return True
    return sorted(kind.values)[0]  # type: ignore[attr-defined]


async def _attributes_on_the_wire(event: str) -> list[dict[str, Any]]:
    """The log record's attributes exactly as the relay would receive them:
    validated by the service, encoded by the sink."""
    capture = _Capture()
    service = TelemetryService(
        sink=capture,  # type: ignore[arg-type]
        enabled=True,
        client_id="11111111-1111-1111-1111-111111111111",
        service_name="switch-core",
        version="1.0.0",
        environment=None,
    )
    service.emit(
        event, **{key: _example(kind) for key, kind in CATALOGUE[event].items()}
    )
    await service.aclose()

    body: dict[str, Any] = {}

    def _handle(request: httpx.Request) -> httpx.Response:
        body.update(json.loads(request.content))
        return httpx.Response(200)

    http = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
    [record] = capture.sent
    await OtlpRelaySink(client=OtlpClient("https://relay.example", 5, {}, http)).send(
        record
    )
    await http.aclose()
    return body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["attributes"]


@pytest.mark.parametrize("event", sorted(CATALOGUE))
async def test_every_event_fits_through_the_relay(event: str) -> None:
    attributes = await _attributes_on_the_wire(event)

    assert len(attributes) <= MAX_ATTRIBUTES, (
        f"{event} carries {len(attributes)} attributes on the wire. The relay "
        f"drops any record over {RELAY_ATTRIBUTE_CAP} and still answers 200, "
        f"so this event is close to vanishing without a trace. Split it."
    )
