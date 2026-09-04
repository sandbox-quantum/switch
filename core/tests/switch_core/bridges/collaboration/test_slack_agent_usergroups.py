"""Per-agent Slack user groups — the handle that makes an agent name complete.

An agent is not a Slack user, so Slack's `@` menu cannot offer it. Minting a
user group per agent is what puts the name in that menu; these tests cover the
round trip (group id in, agent name out), the lifecycle, and the refusals that
must stay loud rather than leaving an agent silently unmentionable.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from slack_sdk.errors import SlackApiError

from switch_core.bridges.collaboration.slack.adapter import (
    SlackAdapter,
    SlackConnectionConfig,
)
from switch_core.bridges.collaboration.slack.agent_groups import (
    SlackAgentGroupDirectory,
)


@pytest.fixture(autouse=True)
def _fresh_group_directory() -> Any:
    """Every Slack bridge in a process shares one directory, so give each test
    its own rather than letting one test's workspaces answer another's."""
    original = SlackAdapter.agent_group_directory
    SlackAdapter.agent_group_directory = SlackAgentGroupDirectory()
    yield
    SlackAdapter.agent_group_directory = original


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class FakeResponse(dict):
    """Stands in for a slack_sdk response, which is dict-like."""


class FakeWebClient:
    def __init__(self, groups: list[dict[str, Any]] | None = None) -> None:
        self.groups = groups or []
        self.created: list[dict[str, Any]] = []
        self.disabled: list[str] = []
        self.enabled: list[str] = []
        self.list_calls = 0
        self.create_error: str | None = None
        self.list_error: str | None = None
        # Clear create_error after this many failures, to model a transient
        # condition (throttling) rather than a permanent one.
        self.clear_error_after: int | None = None
        self.create_attempts = 0
        self.updated: list[tuple[str, str]] = []
        self.update_error: str | None = None

    async def usergroups_list(self, **kwargs: Any) -> FakeResponse:
        self.list_calls += 1
        if self.list_error:
            raise SlackApiError("list failed", FakeResponse({"error": self.list_error}))
        return FakeResponse({"usergroups": self.groups})

    async def usergroups_create(self, **kwargs: Any) -> FakeResponse:
        self.create_attempts += 1
        if (
            self.clear_error_after is not None
            and self.create_attempts > self.clear_error_after
        ):
            self.create_error = None
        if self.create_error:
            raise SlackApiError(
                "create failed", FakeResponse({"error": self.create_error})
            )
        self.created.append(kwargs)
        group = {
            "id": f"S{len(self.created):03d}",
            "name": kwargs["name"],
            "handle": kwargs["handle"],
            "description": kwargs["description"],
        }
        self.groups.append(group)
        return FakeResponse({"usergroup": group})

    async def usergroups_disable(self, *, usergroup: str) -> FakeResponse:
        self.disabled.append(usergroup)
        return FakeResponse({"ok": True})

    async def usergroups_enable(self, *, usergroup: str) -> FakeResponse:
        self.enabled.append(usergroup)
        return FakeResponse({"ok": True})

    async def usergroups_update(
        self, *, usergroup: str, description: str
    ) -> FakeResponse:
        if self.update_error:
            raise SlackApiError(
                "update failed", FakeResponse({"error": self.update_error})
            )
        self.updated.append((usergroup, description))
        return FakeResponse({"ok": True})


def _adapter(
    *,
    enabled: bool = True,
    groups: list[dict[str, Any]] | None = None,
    team_id: str = "T123",
) -> tuple[SlackAdapter, FakeWebClient]:
    adapter = SlackAdapter(
        config=SlackConnectionConfig(
            bot_token="xoxb-test",
            app_token="xapp-test",
            workspace_id="T123",
            agent_usergroups=enabled,
        )
    )
    # Normally set from auth.test; the shared directory keys contributions on
    # it, so two adapters in one test must not look like the same workspace.
    adapter._team_id = team_id
    client = FakeWebClient(groups)
    adapter._web_client = client  # type: ignore[assignment]
    return adapter, client


def _agent_group(group_id: str, name: str, *, disabled: bool = False) -> dict[str, Any]:
    group = {
        "id": group_id,
        "name": name,
        "handle": name.lower(),
        "description": f"Switch agent — {name} does things",
    }
    if disabled:
        group["date_delete"] = 1700000000
    return group


# ── Provisioning ─────────────────────────────────────────────────────────────


def test_creates_a_group_for_a_new_agent() -> None:
    adapter, client = _adapter()

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert len(client.created) == 1
    created = client.created[0]
    assert created["name"] == "flint-tracker"
    assert created["handle"] == "flint-tracker"
    assert created["description"].startswith("Switch agent — ")


def test_does_nothing_when_the_feature_is_off() -> None:
    adapter, client = _adapter(enabled=False)

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert client.created == []
    assert client.list_calls == 0


def test_provisioning_is_idempotent_for_an_existing_agent() -> None:
    adapter, client = _adapter(groups=[_agent_group("S001", "flint-tracker")])

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert client.created == []


def test_readding_an_agent_reenables_its_disabled_group() -> None:
    """Slack has no delete for user groups, so a removed agent's group is only
    disabled. Re-adding it must revive that group rather than collide with it."""
    adapter, client = _adapter(
        groups=[_agent_group("S001", "flint-tracker", disabled=True)]
    )

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert client.enabled == ["S001"]
    assert client.created == []
    assert adapter._agent_group_ids["flint-tracker"] == "S001"


def test_removing_an_agent_disables_its_group() -> None:
    adapter, client = _adapter(groups=[_agent_group("S001", "flint-tracker")])

    _run(adapter.remove_agent_identity("flint-tracker"))

    assert client.disabled == ["S001"]
    assert "flint-tracker" not in adapter._agent_group_ids


def test_workspace_groups_are_not_mistaken_for_agents() -> None:
    """A workspace's own group must never resolve to an agent — mentioning
    @designers would otherwise address whatever agent shared its name."""
    adapter, _ = _adapter(
        groups=[
            {
                "id": "S999",
                "name": "designers",
                "handle": "designers",
                "description": "The design team",
            }
        ]
    )

    _run(adapter._load_agent_usergroups())

    assert adapter._agent_group_ids == {}
    # It renders as its own handle rather than raw markup, but as the group's
    # handle — never as an agent, which is what would misroute a message.
    assert adapter._translate_usergroup_mentions("<!subteam^S999>") == "@designers"


def test_an_unusual_agent_name_still_yields_a_legal_handle() -> None:
    adapter, client = _adapter()

    _run(adapter.create_agent_identity("Flint Tracker!", "Tracks flint"))

    assert client.created[0]["handle"] == "flint-tracker"
    # The group's name keeps the agent name verbatim, so the mention still
    # resolves back to the agent even though the handle had to be folded.
    assert client.created[0]["name"] == "Flint Tracker!"


# ── A workspace that cannot host user groups ─────────────────────────────────


@pytest.mark.parametrize(
    "error,expected",
    [
        ("permission_denied", "restricts managing user groups to admins"),
        ("no_permission", "restricts managing user groups to admins"),
        ("plan_upgrade_required", "paid Slack plan"),
        ("paid_teams_only", "paid Slack plan"),
        ("missing_scope", "usergroups:read"),
    ],
)
def test_a_workspace_refusal_is_reported_once_and_not_retried(
    error: str, expected: str, caplog: pytest.LogCaptureFixture
) -> None:
    """The setting is on by default, so a workspace that simply cannot host user
    groups is ordinary — but it must say so, and only once, rather than
    complaining per agent on every startup."""
    adapter, client = _adapter()
    client.create_error = error

    with caplog.at_level("WARNING"):
        _run(adapter.create_agent_identity("agent-one", "One"))
        _run(adapter.create_agent_identity("agent-two", "Two"))

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert expected in message
    # The consequence, not just the cause: someone reading the log should know
    # what stopped working and that agents still answer to a typed name.
    assert "autocomplete" in message
    assert "addressable" in message


def test_a_refusal_stops_further_slack_calls() -> None:
    adapter, client = _adapter()
    client.create_error = "plan_upgrade_required"

    _run(adapter.create_agent_identity("agent-one", "One"))
    calls_after_first = len(client.created) + client.list_calls
    _run(adapter.create_agent_identity("agent-two", "Two"))

    assert len(client.created) + client.list_calls == calls_after_first


def test_a_refusal_on_listing_disables_it_too() -> None:
    """A free workspace fails at the very first call — listing — so that path
    has to give up the same way rather than raising past the caller."""
    adapter, client = _adapter()
    client.list_error = "plan_upgrade_required"

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert client.created == []
    assert adapter._agent_usergroups_off_reason == "plan_upgrade_required"


def test_an_unexpected_slack_error_still_propagates() -> None:
    """Only the refusals that mean 'this workspace cannot' are swallowed; a
    genuine fault must still reach the caller."""
    adapter, client = _adapter()
    client.create_error = "internal_error"

    with pytest.raises(SlackApiError):
        _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))


def test_a_handle_taken_by_someone_else_raises() -> None:
    adapter, client = _adapter()
    client.create_error = "handle_already_exists"

    with pytest.raises(RuntimeError, match="already taken"):
        _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))


def test_a_handle_taken_by_our_own_group_is_adopted() -> None:
    """A create can lose a race with our own earlier one; adopting the existing
    group is correct, and must not be reported as a collision."""
    adapter, client = _adapter()
    client.create_error = "handle_already_exists"
    client.groups = [_agent_group("S001", "flint-tracker")]

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert adapter._agent_group_ids["flint-tracker"] == "S001"


# ── Translation ──────────────────────────────────────────────────────────────


def test_inbound_group_mention_becomes_the_agent_name() -> None:
    adapter, _ = _adapter(groups=[_agent_group("S001", "flint-tracker")])
    _run(adapter._load_agent_usergroups())

    assert (
        adapter.translate_inbound("<!subteam^S001> please run the summary")
        == "@flint-tracker please run the summary"
    )


def test_inbound_group_mention_with_a_handle_label() -> None:
    adapter, _ = _adapter(groups=[_agent_group("S001", "flint-tracker")])
    _run(adapter._load_agent_usergroups())

    assert (
        adapter.translate_inbound("<!subteam^S001|@flint-tracker> hi")
        == "@flint-tracker hi"
    )


def test_inbound_resolves_to_the_agent_name_not_the_handle() -> None:
    """The handle may have been folded to be legal; addressing downstream
    matches on the agent's real name, so that is what must come out."""
    adapter, _ = _adapter(
        groups=[
            {
                "id": "S001",
                "name": "Flint.Tracker",
                "handle": "flint-tracker",
                "description": "Switch agent — tracks flint",
            }
        ]
    )
    _run(adapter._load_agent_usergroups())

    assert adapter.translate_inbound("<!subteam^S001> hi") == "@Flint.Tracker hi"


def test_unknown_group_mention_falls_back_to_its_label() -> None:
    adapter, _ = _adapter()

    assert (
        adapter._translate_usergroup_mentions("<!subteam^S999|@designers> ping")
        == "@designers ping"
    )


def test_outbound_agent_mention_renders_as_a_group_pill() -> None:
    adapter, _ = _adapter(groups=[_agent_group("S001", "flint-tracker")])
    _run(adapter._load_agent_usergroups())

    assert (
        adapter._translate_mentions_to_slack("hey @flint-tracker")
        == "hey <!subteam^S001>"
    )


def test_outbound_leaves_unknown_names_alone() -> None:
    adapter, _ = _adapter()

    assert adapter._translate_mentions_to_slack("hey @nobody") == "hey @nobody"


def test_outbound_prefers_a_real_person_over_an_agent_group() -> None:
    adapter, _ = _adapter(groups=[_agent_group("S001", "ambiguous")])
    _run(adapter._load_agent_usergroups())
    adapter.prime_mention_targets({"ambiguous": "U123"})

    assert adapter._translate_mentions_to_slack("@ambiguous") == "<@U123>"


# ── Two workspaces in one org ────────────────────────────────────────────────
#
# A bot token lists only its own workspace's groups, so each bridge mints its
# own group per agent. An Enterprise Grid composer ignores that boundary and
# offers a sibling workspace's group, so the mention arrives naming an id the
# receiving bridge never minted — and Slack has no call to resolve one by id.


def test_a_mention_of_a_sibling_workspaces_group_resolves() -> None:
    """CHOO-2521: tagging an agent in the org's other workspace did nothing."""
    home, _ = _adapter(groups=[_agent_group("S001", "flint-tracker")], team_id="T111")
    _run(home._load_agent_usergroups())

    sibling, _ = _adapter(
        groups=[_agent_group("S002", "flint-tracker")], team_id="T222"
    )
    _run(sibling._load_agent_usergroups())

    assert (
        sibling.translate_inbound("<!subteam^S001> please run the summary")
        == "@flint-tracker please run the summary"
    )


def test_a_sibling_workspaces_own_group_is_still_not_an_agent() -> None:
    home, _ = _adapter(groups=[_plain_group("S900", "designers", "Designers")])
    _run(home._load_agent_usergroups())

    sibling, _ = _adapter(team_id="T222")
    _run(sibling._load_agent_usergroups())

    assert sibling.translate_inbound("<!subteam^S900> ping") == "<!subteam^S900> ping"


def test_a_reload_withdraws_a_group_that_is_gone() -> None:
    home, client = _adapter(groups=[_agent_group("S001", "flint-tracker")])
    _run(home._load_agent_usergroups())
    sibling, _ = _adapter(team_id="T222")

    client.groups = []
    _run(home._load_agent_usergroups())

    assert sibling.translate_inbound("<!subteam^S001> hi") == "<!subteam^S001> hi"


def test_removing_an_agent_withdraws_it_from_the_other_workspace() -> None:
    home, _ = _adapter(groups=[_agent_group("S001", "flint-tracker")])
    _run(home._load_agent_usergroups())
    sibling, _ = _adapter(team_id="T222")

    _run(home.remove_agent_identity("flint-tracker"))

    assert sibling.translate_inbound("<!subteam^S001> hi") == "<!subteam^S001> hi"


def test_a_stopped_bridge_stops_answering_for_its_workspace() -> None:
    home, _ = _adapter(groups=[_agent_group("S001", "flint-tracker")])
    _run(home._load_agent_usergroups())
    sibling, _ = _adapter(team_id="T222")

    _run(home.stop())

    assert sibling.translate_inbound("<!subteam^S001> hi") == "<!subteam^S001> hi"


# ── Rate limiting ────────────────────────────────────────────────────────────


def test_a_rate_limited_create_is_retried_rather_than_lost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provisioning runs once per agent at startup and the allowance is about
    20/minute, so a workspace with more agents than that would otherwise come up
    with some mentionable and some not — and the caller only logs."""
    slept: list[float] = []

    async def _no_sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.slack.adapter.asyncio.sleep", _no_sleep
    )

    adapter, client = _adapter()
    client.create_error = "ratelimited"
    client.clear_error_after = 2

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert len(client.created) == 1
    assert len(slept) == 2
    assert adapter._agent_group_ids["flint-tracker"]


def test_persistent_rate_limiting_says_provisioning_is_incomplete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.slack.adapter.asyncio.sleep", _no_sleep
    )

    adapter, client = _adapter()
    client.create_error = "ratelimited"

    with pytest.raises(RuntimeError, match="restart the bridge"):
        _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))


def test_rate_limiting_does_not_disable_the_feature() -> None:
    """Throttling is temporary; it must not be mistaken for a workspace that
    cannot host user groups at all."""
    adapter, _ = _adapter()

    assert adapter._agent_usergroups_off_reason is None


# ── Groups created by hand ───────────────────────────────────────────────────


def _plain_group(group_id: str, handle: str, name: str) -> dict[str, Any]:
    """A group with no marker — what an admin creating one by hand produces."""
    return {
        "id": group_id,
        "name": name,
        "handle": handle,
        "description": "",
    }


def test_a_hand_made_group_is_adopted_by_handle() -> None:
    """Where a workspace will not let the bot create groups, making them by hand
    is the only way to use the feature, so an exact handle match is claimed."""
    adapter, client = _adapter(
        groups=[_plain_group("S0BRK25CG86", "switch-usecase-builder", "Use case bot")]
    )

    _run(adapter.create_agent_identity("switch-usecase-builder", "Builds use cases"))

    assert client.created == []
    assert adapter._agent_group_ids["switch-usecase-builder"] == "S0BRK25CG86"
    assert adapter._agent_group_names["S0BRK25CG86"] == "switch-usecase-builder"


def test_a_hand_made_group_is_adopted_by_name() -> None:
    adapter, client = _adapter(
        groups=[_plain_group("S001", "some-other-handle", "flint-tracker")]
    )

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert client.created == []
    assert adapter._agent_group_ids["flint-tracker"] == "S001"


def test_adoption_stamps_the_marker_so_it_is_recognised_later() -> None:
    adapter, client = _adapter(
        groups=[_plain_group("S001", "flint-tracker", "flint-tracker")]
    )

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert client.updated == [("S001", "Switch agent — flint-tracker")]


def test_adoption_survives_a_failed_marker_write() -> None:
    """Marking is an optimisation — adoption happens per agent at startup
    regardless — so losing the write must not lose the adoption."""
    adapter, client = _adapter(
        groups=[_plain_group("S001", "flint-tracker", "flint-tracker")]
    )
    client.update_error = "permission_denied"

    _run(adapter.create_agent_identity("flint-tracker", "Tracks flint"))

    assert adapter._agent_group_ids["flint-tracker"] == "S001"


def test_a_hand_made_group_resolves_to_the_agent_after_adoption() -> None:
    adapter, _ = _adapter(
        groups=[_plain_group("S0BRK25CG86", "switch-usecase-builder", "Use case bot")]
    )

    _run(adapter.create_agent_identity("switch-usecase-builder", "Builds use cases"))

    assert (
        adapter.translate_inbound("<!subteam^S0BRK25CG86> hi there")
        == "@switch-usecase-builder hi there"
    )


def test_a_similar_name_does_not_capture_a_workspace_group() -> None:
    """Adoption matches exactly; anything looser would let an agent capture a
    real group and silently swallow messages meant for people."""
    adapter, client = _adapter(groups=[_plain_group("S999", "designers", "Designers")])

    _run(adapter.create_agent_identity("designer", "Not the design team"))

    assert adapter._agent_group_ids.get("designer") != "S999"
    assert len(client.created) == 1


def test_an_unknown_group_renders_as_its_handle_not_raw_markup() -> None:
    """The bug behind the pilot report: a bare tag reached Matrix verbatim."""
    adapter, _ = _adapter(groups=[_plain_group("S999", "designers", "Designers")])
    _run(adapter._load_agent_usergroups())

    assert adapter.translate_inbound("<!subteam^S999> ping") == "@designers ping"


def test_a_group_we_have_never_seen_is_left_alone() -> None:
    adapter, _ = _adapter()

    assert (
        adapter._translate_usergroup_mentions("<!subteam^SNEVER>")
        == "<!subteam^SNEVER>"
    )


# ── Long descriptions ────────────────────────────────────────────────────────


def test_a_long_description_is_truncated_but_keeps_the_marker() -> None:
    adapter, client = _adapter()

    _run(adapter.create_agent_identity("flint-tracker", "x" * 500))

    description = client.created[0]["description"]
    assert description.startswith("Switch agent — ")
    assert len(description) <= 140


def test_a_rejected_description_falls_back_to_the_marker() -> None:
    """Slack does not publish the limit, so a conservative truncation can still
    be refused. Losing the agent's autocomplete over its blurb would be absurd —
    the blurb is what gets dropped."""
    adapter, client = _adapter()
    client.create_error = "description_too_long"
    client.clear_error_after = 1

    _run(adapter.create_agent_identity("flint-tracker", "a long blurb"))

    assert len(client.created) == 1
    assert client.created[0]["description"] == "Switch agent — flint-tracker"
    assert adapter._agent_group_ids["flint-tracker"]


def test_a_marker_only_group_is_still_recognised_on_reload() -> None:
    """The fallback description must not cost us recognition later."""
    adapter, _ = _adapter(
        groups=[
            {
                "id": "S001",
                "name": "flint-tracker",
                "handle": "flint-tracker",
                "description": "Switch agent — flint-tracker",
            }
        ]
    )

    _run(adapter._load_agent_usergroups())

    assert adapter._agent_group_names["S001"] == "flint-tracker"
