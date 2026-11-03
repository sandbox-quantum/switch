"""How an agent's group reference (a path, a bare name or an id) resolves.

Pure: the resolver works on the tenant's groups as already loaded, so these
need no database. The store tests cover the sibling-name rule that keeps paths
unambiguous going forward.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from switch_core.db.stores.room_group_store import (
    group_path,
    resolve_group_reference,
)


@dataclass(frozen=True)
class G:
    id: str
    name: str
    parent_group_id: str | None


# Payments
# ├── Incidents
# └── Releases
# Fraud
# ├── Incidents
# └── Releases
# Eng
TREE = [
    G("pay", "Payments", None),
    G("pay-inc", "Incidents", "pay"),
    G("pay-rel", "Releases", "pay"),
    G("fraud", "Fraud", None),
    G("fraud-inc", "Incidents", "fraud"),
    G("fraud-rel", "Releases", "fraud"),
    G("eng", "Eng", None),
]


class TestResolveGroupReference:
    def test_unique_bare_name(self) -> None:
        assert resolve_group_reference(TREE, "Eng") == "eng"
        assert resolve_group_reference(TREE, "Fraud") == "fraud"

    def test_path_picks_the_child_under_that_parent(self) -> None:
        assert resolve_group_reference(TREE, "Fraud/Incidents") == "fraud-inc"
        assert resolve_group_reference(TREE, "Payments/Incidents") == "pay-inc"

    def test_displayed_path_with_spaces_works(self) -> None:
        assert resolve_group_reference(TREE, "Fraud / Releases") == "fraud-rel"

    def test_id_works(self) -> None:
        assert resolve_group_reference(TREE, "fraud-inc") == "fraud-inc"

    def test_ambiguous_bare_name_lists_each_path(self) -> None:
        with pytest.raises(ValueError) as e:
            resolve_group_reference(TREE, "Incidents")
        assert str(e.value) == (
            "Ambiguous room group 'Incidents': use 'Fraud/Incidents' or "
            "'Payments/Incidents'"
        )

    def test_unknown_bare_name(self) -> None:
        with pytest.raises(ValueError, match="No room group named 'Nope'"):
            resolve_group_reference(TREE, "Nope")

    def test_unknown_first_segment_is_named(self) -> None:
        with pytest.raises(ValueError) as e:
            resolve_group_reference(TREE, "Billing/Incidents")
        assert str(e.value) == (
            "No room group 'Billing/Incidents': there is no group named "
            "'Billing' at the top level"
        )

    def test_unknown_later_segment_is_named_with_its_parent(self) -> None:
        with pytest.raises(ValueError) as e:
            resolve_group_reference(TREE, "Fraud/Outages")
        assert str(e.value) == (
            "No room group 'Fraud/Outages': there is no group named 'Outages' "
            "under 'Fraud'"
        )

    def test_path_must_start_at_the_top_level(self) -> None:
        with pytest.raises(ValueError, match="no group named 'Incidents' at the top"):
            resolve_group_reference(TREE, "Incidents/Anything")

    def test_names_match_exactly(self) -> None:
        with pytest.raises(ValueError, match="No room group named 'ENG'"):
            resolve_group_reference(TREE, "ENG")

    def test_empty_segment_is_refused(self) -> None:
        with pytest.raises(ValueError, match="empty segment"):
            resolve_group_reference(TREE, "Fraud//Incidents")

    def test_legacy_sibling_duplicates_point_at_ids(self) -> None:
        groups = [
            G("top", "Ops", None),
            G("a", "Dup", "top"),
            G("b", "Dup", "top"),
        ]
        with pytest.raises(ValueError) as e:
            resolve_group_reference(groups, "Dup")
        assert str(e.value) == (
            "Ambiguous room group 'Dup': use 'Ops/Dup' (id 'a') or 'Ops/Dup' (id 'b')"
        )
        with pytest.raises(ValueError, match="pass one of their ids instead"):
            resolve_group_reference(groups, "Ops/Dup")
        assert resolve_group_reference(groups, "b") == "b"

    def test_ambiguous_ancestor_names_the_final_groups_by_id(self) -> None:
        # The ids of the two "Ops" groups would file the room under Ops, not
        # Incidents, so the error offers the Incidents groups instead.
        groups = [
            G("ops-1", "Ops", None),
            G("ops-2", "Ops", None),
            G("inc-1", "Incidents", "ops-1"),
            G("inc-2", "Incidents", "ops-2"),
        ]
        with pytest.raises(ValueError) as e:
            resolve_group_reference(groups, "Ops/Incidents")
        assert str(e.value) == (
            "Ambiguous room group 'Ops/Incidents': 2 groups are named 'Ops' at "
            "the top level, so the path does not single out one group; pass the "
            "id of the one you mean instead: 'Ops/Incidents' (id 'inc-1') or "
            "'Ops/Incidents' (id 'inc-2')"
        )

    def test_ambiguous_ancestor_with_one_final_group_offers_its_id(self) -> None:
        groups = [
            G("ops-1", "Ops", None),
            G("ops-2", "Ops", None),
            G("inc-2", "Incidents", "ops-2"),
        ]
        with pytest.raises(ValueError) as e:
            resolve_group_reference(groups, "Ops/Incidents")
        assert str(e.value).endswith(
            "pass its id instead: 'Ops/Incidents' (id 'inc-2')"
        )

    def test_ambiguous_ancestor_without_the_final_group(self) -> None:
        groups = [G("ops-1", "Ops", None), G("ops-2", "Ops", None)]
        with pytest.raises(ValueError) as e:
            resolve_group_reference(groups, "Ops/Incidents")
        assert str(e.value) == (
            "No room group 'Ops/Incidents': there is no group named 'Incidents' "
            "under any of the 2 groups at 'Ops'"
        )

    def test_a_top_level_match_is_offered_by_id(self) -> None:
        # Its path is the bare name itself, so suggesting the path would only
        # repeat the ambiguous reference.
        groups = [
            G("root", "Root", None),
            G("top", "Dup", None),
            G("nested", "Dup", "root"),
        ]
        with pytest.raises(ValueError) as e:
            resolve_group_reference(groups, "Dup")
        assert str(e.value) == (
            "Ambiguous room group 'Dup': use 'Root/Dup' or id 'top' for the "
            "top-level 'Dup'"
        )

    def test_legacy_name_with_separator_is_reached_by_id(self) -> None:
        groups = [G("x", "A/B", None), G("y", "A", None), G("z", "B", "y")]
        assert resolve_group_reference(groups, "A/B") == "z"
        assert resolve_group_reference(groups, "x") == "x"


class TestGroupPath:
    def test_root_first(self) -> None:
        by_id = {g.id: g for g in TREE}
        assert group_path(by_id["fraud-inc"], by_id) == "Fraud/Incidents"
        assert group_path(by_id["eng"], by_id) == "Eng"
