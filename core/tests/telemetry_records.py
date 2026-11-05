"""Reading what a test's telemetry sink was handed."""

from __future__ import annotations

from switch_core.telemetry.catalogue import DEPLOYMENT_KIND_PROPERTY, PropertyValue
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord


def declared(record: TelemetryRecord) -> dict[str, PropertyValue]:
    """The properties the event itself declared, without the one the service
    adds to every event (`DEPLOYMENT_KIND_PROPERTY`), so a test can compare an
    event's properties exactly."""
    return {
        name: value
        for name, value in record.properties.items()
        if name != DEPLOYMENT_KIND_PROPERTY
    }


class RecordingSink:
    """A sink that keeps what it is handed."""

    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None

    def events(self, name: str) -> list[dict[str, PropertyValue]]:
        """The declared properties of every `name` event sent, in order."""
        return [
            declared(record)
            for record in self.sent
            if record.name == f"switch_core.{name}"
        ]


def recording_telemetry() -> tuple[TelemetryService, RecordingSink]:
    """An enabled telemetry service over a `RecordingSink`."""
    sink = RecordingSink()
    service = TelemetryService(
        sink=sink,
        enabled=True,
        client_id="deployment-uuid",
        version="1.0.0",
        telemetry_environment="prod",
        telemetry_internal=False,
        deployment_kind="switch_cloud",
    )
    return service, sink
