"""`users.role` takes exactly two values through `POST /users`."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.gateway.schemas import CreateUserRequest


@pytest.mark.parametrize("role", ["user", "admin"])
def test_the_two_roles_are_accepted(role: str) -> None:
    req = CreateUserRequest(
        name="n", email="e@example.test", password="password-1", role=role
    )  # type: ignore[arg-type]
    assert req.role == role


def test_the_default_is_user() -> None:
    assert (
        CreateUserRequest(name="n", email="e@example.test", password="password-1").role
        == "user"
    )


@pytest.mark.parametrize("role", ["operator", "owner", "Admin", "", "superuser"])
def test_anything_else_is_refused(role: str) -> None:
    with pytest.raises(ValidationError):
        CreateUserRequest(
            name="n", email="e@example.test", password="password-1", role=role
        )  # type: ignore[arg-type]
