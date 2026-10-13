"""Everything the catalogue can send is named in `docs/old/telemetry-events.md`.

The doc is what a reader outside the code — InfoSec, an operator deciding
whether to switch telemetry on — takes as the list of what leaves a deployment.
An event, property or value added to the catalogue and not to the doc is sent
without anyone having been told, which is the gap this closes.

Presence anywhere in the doc, backticked, rather than under the right heading:
the doc describes events in tables, prose and shared value sets, and a check
that knew its layout would fail on every rewrite of it.

Two things are left out on purpose. `bridge_platform`'s registered platforms
and the `connector_<platform>_count` snapshot keys follow the platform registry,
so adding a platform stays a change to that platform alone; the doc covers them
generically.
"""

from __future__ import annotations

from pathlib import Path

from switch_core.telemetry.catalogue import CATALOGUE

DOC = Path(__file__).parents[4] / "docs" / "old" / "telemetry-events.md"


def _closed_values(spec: object) -> frozenset[str]:
    """The values a property spells out in the catalogue, if any."""
    if type(spec).__name__ != "_OneOf":
        return frozenset()
    return spec.values  # type: ignore[attr-defined]


def _undocumented() -> list[str]:
    doc = DOC.read_text()
    missing: set[str] = set()
    for event, spec in CATALOGUE.items():
        names = {event, *spec}
        for prop in spec.values():
            names |= _closed_values(prop)
        missing |= {name for name in names if f"`{name}`" not in doc}
    return sorted(missing)


def test_every_event_property_and_value_is_documented() -> None:
    missing = _undocumented()
    assert not missing, (
        f"{missing} can be sent to the relay but are not named in "
        f"{DOC.relative_to(DOC.parents[2])}. Document them there — the doc is "
        "the list readers are told is complete."
    )
