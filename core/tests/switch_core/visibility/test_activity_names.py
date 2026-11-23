"""Names on a workspace's Activity page: its own members only, never an
operator, and nothing without the keyed-id key."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.visibility.activity_names import names_for
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind

KEY = KeyedIdKey(b"a-made-up-test-key-of-thirty-two-bytes-or-more", "k1")
MEMBERS = {"u-kim": "Kim Example", "u-admin": "Ada Admin"}


def _entry(**over: Any) -> SimpleNamespace:
    base: dict[str, Any] = {
        "actor_user_id": "u-admin",
        "target_type": "user",
        "target_id": KEY.keyed_id(KeyedIdKind.USER, "u-kim"),
        "details": {"result": "done"},
    }
    return SimpleNamespace(**{**base, **over})


def test_an_admin_change_names_both_people() -> None:
    assert names_for([_entry()], members=MEMBERS, key=KEY) == [
        ("Ada Admin", "Kim Example")
    ]


def test_an_operator_is_never_named() -> None:
    copy = _entry(actor_user_id=None, details={"actor_kind": "operator"})
    sneaky = _entry(actor_user_id="u-admin", details={"actor_kind": "operator"})
    assert names_for([copy, sneaky], members=MEMBERS, key=KEY) == [
        (None, "Kim Example"),
        (None, "Kim Example"),
    ]


def test_someone_outside_the_workspace_stays_unnamed() -> None:
    outsider = _entry(
        actor_user_id="u-elsewhere",
        target_id=KEY.keyed_id(KeyedIdKind.USER, "u-elsewhere"),
    )
    assert names_for([outsider], members=MEMBERS, key=KEY) == [(None, None)]


def test_without_the_key_keyed_targets_stay_unnamed() -> None:
    assert names_for([_entry()], members=MEMBERS, key=None) == [("Ada Admin", None)]


def test_an_older_entry_with_a_raw_member_id_is_named() -> None:
    raw = _entry(target_id="u-kim")
    assert names_for([raw], members=MEMBERS, key=None) == [("Ada Admin", "Kim Example")]


def test_a_box_target_is_not_a_person() -> None:
    box = _entry(target_type="box", target_id=KEY.keyed_id(KeyedIdKind.BOX, "u-kim"))
    assert names_for([box], members=MEMBERS, key=KEY) == [("Ada Admin", None)]
