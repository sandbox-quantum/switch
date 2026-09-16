"""The catalogue is the privacy boundary, so these are the tests that matter.

Everything here is about what *cannot* reach the relay. The counterpart to the
Console's own catalogue test, which tries to smuggle a room name into every
event and asserts it never arrives — the same trick is played below, because
the rule ("no identifier for anything inside a deployment") is only a rule if
something enforces it.
"""

from __future__ import annotations

import pytest

from switch_core.telemetry.catalogue import (
    CATALOGUE,
    EVENT_NAME_PREFIX,
    TelemetryCatalogueError,
    validate,
    wire_name,
)

# Anything that would identify something inside a deployment. None of these is
# a declared property of any event, and none may become one without this test
# being changed deliberately.
FORBIDDEN_PROPERTIES = (
    "room_id",
    "room_name",
    "tenant_id",
    "tenant_name",
    "agent_id",
    "agent_name",
    "user_id",
    "user_email",
    "message_id",
    "message_body",
    "channel_id",
    "channel_name",
    "external_channel_id",
    "display_name",
    "hostname",
    "repo_dir",
    "file_path",
    "error_message",
    "stack_trace",
)


def _one_valid_value(spec: object) -> object:
    """A value the property will accept, whatever kind it is."""
    kind = type(spec).__name__
    if kind == "_Number":
        return 1
    if kind == "_Boolean":
        return True
    return sorted(spec.values)[0]  # type: ignore[attr-defined]


def _valid_payload(event: str) -> dict[str, object]:
    return {name: _one_valid_value(spec) for name, spec in CATALOGUE[event].items()}


class TestNothingIdentifyingCanBeSent:
    def test_no_event_declares_an_identifying_property(self) -> None:
        """The rule, stated against the catalogue rather than against a payload.

        A property added under one of these names would pass every other test
        in this file, because the machinery would happily carry it. This is
        the one that says it may not exist at all.
        """
        offenders = {
            f"{event}.{name}"
            for event, spec in CATALOGUE.items()
            for name in spec
            if name in FORBIDDEN_PROPERTIES
        }
        assert not offenders, (
            f"{sorted(offenders)} name something inside a deployment. Telemetry "
            "reports counts and durations only — see docs/old/telemetry-events.md. "
            "If a new property genuinely needs to identify something, that is a "
            "decision for the InfoSec review, not for this file."
        )

    @pytest.mark.parametrize("event", sorted(CATALOGUE))
    def test_an_identifier_smuggled_alongside_valid_properties_is_refused(
        self, event: str
    ) -> None:
        """The Console's trick: a real payload with one extra field."""
        payload = _valid_payload(event)
        payload["room_name"] = "incident-response"
        with pytest.raises(TelemetryCatalogueError, match="does not declare"):
            validate(event, payload)  # type: ignore[arg-type]

    def test_an_undeclared_event_is_refused(self) -> None:
        with pytest.raises(TelemetryCatalogueError, match="not a telemetry event"):
            validate("room_secretly_inspected", {})


class TestThePropertySetIsExact:
    @pytest.mark.parametrize("event", sorted(CATALOGUE))
    def test_a_declared_payload_is_accepted(self, event: str) -> None:
        validate(event, _valid_payload(event))  # type: ignore[arg-type]

    @pytest.mark.parametrize(
        "event", sorted(event for event in CATALOGUE if CATALOGUE[event])
    )
    def test_a_missing_property_is_refused(self, event: str) -> None:
        """Every event of a name carries the same keys every time.

        Not a privacy rule but a charting one: a property that is sometimes
        absent cannot be grouped on, and the absence is invisible in the tool.
        """
        payload = _valid_payload(event)
        payload.pop(sorted(payload)[0])
        with pytest.raises(TelemetryCatalogueError, match="is missing"):
            validate(event, payload)  # type: ignore[arg-type]


class TestValuesAreClosed:
    def test_a_value_outside_its_set_is_refused(self) -> None:
        payload = _valid_payload("bridge_connected")
        payload["bridge_platform"] = "irc"
        with pytest.raises(TelemetryCatalogueError, match="expected one of"):
            validate("bridge_connected", payload)  # type: ignore[arg-type]

    def test_free_text_where_a_set_belongs_is_refused(self) -> None:
        """The case that matters: an exception message reaching `failure_reason`."""
        payload = _valid_payload("bridge_connected")
        payload["failure_reason"] = "SlackApiError: invalid_auth for team acme-corp"
        with pytest.raises(TelemetryCatalogueError, match="expected one of"):
            validate("bridge_connected", payload)  # type: ignore[arg-type]

    def test_a_boolean_is_not_a_number(self) -> None:
        """`bool` subclasses `int`, so a count set to True would otherwise pass
        and be reported as 1."""
        payload = _valid_payload("usage_snapshot")
        payload["room_count"] = True
        with pytest.raises(TelemetryCatalogueError, match="expected a number"):
            validate("usage_snapshot", payload)  # type: ignore[arg-type]

    def test_a_number_is_not_a_string(self) -> None:
        payload = _valid_payload("usage_snapshot")
        payload["room_count"] = "lots"
        with pytest.raises(TelemetryCatalogueError, match="expected a number"):
            validate("usage_snapshot", payload)  # type: ignore[arg-type]

    def test_a_non_finite_count_is_refused(self) -> None:
        """A mean over zero rooms must not arrive as NaN."""
        payload = _valid_payload("usage_snapshot")
        payload["room_users_mean"] = float("nan")
        with pytest.raises(TelemetryCatalogueError, match="finite"):
            validate("usage_snapshot", payload)  # type: ignore[arg-type]


class TestNaming:
    def test_every_event_is_snake_case(self) -> None:
        offenders = [
            event
            for event in CATALOGUE
            if not event.replace("_", "").isalnum() or event != event.lower()
        ]
        assert not offenders

    def test_every_property_is_snake_case(self) -> None:
        offenders = [
            f"{event}.{name}"
            for event, spec in CATALOGUE.items()
            for name in spec
            if not name.replace("_", "").isalnum() or name != name.lower()
        ]
        assert not offenders

    def test_the_wire_name_is_prefixed_by_product(self) -> None:
        """One Amplitude project holds several products, so the prefix is what
        keeps `room_created` here apart from the Console's."""
        assert wire_name("room_created") == f"{EVENT_NAME_PREFIX}.room_created"
        assert EVENT_NAME_PREFIX == "switch_core"
