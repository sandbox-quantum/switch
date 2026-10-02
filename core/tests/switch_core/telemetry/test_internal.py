"""Which accounts are the company's own staff, by email domain."""

from __future__ import annotations

import pytest

from switch_core.telemetry.internal import is_internal_email


@pytest.mark.parametrize(
    "email",
    [
        "someone@sandboxaq.com",
        "someone@sandboxquantum.com",
        "Someone@SandboxAQ.com",
        "someone@eng.sandboxaq.com",
    ],
)
def test_staff_addresses_are_internal(email: str) -> None:
    assert is_internal_email(email)


@pytest.mark.parametrize(
    "email",
    ["someone@example.com", "someone@notsandboxaq.com", "someone@sandboxaq.com.evil"],
)
def test_other_addresses_are_not(email: str) -> None:
    assert not is_internal_email(email)
