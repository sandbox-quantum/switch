from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.sms.config import SmsConnectionConfig

SID = "AC" + "0" * 32


def _config(**overrides: Any) -> SmsConnectionConfig:
    values: dict[str, Any] = {
        "account_sid": SID,
        "auth_token": "test-auth-token",
        "phone_number": "+14155550100",
        "allowed_senders": "+14155550101",
        "default_agent": "helper",
    }
    return SmsConnectionConfig(**{**values, **overrides})


def test_valid_config_parses_with_default_limits() -> None:
    config = _config()
    assert config.allowed_numbers == {"+14155550101"}
    assert config.max_segments_per_reply == 5
    assert config.max_segments_per_hour == 20


def test_numbers_are_normalized() -> None:
    config = _config(
        phone_number=" +1 (415) 555-0100 ",
        allowed_senders="+1 415 555 0101, +14155550102;\n+1-415-555-0101,",
    )
    assert config.phone_number == "+14155550100"
    assert config.allowed_numbers == {"+14155550101", "+14155550102"}


def test_limits_typed_into_the_form_are_read_and_blank_takes_the_default() -> None:
    config = _config(max_segments_per_reply="4", max_segments_per_hour="  ")
    assert config.max_segments_per_reply == 4
    assert config.max_segments_per_hour == 20


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"account_sid": "SK" + "0" * 32}, "account_sid is AC"),
        ({"account_sid": "AC123"}, "account_sid is AC"),
        ({"auth_token": "   "}, "auth_token is empty"),
        ({"default_agent": ""}, "default_agent is empty"),
        ({"phone_number": "4155550100"}, "E.164"),
        ({"allowed_senders": " "}, "allowed_senders is empty"),
        ({"allowed_senders": " , ;"}, "lists no phone numbers"),
        ({"allowed_senders": "+14155550101,not-a-number"}, "E.164"),
        ({"allowed_senders": "+1 415 555 0100"}, "own Twilio number"),
        ({"max_segments_per_reply": 0}, "greater than or equal to 1"),
        ({"max_segments_per_hour": "many"}, "valid integer"),
        ({"max_segments_per_reply": 21}, "above max_segments_per_hour"),
    ],
)
def test_unusable_config_is_refused(overrides: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        _config(**overrides)


def test_refusal_does_not_echo_the_token() -> None:
    with pytest.raises(ValidationError) as caught:
        _config(account_sid="bad", auth_token="super-secret-value")
    assert "super-secret-value" not in str(caught.value)


def test_form_schema_requires_the_credentials_as_text_fields() -> None:
    schema = SmsConnectionConfig.model_json_schema()
    assert set(schema["required"]) == {
        "account_sid",
        "auth_token",
        "phone_number",
        "allowed_senders",
        "default_agent",
    }
    assert all(
        schema["properties"][name]["type"] == "string" for name in schema["required"]
    )
