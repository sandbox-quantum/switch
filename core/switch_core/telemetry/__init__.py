"""Product telemetry: what Switch reports about how it is used.

Counts and durations, never an identifier for a room, tenant, agent, user or
message, and never free text. Off unless an operator switches it on. The events
are declared in :mod:`switch_core.telemetry.catalogue` and explained in
``docs/old/telemetry-events.md``.

Call sites want two things from this package and nothing else: `emit_safely`,
to report an event from the middle of real work without a catalogue mistake
being able to break it, and the `TelemetryService` that gets handed around.
Everything else here is wiring.
"""

from switch_core.telemetry.catalogue import TelemetryCatalogueError
from switch_core.telemetry.service import TelemetryService, emit_safely
from switch_core.telemetry.setup import build_telemetry

__all__ = [
    "TelemetryCatalogueError",
    "TelemetryService",
    "build_telemetry",
    "emit_safely",
]
