"""Tests for self-service password change (PUT /auth/me/password).

Exercises the route coroutine directly — same approach as test_auth_refresh.py.
A lightweight async session stub replaces the real DB session so the test runs
without PostgreSQL.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from switch_core.db.models import User
from switch_core.gateway.auth import hash_password, verify_password
from switch_core.gateway.auth_routes import change_password
from switch_core.gateway.schemas import ChangePasswordRequest


class _FakeSession:
    """Stub that records whether commit was called."""

    def __init__(self) -> None:
        self.committed = False

    async def commit(self) -> None:
        self.committed = True


def _user(password: str = "old-password-1") -> User:
    return User(
        id="u-1",
        name="Ada",
        email="ada@example.com",
        role="user",
        password_hash=hash_password(password),
    )


async def test_happy_path_changes_password() -> None:
    user = _user()
    session = _FakeSession()
    req = ChangePasswordRequest(
        current_password="old-password-1", new_password="new-password-1"
    )

    result = await change_password(req, session, user)  # type: ignore[arg-type]

    assert result == {"ok": True}
    assert session.committed
    assert verify_password("new-password-1", user.password_hash)
    assert not verify_password("old-password-1", user.password_hash)


async def test_wrong_current_password_returns_403() -> None:
    user = _user()
    session = _FakeSession()
    req = ChangePasswordRequest(
        current_password="wrong-password", new_password="new-password-1"
    )

    with pytest.raises(HTTPException) as exc_info:
        await change_password(req, session, user)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 403
    assert not session.committed


async def test_short_new_password_rejected_by_schema() -> None:
    with pytest.raises(ValidationError) as exc_info:
        ChangePasswordRequest(current_password="old-password-1", new_password="short")

    errors = exc_info.value.errors()
    assert any(e["type"] == "string_too_short" for e in errors)


async def test_empty_new_password_rejected_by_schema() -> None:
    with pytest.raises(ValidationError):
        ChangePasswordRequest(current_password="old-password-1", new_password="")


async def test_oidc_user_without_password_hash_returns_403() -> None:
    """OIDC-provisioned users have password_hash=None — changing password must fail cleanly."""
    user = User(
        id="u-2",
        name="Oidc User",
        email="oidc@example.com",
        role="user",
        password_hash=None,
    )
    session = _FakeSession()
    req = ChangePasswordRequest(
        current_password="anything", new_password="new-password-1"
    )

    with pytest.raises(HTTPException) as exc_info:
        await change_password(req, session, user)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 403
    assert not session.committed
