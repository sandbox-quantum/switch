"""Which changes an agent asks for wait for its owner, and how they wait.

The decisions are pure: what an agent asked to change, against what the
agent it changes has now. The flows (holding, posting, confirming) are
covered through the operations and the command, against Postgres, in
`management/test_agent_operations.py`.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.addressing import (
    ANY,
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.bridges.agent.agent_change_requests import (
    addressing_widens,
    bypass_fields,
    changed_fields,
    confirm_with,
    fields_to_confirm,
    new_agent_fields_to_confirm,
)
from switch_core.bridges.agent.protocol.agent_management import (
    CheckedPlacement,
    ManagedAgentChanges,
    NewManagedAgent,
)
from switch_core.clients import agent_admin
from switch_core.clients.agent_admin import (
    AgentRequests,
    ChangeAlreadyWaiting,
    ChangeRequest,
)

CURRENT: dict[str, Any] = {
    "provider": "claude",
    "model": None,
    "auto_mode": True,
    "auto_approve": False,
    "directory": "/work/agents/builder",
    "machine": {"id": "m-1", "name": "laptop", "state": "online"},
}


def _changes(**given: Any) -> ManagedAgentChanges:
    fields = {
        "provider": None,
        "model": None,
        "advanced_config": None,
        "instructions": None,
        "auto_mode": None,
        "auto_approve": None,
        "directory": None,
        "isolation": None,
        "machine": None,
        "desired_state": None,
    }
    return ManagedAgentChanges(**{**fields, **given})


def _spec(**given: Any) -> NewManagedAgent:
    fields: dict[str, Any] = {
        "name": "builder",
        "description": "Builds",
        "display_name": None,
        "icon_url": None,
        "machine": "laptop",
        "provider": "claude",
        "model": None,
        "advanced_config": {},
        "instructions": "",
        "directory": None,
        "auto_mode": True,
        "auto_approve": False,
        "isolation": "shared",
        "start": True,
    }
    return NewManagedAgent(**{**fields, **given})


PLACEMENT = CheckedPlacement(
    machine_id="m-1", machine_name="laptop", workspaces_dir="/work/agents/"
)


class TestWhatWaitsForTheOwner:
    @pytest.mark.parametrize(
        ("given", "held"),
        [
            ({"auto_approve": True}, ("auto_approve",)),
            ({"directory": "/home/ada/.ssh"}, ("directory",)),
            ({"machine": "desktop"}, ("machine",)),
            ({"provider": "codex", "model": ""}, ("provider",)),
            (
                {"auto_approve": True, "directory": "/srv", "desired_state": "running"},
                ("auto_approve", "directory"),
            ),
            (
                {"advanced_config": {"permissionMode": "bypassPermissions"}},
                ("advanced_config",),
            ),
        ],
    )
    def test_a_change_to_what_it_may_do_alone_waits(
        self, given: dict[str, Any], held: tuple[str, ...]
    ) -> None:
        assert fields_to_confirm(_changes(**given), CURRENT) == held

    @pytest.mark.parametrize(
        "given",
        [
            {"model": "opus"},
            {"instructions": "Be careful."},
            {"advanced_config": {"effort": "high"}},
            {"advanced_config": {}},
            # The safer direction.
            {"auto_mode": False},
            {"auto_approve": False},
            {"advanced_config": {"permissionMode": "plan"}},
            {"advanced_config": {"permissionMode": "acceptEdits"}},
            {"desired_state": "stopped"},
            {"isolation": "isolated"},
            # Values it already has are no change.
            {"auto_approve": False, "auto_mode": True, "provider": "claude"},
            {"machine": "laptop"},
            {"machine": "m-1"},
            {"directory": "/work/agents/builder"},
            # Back to the machine's own workspace for it.
            {"directory": ""},
        ],
    )
    def test_anything_else_applies_at_once(self, given: dict[str, Any]) -> None:
        assert fields_to_confirm(_changes(**given), CURRENT) == ()

    def test_turning_auto_mode_on_waits(self) -> None:
        manual = {**CURRENT, "auto_mode": False}

        assert fields_to_confirm(_changes(auto_mode=True), manual) == ("auto_mode",)

    @pytest.mark.parametrize("now", [None, "default", "acceptEdits", "plan", "dontAsk"])
    def test_the_providers_own_auto_mode_waits_as_auto_mode_does(
        self, now: str | None
    ) -> None:
        current = {
            **CURRENT,
            "advanced_config": {} if now is None else {"permissionMode": now},
        }

        assert fields_to_confirm(
            _changes(advanced_config={"permissionMode": "auto", "effort": "high"}),
            current,
        ) == ("advanced_config",)

    @pytest.mark.parametrize(
        ("now", "then"),
        [
            # Already auto: no change.
            ("auto", {"permissionMode": "auto", "effort": "high"}),
            # Turning it off, to any other mode or to none.
            ("auto", {"permissionMode": "default"}),
            ("auto", {"permissionMode": "acceptEdits"}),
            ("auto", {}),
            # Narrower than the bypass it has.
            ("bypassPermissions", {"permissionMode": "auto"}),
        ],
    )
    def test_the_providers_own_auto_mode_off_or_kept_applies_at_once(
        self, now: str, then: dict[str, Any]
    ) -> None:
        current = {**CURRENT, "advanced_config": {"permissionMode": now}}

        assert fields_to_confirm(_changes(advanced_config=then), current) == ()

    def test_turning_bypass_off_does_not_wait(self) -> None:
        bypassing = {
            **CURRENT,
            "auto_approve": True,
            "advanced_config": {"permissionMode": "bypassPermissions"},
        }

        assert (
            fields_to_confirm(
                _changes(auto_approve=False, advanced_config={}), bypassing
            )
            == ()
        )

    @pytest.mark.parametrize(
        "bypassing",
        [
            {"auto_approve": True},
            {"advanced_config": {"permissionMode": "bypassPermissions"}},
        ],
    )
    def test_new_instructions_for_an_agent_with_bypass_wait(
        self, bypassing: dict[str, Any]
    ) -> None:
        """What an agent with no permission checks is told to do, it does
        with nobody asked."""
        current = {**CURRENT, **bypassing}

        assert fields_to_confirm(_changes(instructions="Do it."), current) == (
            "instructions",
        )
        assert fields_to_confirm(
            _changes(instructions="Do it.", model="opus"), current
        ) == ("instructions",)

    @pytest.mark.parametrize(
        ("given", "held"),
        [
            ({"auto_approve": True}, ("auto_approve", "instructions")),
            (
                {"advanced_config": {"permissionMode": "bypassPermissions"}},
                ("advanced_config", "instructions"),
            ),
        ],
    )
    def test_new_instructions_that_come_with_bypass_wait_for_both(
        self, given: dict[str, Any], held: tuple[str, ...]
    ) -> None:
        assert fields_to_confirm(_changes(instructions="Do it.", **given), CURRENT) == (
            held
        )

    def test_new_instructions_that_come_with_bypass_off_apply_at_once(self) -> None:
        """They land with the agent asking again, so they steer nothing
        unchecked."""
        bypassing = {
            **CURRENT,
            "auto_approve": True,
            "advanced_config": {"permissionMode": "bypassPermissions"},
        }

        assert (
            fields_to_confirm(
                _changes(instructions="Do it.", auto_approve=False, advanced_config={}),
                bypassing,
            )
            == ()
        )
        # Bypass still on by the provider's own permission mode.
        assert fields_to_confirm(
            _changes(instructions="Do it.", auto_approve=False), bypassing
        ) == ("instructions",)

    def test_placing_an_unplaced_agent_waits(self) -> None:
        unplaced = {**CURRENT, "machine": None}

        assert fields_to_confirm(_changes(machine="laptop"), unplaced) == ("machine",)

    def test_every_field_a_change_sets_is_named(self) -> None:
        changes = _changes(model="opus", auto_approve=True, machine="d", directory="")

        assert changed_fields(changes) == (
            "model",
            "auto_approve",
            "directory",
            "machine",
        )


class TestWhatANewAgentWaitsFor:
    def test_an_ordinary_agent_does_not_wait(self) -> None:
        assert new_agent_fields_to_confirm(_spec(), PLACEMENT) == ()

    def test_bypass_waits(self) -> None:
        assert new_agent_fields_to_confirm(_spec(auto_approve=True), PLACEMENT) == (
            "auto_approve",
        )

    def test_a_bypass_permission_mode_waits(self) -> None:
        spec = _spec(advanced_config={"permissionMode": "bypassPermissions"})

        assert new_agent_fields_to_confirm(spec, PLACEMENT) == ("advanced_config",)
        for safer in ({"effort": "high"}, {"permissionMode": "acceptEdits"}):
            assert (
                new_agent_fields_to_confirm(_spec(advanced_config=safer), PLACEMENT)
                == ()
            )

    @pytest.mark.parametrize("auto_mode", [True, False])
    def test_the_providers_own_auto_mode_waits_no_more_than_auto_mode(
        self, auto_mode: bool
    ) -> None:
        """A new agent is made in auto mode unless it says otherwise, so
        neither auto mode nor the provider's own waits when one is made."""
        spec = _spec(auto_mode=auto_mode, advanced_config={"permissionMode": "auto"})

        assert new_agent_fields_to_confirm(spec, PLACEMENT) == ()

    def test_bypass_is_either_way_of_skipping_every_check(self) -> None:
        """What an agent's template run is refused, as `create_agent` holds."""
        assert bypass_fields(True, {"permissionMode": "bypassPermissions"}) == (
            "auto_approve",
            "advanced_config",
        )
        assert bypass_fields(False, {"permissionMode": "auto"}) == ()


OWNER_ONLY = owner_only_policy([]).model_dump()
OWNER_AND_AGENTS = owner_and_owner_agents_policy().model_dump()


class TestWhoMayAddressIt:
    @pytest.mark.parametrize(
        ("current", "choice", "widens"),
        [
            (OWNER_ONLY, "anyone", True),
            (OWNER_ONLY, "owner_and_owner_agents", True),
            (OWNER_ONLY, "owner_only", False),
            (OWNER_AND_AGENTS, "anyone", True),
            (OWNER_AND_AGENTS, "owner_and_owner_agents", False),
            (OWNER_AND_AGENTS, "owner_only", False),
            # Open already: nothing is wider.
            (None, "anyone", False),
            (None, "owner_and_owner_agents", False),
            (None, "owner_only", False),
        ],
    )
    def test_only_a_wider_choice_waits(
        self, current: dict[str, Any] | None, choice: str, widens: bool
    ) -> None:
        assert addressing_widens(current, choice) is widens

    def test_owner_agents_in_one_room_are_widened_to_everywhere(self) -> None:
        one_room = AddressingPolicy(
            rules=[
                AddressingRule(
                    rooms=["room-1"], users=[], agents=[], owner=True, owner_agents=True
                )
            ]
        ).model_dump()

        assert addressing_widens(one_room, "owner_and_owner_agents") is True

    def test_a_policy_admitting_every_agent_is_narrowed_to_the_owners(self) -> None:
        all_agents = AddressingPolicy(
            rules=[AddressingRule(rooms=ANY, users=[], agents=ANY)]
        ).model_dump()

        assert addressing_widens(all_agents, "owner_and_owner_agents") is False
        assert addressing_widens(all_agents, "anyone") is True


def _request(name: str = "builder", by: str = "triage") -> ChangeRequest:
    async def apply() -> None:
        return None

    return ChangeRequest(
        requested_by_id=f"{by}-id",
        requested_by=by,
        owner_id="ada",
        agent_name=name,
        agent_id=f"{name}-id",
        fields=("auto_approve",),
        summary=("bypass mode on",),
        apply=apply,
    )


class TestHeldChanges:
    def test_one_waits_per_agent_and_room_until_taken(self) -> None:
        requests = AgentRequests()
        held = _request()

        requests.hold_change("room-1", held)

        assert requests.waiting_change("room-1", "Builder") is held
        assert requests.waiting_change("room-2", "builder") is None
        assert requests.take_change("room-1", "builder") is held
        assert requests.take_change("room-1", "builder") is None

    def test_a_second_ask_for_the_same_agent_is_refused_while_one_waits(self) -> None:
        """So what the owner confirms is what they were shown."""
        requests = AgentRequests()
        first = _request(by="triage")
        requests.hold_change("room-1", first)

        with pytest.raises(ChangeAlreadyWaiting, match="triage asked for"):
            requests.hold_change("room-1", _request(by="mallory"))
        assert requests.waiting_change("room-1", "builder") is first

    def test_it_lapses(self, monkeypatch: pytest.MonkeyPatch) -> None:
        requests = AgentRequests()
        now = [1000.0]
        monkeypatch.setattr(agent_admin.time, "monotonic", lambda: now[0])
        requests.hold_change("room-1", _request())

        now[0] += agent_admin.CONFIRM_SECONDS

        assert requests.take_change("room-1", "builder") is None
        requests.hold_change("room-1", _request(by="someone-else"))

    def test_the_command_names_the_agent(self) -> None:
        assert confirm_with("builder") == "!agent-change builder confirm"
