"""Schema-level validation of the admin user-creation request body.

`POST /users` hashes the password with bcrypt, which raises on inputs longer
than 72 bytes, and finds accounts by an address the signup path normalises.
The schema now enforces all of that so a bad request is a 422, not a 500, and
the same address means the same account no matter which creation path it
arrives through (`SignupRequest` shares the constraints — `test_signup.py`
covers its HTTP behaviour end to end).

No database needed: everything here is the request schema's contract.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.gateway.schemas import CreateUserRequest


class TestCreateUserSchemaValidation:
    def test_email_is_normalised(self) -> None:
        request = CreateUserRequest(
            name="Ada", email="  Admin@Example.COM  ", password="good-pass-1"
        )
        assert request.email == "admin@example.com"

    def test_role_defaults_to_user(self) -> None:
        request = CreateUserRequest(
            name="Ada", email="ada@example.com", password="good-pass-1"
        )
        assert request.role == "user"

    def test_short_password_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            CreateUserRequest(name="Ada", email="ada@example.com", password="short")
        assert any(e["type"] == "string_too_short" for e in exc_info.value.errors())

    def test_empty_password_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreateUserRequest(name="Ada", email="ada@example.com", password="")

    def test_password_over_seventy_two_bytes_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            CreateUserRequest(name="Ada", email="ada@example.com", password="x" * 73)
        assert "at most 72 bytes" in str(exc_info.value.errors())

    def test_password_over_seventy_two_bytes_rejected_even_when_few_characters(
        self,
    ) -> None:
        # 40 characters clears the 8-character floor, but is 80 bytes —
        # bcrypt's input limit is counted in bytes, so the schema counts
        # bytes too.
        with pytest.raises(ValidationError) as exc_info:
            CreateUserRequest(name="Ada", email="ada@example.com", password="é" * 40)
        assert "at most 72 bytes" in str(exc_info.value.errors())

    def test_password_of_exactly_seventy_two_bytes_accepted(self) -> None:
        request = CreateUserRequest(
            name="Ada", email="ada@example.com", password="é" * 36
        )
        assert request.password == "é" * 36

    def test_bad_email_rejected(self) -> None:
        with pytest.raises(ValidationError):
            CreateUserRequest(name="Ada", email="not-an-email", password="good-pass-1")
