"""Whose usage is the company's own.

Staff use the product too, and their usage is real but is not adoption, so the
numbers have to be able to leave it out. Two signals, neither an identifier:
a deployment says it is one of the company's own (`TELEMETRY_INTERNAL`), and
the daily snapshot counts the accounts on the company's email domains. The
same domains mark a staff member in Switch Console.
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, func, or_
from sqlalchemy.orm import InstrumentedAttribute

INTERNAL_EMAIL_DOMAINS: tuple[str, ...] = ("sandboxaq.com", "sandboxquantum.com")


def internal_email_condition(
    email: ColumnElement[str] | InstrumentedAttribute[str],
) -> ColumnElement[bool]:
    """Whether `email` is on one of `INTERNAL_EMAIL_DOMAINS` or a subdomain of
    one, as SQL, so accounts are counted without loading their addresses."""
    lowered = func.lower(email)
    return or_(
        *(
            pattern
            for internal in INTERNAL_EMAIL_DOMAINS
            for pattern in (
                lowered.like(f"%@{internal}"),
                lowered.like(f"%@%.{internal}"),
            )
        )
    )
