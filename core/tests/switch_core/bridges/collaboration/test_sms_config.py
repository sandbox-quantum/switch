"""The SMS connection form: what is accepted and what is refused up front."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.sms.adapter import SmsConnectionConfig

SID = "AC" + "0" * 32


def _config(**overrides: object) -> SmsConnectionConfig:
    values: dict[str, object] = {
        "account_sid": SID,
        "auth_token": "token-value",
        "phone_number": "+15550001111",
        "allowed_numbers": "+15550002222",
    }
    values.update(overrides)
    return SmsConnectionConfig.model_validate(values)


class TestValidConfig:
    def test_a_minimal_config_parses_with_defaults(self) -> None:
        config = _config()
        assert config.allowed == frozenset({"+15550002222"})
        assert config.max_segments_per_reply == 8
        assert config.max_segments_per_hour == 200

    def test_several_numbers_separated_by_commas_spaces_or_lines(self) -> None:
        config = _config(allowed_numbers="+15550002222, +447700900123\n+15550003333")
        assert config.allowed == frozenset(
            {"+15550002222", "+447700900123", "+15550003333"}
        )

    def test_common_formatting_is_normalised_to_e164(self) -> None:
        config = _config(allowed_numbers="+1 (555) 000-2222")
        assert config.allowed == frozenset({"+15550002222"})

    def test_the_form_lists_its_required_fields_in_order(self) -> None:
        schema = SmsConnectionConfig.model_json_schema()
        assert schema["required"] == [
            "account_sid",
            "auth_token",
            "phone_number",
            "allowed_numbers",
        ]


class TestInvalidConfig:
    @pytest.mark.parametrize("sid", ["", "AC123", "SK" + "0" * 32, "AC" + "g" * 32])
    def test_a_bad_account_sid_is_refused(self, sid: str) -> None:
        with pytest.raises(ValidationError, match="Account SID"):
            _config(account_sid=sid)

    def test_an_empty_token_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            _config(auth_token="")

    @pytest.mark.parametrize("number", ["5550001111", "+0123", "abc", "+1"])
    def test_a_bad_twilio_number_is_refused(self, number: str) -> None:
        with pytest.raises(ValidationError, match="E.164"):
            _config(phone_number=number)

    def test_an_empty_allow_list_is_refused(self) -> None:
        with pytest.raises(ValidationError, match="at least one"):
            _config(allowed_numbers="  ")

    def test_a_bad_allowed_number_is_named(self) -> None:
        with pytest.raises(ValidationError, match="12345"):
            _config(allowed_numbers="+15550002222, 12345")

    def test_the_error_does_not_echo_the_token(self) -> None:
        with pytest.raises(ValidationError) as caught:
            _config(auth_token="token-value", account_sid="nope")
        assert "token-value" not in str(caught.value)

    @pytest.mark.parametrize("cap", [3, 21])
    def test_the_reply_cap_is_bounded(self, cap: int) -> None:
        with pytest.raises(ValidationError):
            _config(max_segments_per_reply=cap)

    def test_the_hourly_cap_must_be_positive(self) -> None:
        with pytest.raises(ValidationError):
            _config(max_segments_per_hour=0)
