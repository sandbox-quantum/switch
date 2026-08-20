"""Unit tests for the pure bulk-subagent-registration helpers (no DB)."""

from __future__ import annotations

import pytest

from switch_core.gateway.subagent_registration import (
    derive_subagent_registrations,
    inherited_parent_options,
)


class TestInheritedParentOptions:
    def test_picks_only_inheritable_keys(self) -> None:
        md = {
            "known_agent_options": {
                "channels_enabled": False,
                "repo_dir": "/repo",
                "subagent_name": "should-not-inherit",
            }
        }
        assert inherited_parent_options(md) == {
            "channels_enabled": False,
            "repo_dir": "/repo",
        }

    def test_skips_none_values(self) -> None:
        md = {"known_agent_options": {"repo_dir": None, "channels_enabled": True}}
        assert inherited_parent_options(md) == {"channels_enabled": True}

    def test_empty_when_metadata_missing_or_malformed(self) -> None:
        assert inherited_parent_options(None) == {}
        assert inherited_parent_options({}) == {}
        assert inherited_parent_options({"known_agent_options": "nope"}) == {}


class TestDeriveSubagentRegistrations:
    def test_derives_names_and_merges_options(self) -> None:
        derived = derive_subagent_registrations(
            parent_name="main",
            parent_metadata={"known_agent_options": {"repo_dir": "/repo"}},
            base_options={},
            subagents=[("reviewer", "Reviews diffs")],
        )
        assert len(derived) == 1
        d = derived[0]
        assert d.subagent_name == "reviewer"
        assert d.name == "main.reviewer"
        assert d.description == "Reviews diffs"
        # inherited repo_dir + always-set subagent_name
        assert d.options == {"repo_dir": "/repo", "subagent_name": "reviewer"}

    def test_base_options_override_inherited_and_subagent_name_is_last(self) -> None:
        derived = derive_subagent_registrations(
            parent_name="main",
            parent_metadata={"known_agent_options": {"repo_dir": "/parent"}},
            base_options={"repo_dir": "/override", "subagent_name": "ignored"},
            subagents=[("planner", "Plans")],
        )
        assert derived[0].options == {
            "repo_dir": "/override",
            "subagent_name": "planner",
        }

    def test_rejects_in_batch_duplicates(self) -> None:
        with pytest.raises(ValueError, match="Duplicate subagent"):
            derive_subagent_registrations(
                parent_name="main",
                parent_metadata={},
                base_options={},
                subagents=[("dup", "a"), ("dup", "b")],
            )

    def test_preserves_order(self) -> None:
        derived = derive_subagent_registrations(
            parent_name="p",
            parent_metadata={},
            base_options={},
            subagents=[("a", "A"), ("b", "B"), ("c", "C")],
        )
        assert [d.name for d in derived] == ["p.a", "p.b", "p.c"]
