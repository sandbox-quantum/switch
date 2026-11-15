"""Link codes survive what people and chat clients do to them (CHOO-3881)."""

from __future__ import annotations

import pytest

from switch_core.account_links import new_link_code, normalise_link_code


def test_a_new_code_reads_back_as_itself() -> None:
    code = new_link_code()
    assert normalise_link_code(code) == code.replace("-", "")


@pytest.mark.parametrize(
    "typed",
    [
        "7KQ2-M9XD",
        "7kq2m9xd",
        " 7KQ2 M9XD ",
        "`7KQ2-M9XD`",
        '"7KQ2-M9XD".',
        "7KQ2​-M9XD",
    ],
)
def test_what_a_person_types_reads_as_the_code(typed: str) -> None:
    assert normalise_link_code(typed) == "7KQ2M9XD"


def test_letters_that_look_like_digits_read_as_the_digits() -> None:
    assert normalise_link_code("OIL2-M9XD") == "0112M9XD"


@pytest.mark.parametrize(
    "typed", ["", "7KQ2-M9X", "7KQ2-M9XD-1", "my code is 7KQ2-M9XD", "7KQ2-M9XU"]
)
def test_anything_else_is_not_a_code(typed: str) -> None:
    assert normalise_link_code(typed) is None
