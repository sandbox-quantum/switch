"""Hosted alerts: the decisions and the words, with no database.

What matters most is what an alert can never carry. A canary goes in every
text field a status summary, an observation and a cluster report have, and is
looked for in every verdict, title and detail.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from switch_core.gateway.hosted_controller import Observation
from switch_core.observability.hosted import MachineRow
from switch_core.visibility.alerts import (
    CLUSTER_REPORT_TARGET,
    DETAIL,
    Condition,
    Verdict,
    _valid_target,
    alert_title,
    box_verdicts,
    cluster_report_verdict,
    cluster_verdicts,
    turn_off_target,
)
from switch_core.visibility.box_facts import MAX_TIMES, with_box_facts
from switch_core.visibility.cluster_report import ClusterReport, HeldReport
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
CANARY = "CANARY-5a1e-do-not-alert"
KEY = KeyedIdKey(b"k" * 32, "k1")
MACHINE = "6f1c2a9e-0000-4000-8000-00000000abcd"


def _ago(**delta: float) -> str:
    return (NOW - timedelta(**delta)).isoformat()


def _row(
    *,
    state: str = "ready",
    desired: str = "running",
    evictions: list[str] | None = None,
    restarts: list[str] | None = None,
    valve: str | None = None,
    reported: str | None = None,
) -> MachineRow:
    return MachineRow(
        id=MACHINE,
        state=state,
        desired_state=desired,
        heartbeat={
            "box": {
                "node": "ip-10-0-1-7",
                "restart_times": restarts or [],
                "eviction_times": evictions or [],
                CANARY: CANARY,
            },
            "controllers": {
                "w1": {
                    "at": reported or _ago(seconds=30),
                    "metrics": {"valve_memory": valve, "detail": CANARY},
                }
            },
            "memory_note": CANARY,
        },
        heartbeat_at=NOW,
    )


def _by(verdicts: list[Verdict]) -> dict[Condition, Verdict]:
    return {v.condition: v for v in verdicts}


class TestBoxVerdicts:
    def test_a_box_is_named_by_its_keyed_id_only(self) -> None:
        verdicts = box_verdicts([_row()], KEY, NOW)
        expected = KEY.keyed_id(KeyedIdKind.BOX, MACHINE)
        assert {v.target_id for v in verdicts} == {expected}
        assert MACHINE not in json.dumps([v.target_id for v in verdicts])

    def test_an_eviction_raises_and_clears_itself_after_30_minutes(self) -> None:
        assert _by(box_verdicts([_row(evictions=[_ago(minutes=2)])], KEY, NOW))[
            Condition.BOX_EVICTED
        ].true_now
        assert not _by(box_verdicts([_row(evictions=[_ago(minutes=31)])], KEY, NOW))[
            Condition.BOX_EVICTED
        ].true_now

    def test_three_restarts_in_an_hour_raise_and_two_do_not(self) -> None:
        three = [_ago(minutes=5), _ago(minutes=20), _ago(minutes=59)]
        verdict = _by(box_verdicts([_row(restarts=three)], KEY, NOW))[
            Condition.BOX_RESTARTS
        ]
        assert verdict.true_now and verdict.figure == 3
        two_and_old = [_ago(minutes=5), _ago(minutes=20), _ago(minutes=61)]
        assert not _by(box_verdicts([_row(restarts=two_and_old)], KEY, NOW))[
            Condition.BOX_RESTARTS
        ].true_now

    @pytest.mark.parametrize("valve", ["unprotected", "failing"])
    def test_a_valve_that_cant_read_memory_raises(self, valve: str) -> None:
        assert _by(box_verdicts([_row(valve=valve)], KEY, NOW))[
            Condition.BOX_MEMORY_UNREADABLE
        ].true_now

    def test_a_stale_summary_or_a_good_valve_does_not(self) -> None:
        stale = _row(valve="failing", reported=_ago(minutes=4))
        assert not _by(box_verdicts([stale], KEY, NOW))[
            Condition.BOX_MEMORY_UNREADABLE
        ].true_now
        assert not _by(box_verdicts([_row(valve=None)], KEY, NOW))[
            Condition.BOX_MEMORY_UNREADABLE
        ].true_now

    def test_a_box_not_meant_to_run_clears_its_restart_and_memory_alerts(self) -> None:
        three = [_ago(minutes=5), _ago(minutes=6), _ago(minutes=7)]
        stopped = _row(
            state="stopped", desired="stopped", restarts=three, valve="failing"
        )
        verdicts = _by(box_verdicts([stopped], KEY, NOW))
        assert not verdicts[Condition.BOX_RESTARTS].true_now
        assert not verdicts[Condition.BOX_MEMORY_UNREADABLE].true_now

    def test_junk_in_the_heartbeat_is_ignored(self) -> None:
        row = MachineRow(
            id=MACHINE,
            state="ready",
            desired_state="running",
            heartbeat={
                "box": {"restart_times": [CANARY, 7, None]},
                "controllers": CANARY,
            },
            heartbeat_at=NOW,
        )
        assert not any(v.true_now for v in box_verdicts([row], KEY, NOW))


def _report(**overrides: object) -> ClusterReport:
    body: dict[str, object] = {
        "nodes": [
            {
                "name": "ip-10-0-1-7",
                "zone": "eu-west-2a",
                "memory_used_pct": 50.0,
                "memory_booked_pct": 84.0,
                "gate": "passed",
                "held_minutes": 0,
            }
        ],
        "services": [{"name": "coredns", "ready": 2, "wanted": 2, "short_seconds": 0}],
    }
    body.update(overrides)
    return ClusterReport.model_validate(body)


def _node(**fields: object) -> dict[str, object]:
    return {
        "name": "ip-10-0-1-7",
        "zone": "eu-west-2a",
        "memory_used_pct": 50.0,
        "memory_booked_pct": 84.0,
        "gate": "passed",
        "held_minutes": 0,
        **fields,
    }


class TestClusterVerdicts:
    def test_a_quiet_cluster_raises_nothing(self) -> None:
        assert not any(v.true_now for v in cluster_verdicts(_report()))

    def test_safety_check_at_10_minutes(self) -> None:
        held = _by(
            cluster_verdicts(_report(nodes=[_node(gate="held", held_minutes=10)]))
        )
        assert held[Condition.SAFETY_CHECK].true_now
        early = _by(
            cluster_verdicts(_report(nodes=[_node(gate="held", held_minutes=9)]))
        )
        assert not early[Condition.SAFETY_CHECK].true_now

    def test_used_memory_above_85_or_unreadable(self) -> None:
        def memory(pct: float | None) -> Verdict:
            return _by(cluster_verdicts(_report(nodes=[_node(memory_used_pct=pct)])))[
                Condition.MACHINE_MEMORY
            ]

        assert memory(85.1).true_now
        assert not memory(85.0).true_now
        unreadable = memory(None)
        assert unreadable.true_now and unreadable.figure is None
        # Booked memory never decides it.
        assert not _by(
            cluster_verdicts(
                _report(nodes=[_node(memory_booked_pct=100.0, memory_used_pct=40.0)])
            )
        )[Condition.MACHINE_MEMORY].true_now

    def test_a_service_short_for_2_minutes(self) -> None:
        def short(ready: int, wanted: int, seconds: int) -> bool:
            return _by(
                cluster_verdicts(
                    _report(
                        services=[
                            {
                                "name": "coredns",
                                "ready": ready,
                                "wanted": wanted,
                                "short_seconds": seconds,
                            }
                        ]
                    )
                )
            )[Condition.SERVICE_SHORT].true_now

        assert short(1, 2, 120)
        assert not short(1, 2, 119)
        assert not short(2, 2, 600)

    def test_the_report_refuses_extra_fields_and_bad_values(self) -> None:
        with pytest.raises(ValidationError):
            _report(nodes=[_node(note=CANARY)])
        with pytest.raises(ValidationError):
            _report(nodes=[_node(name=f"bad name {CANARY}")])
        with pytest.raises(ValidationError):
            _report(nodes=[_node(memory_used_pct=101)])
        with pytest.raises(ValidationError):
            _report(
                services=[
                    {"name": "coredns", "ready": 1, "wanted": 2, "short_seconds": -1}
                ]
            )


class TestLateReport:
    def test_late_after_3_minutes(self) -> None:
        held = HeldReport(report=_report(), received_at=NOW - timedelta(minutes=4))
        assert cluster_report_verdict(held, NOW, NOW - timedelta(hours=1)).true_now
        fresh = HeldReport(report=_report(), received_at=NOW - timedelta(minutes=2))
        assert not cluster_report_verdict(fresh, NOW, NOW - timedelta(hours=1)).true_now

    def test_before_any_report_it_counts_from_when_it_started_waiting(self) -> None:
        assert not cluster_report_verdict(
            None, NOW, NOW - timedelta(minutes=2)
        ).true_now
        assert cluster_report_verdict(None, NOW, NOW - timedelta(minutes=4)).true_now


class TestWords:
    @pytest.mark.parametrize("condition", list(Condition))
    def test_every_title_is_fixed_text_with_an_id_and_a_number(
        self, condition: Condition
    ) -> None:
        target = {
            Condition.BOX_EVICTED: KEY.keyed_id(KeyedIdKind.BOX, MACHINE),
            Condition.BOX_RESTARTS: KEY.keyed_id(KeyedIdKind.BOX, MACHINE),
            Condition.BOX_MEMORY_UNREADABLE: KEY.keyed_id(KeyedIdKind.BOX, MACHINE),
            Condition.SAFETY_CHECK: "ip-10-0-1-7",
            Condition.MACHINE_MEMORY: "ip-10-0-1-7",
            Condition.SERVICE_SHORT: "coredns",
            Condition.CLUSTER_REPORT_LATE: CLUSTER_REPORT_TARGET,
            Condition.PAUSE_FAILED: KEY.keyed_id(KeyedIdKind.USER, "user-1"),
            Condition.BOX_CAP_REACHED: "rate",
            Condition.OPERATOR_BULK_ACTIONS: KEY.keyed_id(
                KeyedIdKind.USER, "operator-1"
            ),
            Condition.TURN_OFF_FAILED: turn_off_target(
                KEY.keyed_id(KeyedIdKind.USER, "user-1"),
                KEY.keyed_id(KeyedIdKind.WORKSPACE, "workspace-1"),
            ),
        }[condition]
        title = alert_title(condition, target, 4)
        assert "\n" not in title and "@" not in title
        assert DETAIL[condition] and "\n" not in DETAIL[condition]
        assert _valid_target(condition, target)

    def test_targets_that_fail_their_pattern_are_refused(self) -> None:
        assert not _valid_target(Condition.BOX_EVICTED, MACHINE)
        assert not _valid_target(Condition.SAFETY_CHECK, f"@here {CANARY}")
        assert not _valid_target(Condition.SERVICE_SHORT, "postgres")
        assert not _valid_target(Condition.CLUSTER_REPORT_LATE, CANARY)
        user = KEY.keyed_id(KeyedIdKind.USER, "user-1")
        workspace = KEY.keyed_id(KeyedIdKind.WORKSPACE, "workspace-1")
        assert _valid_target(
            Condition.TURN_OFF_FAILED, turn_off_target(user, workspace)
        )
        assert not _valid_target(Condition.TURN_OFF_FAILED, user)
        assert not _valid_target(Condition.TURN_OFF_FAILED, f"{user}:{CANARY}")
        assert not _valid_target(Condition.TURN_OFF_FAILED, f"{user}:raw-workspace-id")

    def test_a_turn_off_title_names_the_person_and_workspace_by_keyed_id(self) -> None:
        user = KEY.keyed_id(KeyedIdKind.USER, "user-1")
        workspace = KEY.keyed_id(KeyedIdKind.WORKSPACE, "workspace-1")
        title = alert_title(
            Condition.TURN_OFF_FAILED, turn_off_target(user, workspace), None
        )
        assert title == (
            f"Turning off user `{user}` in workspace `{workspace}` "
            "still hasn't finished after 2 minutes"
        )

    def test_no_canary_reaches_a_verdict(self) -> None:
        verdicts = box_verdicts([_row(valve="failing")], KEY, NOW) + cluster_verdicts(
            _report()
        )
        assert CANARY not in json.dumps([v.__dict__ for v in verdicts], default=str)


class TestBoxFacts:
    def test_merges_counts_into_times_and_keeps_other_keys(self) -> None:
        heartbeat = {"disk": {"total_bytes": 1}, "controllers": {"w1": {}}}
        out = with_box_facts(
            heartbeat, node="ip-10-0-1-7", restarts=2, evictions=1, now=NOW
        )
        assert out["disk"] == {"total_bytes": 1} and "controllers" in out
        assert out["box"]["node"] == "ip-10-0-1-7"
        assert out["box"]["restarts_today"] == 2
        assert len(out["box"]["restart_times"]) == 2
        assert len(out["box"]["eviction_times"]) == 1
        assert "box" not in heartbeat  # a new dict, so the JSON column sees the change

    def test_old_times_drop_out_and_the_lists_are_capped(self) -> None:
        old = with_box_facts(
            None, node=None, restarts=3, evictions=0, now=NOW - timedelta(hours=2)
        )
        out = with_box_facts(
            old, node=None, restarts=MAX_TIMES + 10, evictions=0, now=NOW
        )
        assert len(out["box"]["restart_times"]) == MAX_TIMES
        assert all(t == NOW.isoformat() for t in out["box"]["restart_times"])

    def test_restarts_today_starts_again_each_utc_day(self) -> None:
        yesterday = with_box_facts(
            None, node=None, restarts=5, evictions=0, now=NOW - timedelta(days=1)
        )
        assert (
            with_box_facts(yesterday, node=None, restarts=1, evictions=0, now=NOW)[
                "box"
            ]["restarts_today"]
            == 1
        )

    # v2's fields: with v2 off, upstream's model decides.
    @pytest.mark.usefixtures("hosted_v2_on")
    def test_the_observation_checks_node_and_restarts(self) -> None:
        ok = Observation(state="running", revision=1, node="ip-10-0-1-7", restarts=2)
        assert ok.node == "ip-10-0-1-7"
        for bad in (
            {"node": f"Bad {CANARY}"},
            {"restarts": -1},
            {"restarts": 1_000_001},
        ):
            with pytest.raises(ValidationError):
                Observation(state="running", revision=1, **bad)


class TestActionHook:
    """The pause and turn-off `HostedAccess.alert` hook, mapped to A8 and A9."""

    async def test_pause_and_turn_off_map_to_a8_and_a9(self, monkeypatch) -> None:
        from switch_core.visibility import alerts

        seen: list[Verdict] = []

        async def fake_apply(_factory, verdict, now=None):
            seen.append(verdict)
            return "raised"

        monkeypatch.setattr(alerts, "apply_alert", fake_apply)
        hook = alerts.action_alert(None)  # type: ignore[arg-type]
        user = KEY.keyed_id(KeyedIdKind.USER, "user-1")
        workspace = KEY.keyed_id(KeyedIdKind.WORKSPACE, "workspace-1")
        await hook("pause", user, None, True)
        await hook("turn_off", user, workspace, False)
        await hook("turn_off", user, None, True)  # no workspace: nothing written
        await hook("something_else", user, workspace, True)
        assert seen == [
            Verdict(Condition.PAUSE_FAILED, user, True),
            Verdict(Condition.TURN_OFF_FAILED, turn_off_target(user, workspace), False),
        ]


def test_the_open_alerts_query_names_the_condition_the_same_way_twice() -> None:
    """Postgres refuses DISTINCT ON unless it matches the leading ORDER BY
    exactly. A bound key would compile to two different parameters (an
    integration run caught that), so the key must be written inline in both places."""
    from sqlalchemy.dialects.postgresql import asyncpg

    from switch_core.db.models import ServerAuditEvent
    from switch_core.visibility import alerts

    query = (
        alerts._alert_rows(list(Condition))
        .distinct(
            alerts._CONDITION, ServerAuditEvent.target_type, ServerAuditEvent.target_id
        )
        .order_by(
            alerts._CONDITION, ServerAuditEvent.target_type, ServerAuditEvent.target_id
        )
    )
    sql = str(query.compile(dialect=asyncpg.dialect()))
    key = "server_audit_events.details ->> 'condition'"
    assert f"DISTINCT ON ({key}," in sql
    assert f"ORDER BY {key}," in sql


class TestCapAlert:
    """A10, raised and cleared by box provisioning."""

    def test_its_targets_are_the_two_caps_only(self) -> None:
        assert _valid_target(Condition.BOX_CAP_REACHED, "rate")
        assert _valid_target(Condition.BOX_CAP_REACHED, "ceiling")
        assert not _valid_target(Condition.BOX_CAP_REACHED, CANARY)
        assert not _valid_target(Condition.BOX_CAP_REACHED, "k1-0123456789abcdef")

    def test_titles(self) -> None:
        assert alert_title(Condition.BOX_CAP_REACHED, "rate", 5) == (
            "New boxes are waiting: the per-minute provisioning cap of 5 was reached"
        )
        assert alert_title(Condition.BOX_CAP_REACHED, "ceiling", 50) == (
            "New boxes are waiting: the total provisioning cap of 50 was reached"
        )


class TestBulkAlert:
    """A11, raised and cleared by the operator rate limit."""

    def test_its_target_is_an_operators_keyed_id(self) -> None:
        operator = KEY.keyed_id(KeyedIdKind.USER, "operator-1")
        assert _valid_target(Condition.OPERATOR_BULK_ACTIONS, operator)
        assert not _valid_target(Condition.OPERATOR_BULK_ACTIONS, "operator-1")
        assert not _valid_target(Condition.OPERATOR_BULK_ACTIONS, CANARY)

    def test_title(self) -> None:
        operator = KEY.keyed_id(KeyedIdKind.USER, "operator-1")
        assert alert_title(Condition.OPERATOR_BULK_ACTIONS, operator, 6) == (
            f"Operator `{operator}` made 6 actions in the last 10 minutes"
        )
