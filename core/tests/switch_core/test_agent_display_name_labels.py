"""The label a renamed agent carries when nobody said what it should be."""

from __future__ import annotations

import pytest

from switch_core.agent_display_name import label_after_rename, label_from_name


@pytest.mark.parametrize(
    "name,label",
    [
        ("notes-helper", "Notes Helper"),
        ("release_captain.v2", "Release Captain V2"),
        ("a--b", "A B"),
        ("solo", "Solo"),
    ],
)
def test_a_name_written_out(name: str, label: str) -> None:
    assert label_from_name(name) == label


def test_a_label_that_is_the_old_name_follows_the_new_one() -> None:
    assert (
        label_after_rename("Notes Taker", "notes-taker", "meeting-scribe")
        == "Meeting Scribe"
    )


def test_a_chosen_label_is_kept() -> None:
    assert label_after_rename("Scribe", "notes-taker", "meeting-scribe") == "Scribe"


def test_no_label_stays_none() -> None:
    assert label_after_rename(None, "notes-taker", "meeting-scribe") is None
