"""What a template is for: one of a fixed list, so the catalogue can label it.

The list is the product's, and short on purpose: a card shows one label, and
a free-text field would soon hold "Eng", "engineering" and "Engineering" as
three different answers. A template need not have one. The database holds
the same list as a check constraint, so a value outside it cannot be stored
by any path; adding one is a migration as well as an edit here.
"""

from __future__ import annotations

from typing import Literal, TypeGuard, get_args

UseCase = Literal[
    "engineering",
    "product",
    "support",
    "research",
    "ops",
    "personal",
    "sales",
    "marketing",
]

USE_CASES: tuple[str, ...] = get_args(UseCase)


def is_use_case(value: object) -> TypeGuard[UseCase]:
    return value in USE_CASES
