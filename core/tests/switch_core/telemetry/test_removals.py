"""Removals are reported, and carry what they were.

Without these, every count in the snapshot can fall with nothing to explain it:
a drop in `room_count` reads the same whether a customer tidied up, a bridge
was disconnected, or the deployment was abandoned. The lifespan is the part
that separates them — "deleted after an hour" and "deleted after a year" are
opposite signals.

The tests that matter here are the ones about *when* the data is gathered. Two
of these properties describe something that no longer exists by the time the
event is built, so they have to be read before the delete rather than after,
and a test that only checks the event fires would not notice.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from switch_core.telemetry.ages import UNKNOWN_AGE, age_days, age_hours
from switch_core.telemetry.catalogue import CATALOGUE, TelemetryCatalogueError, validate


class TestTheRemovalEventsExist:
    @pytest.mark.parametrize(
        "event",
        ["room_deleted", "agent_deleted", "connector_removed", "room_agents_removed"],
    )
    def test_each_removal_is_in_the_catalogue(self, event: str) -> None:
        assert event in CATALOGUE

    def test_room_deletion_carries_what_it_was(self) -> None:
        validate(
            "room_deleted",
            {
                "bridge_platform": "slack",
                "channel_type": "channel_public",
                "created_by_kind": "user",
                "age_days": 12.5,
                "was_ever_active": "true",
                "agent_count": 3,
            },
        )

    def test_room_deletion_reports_unknown_rather_than_a_guess(self) -> None:
        """A failed activity lookup is not evidence the room was never used —
        it must say so rather than reporting `false`."""
        validate(
            "room_deleted",
            {
                "bridge_platform": "unknown",
                "channel_type": "channel_public",
                "created_by_kind": "user",
                "age_days": 12.5,
                "was_ever_active": "unknown",
                "agent_count": 3,
            },
        )

    def test_was_ever_active_is_no_longer_a_boolean(self) -> None:
        """Locks in the tri-state: a bare `True`/`False` must be refused so a
        caller cannot silently smuggle a boolean back in."""
        payload = {
            "bridge_platform": "slack",
            "channel_type": "channel_public",
            "created_by_kind": "user",
            "age_days": 12.5,
            "was_ever_active": True,
            "agent_count": 3,
        }
        with pytest.raises(TelemetryCatalogueError, match="expected one of"):
            validate("room_deleted", payload)  # type: ignore[arg-type]

    def test_agent_deletion_carries_what_it_was(self) -> None:
        validate(
            "agent_deleted",
            {
                "known_agent_type": "codex",
                "age_days": 0.5,
                "room_count": 2,
                "had_parent": False,
            },
        )

    def test_connector_removal_says_whether_it_ever_worked(self) -> None:
        """A connector removed having never connected is a failed setup; one
        removed after months is a decision. Both are "removed"."""
        validate(
            "connector_removed",
            {
                "bridge_platform": "teams",
                "age_days": 90.0,
                "was_ever_connected": "false",
                "room_count": 0,
            },
        )

    def test_connector_removal_reports_unknown_rather_than_a_guess(self) -> None:
        """A failed read of the durable milestone record is not evidence the
        connector never connected — collapsing it into `false` would misfile a
        lookup failure as a failed setup."""
        validate(
            "connector_removed",
            {
                "bridge_platform": "teams",
                "age_days": 90.0,
                "was_ever_connected": "unknown",
                "room_count": 0,
            },
        )

    def test_a_removal_still_cannot_carry_a_name(self) -> None:
        with pytest.raises(TelemetryCatalogueError):
            validate(
                "room_deleted",
                {
                    "bridge_platform": "slack",
                    "channel_type": "channel_public",
                    "created_by_kind": "user",
                    "age_days": 1.0,
                    "was_ever_active": "true",
                    "agent_count": 1,
                    "room_name": "incident-response",
                },
            )


class TestRegistrationPathProducesEveryValue:
    """All four values are produced by real code paths, which is the point of
    having four. `gateway` rather than `console` because the desktop app and
    the browser dashboard authenticate identically against the same endpoint —
    a value that looked precise and was a guess is worse than a coarser one
    that is true."""

    def test_the_declared_set_is_what_the_code_produces(self) -> None:
        spec = CATALOGUE["agent_registered"]["registration_path"]
        assert spec.values == frozenset(  # type: ignore[attr-defined]
            {"bootstrap", "personal_key", "gateway", "other"}
        )

    @pytest.mark.parametrize("path", ["bootstrap", "personal_key", "gateway", "other"])
    def test_each_value_is_accepted(self, path: str) -> None:
        validate(
            "agent_registered",
            {
                "agent_type": "auto_session",
                "known_agent_type": "claude-code",
                "registration_path": path,
                "has_parent": False,
            },
        )

    def test_console_is_not_a_value(self) -> None:
        """It was, and it could never have been produced."""
        with pytest.raises(TelemetryCatalogueError, match="expected one of"):
            validate(
                "agent_registered",
                {
                    "agent_type": "always_on",
                    "known_agent_type": "none",
                    "registration_path": "console",
                    "has_parent": False,
                },
            )


class TestAutoSessionIsAnAgentType:
    """It is one of the four connection models, and the one Switch Console sets
    whenever a user ticks auto-session — so leaving it out dropped the
    registration event for exactly the population the Console serves."""

    @pytest.mark.parametrize(
        "agent_type",
        ["always_on", "session_addressable", "session_passive", "auto_session"],
    )
    def test_every_connection_model_is_accepted(self, agent_type: str) -> None:
        validate(
            "agent_registered",
            {
                "agent_type": agent_type,
                "known_agent_type": "claude-code",
                "registration_path": "gateway",
                "has_parent": False,
            },
        )

    def test_the_set_matches_the_protocol_types(self) -> None:
        """Pinned against the source of truth, so a fifth connection model
        added there fails here rather than being silently dropped at emission."""
        from switch_core.bridges.agent.protocol.types import IntegrationProfile

        declared = CATALOGUE["agent_registered"]["agent_type"].values  # type: ignore[attr-defined]
        annotation = IntegrationProfile.model_fields["connection_model"].annotation
        assert set(annotation.__args__) == set(declared)  # type: ignore[union-attr]


class TestAgeIsReportedInDays:
    """One implementation, tested once.

    There were eight copies of this arithmetic across the modules that emit a
    removal, and they disagreed on the only case that matters — half reported
    `0.0` for a timestamp they could not read and half reported `-1`. The
    duplication was the defect; a test per copy would only have pinned it.
    """

    def test_a_fresh_row_is_near_zero(self) -> None:
        assert 0 <= age_days(datetime.now(UTC)) < 0.01

    def test_an_old_row_reports_its_age(self) -> None:
        assert 9.9 < age_days(datetime.now(UTC) - timedelta(days=10)) < 10.1

    def test_hours_are_the_same_elapsed_time_in_a_different_unit(self) -> None:
        moment = datetime.now(UTC) - timedelta(days=1)
        assert 23.9 < age_hours(moment) < 24.1

    @pytest.mark.parametrize("unreadable", [None, "yesterday", 0, object()])
    def test_an_unreadable_timestamp_is_negative_rather_than_a_crash(
        self, unreadable: object
    ) -> None:
        """`-1` rather than `0`: "could not tell" must stay distinguishable
        from "created just now", per docs/old/telemetry-events.md. Pinning `0`
        here would have locked in the opposite — a lookup failure silently
        reporting as a genuine, very fresh row."""
        assert age_days(unreadable) == UNKNOWN_AGE
        assert age_hours(unreadable) == UNKNOWN_AGE

    def test_a_clock_stepped_backwards_does_not_look_like_unknown(self) -> None:
        """The wall clock is unavoidable here — these ages span restarts — so a
        row stamped in the future must clamp to zero rather than going negative
        and colliding with the sentinel."""
        assert age_days(datetime.now(UTC) + timedelta(days=1)) == 0.0
