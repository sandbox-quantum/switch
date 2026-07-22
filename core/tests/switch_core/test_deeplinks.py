from __future__ import annotations

from switch_core.deeplinks import (
    DEEPLINK_REDIRECT_PATH,
    gateway_query_to_switchdash,
    switchdash_to_gateway,
)

_DEEPLINK = "switchdash://session?server=https%3A%2F%2Fs&agent=a&room=r&session=x"


class TestSwitchdashToGateway:
    def test_rewrites_session_deeplink_to_gateway_redirect(self) -> None:
        result = switchdash_to_gateway(_DEEPLINK, "https://gw.example")
        assert result == (
            "https://gw.example/deeplink/session"
            "?server=https%3A%2F%2Fs&agent=a&room=r&session=x"
        )

    def test_strips_trailing_slash_on_base(self) -> None:
        result = switchdash_to_gateway(_DEEPLINK, "https://gw.example/")
        assert result is not None
        assert result.startswith("https://gw.example/deeplink/session?")

    def test_deeplink_without_query_has_no_question_mark(self) -> None:
        result = switchdash_to_gateway("switchdash://session", "https://gw.example")
        assert result == "https://gw.example/deeplink/session"

    def test_non_switchdash_scheme_returns_none(self) -> None:
        assert (
            switchdash_to_gateway("https://elsewhere/x", "https://gw.example") is None
        )

    def test_wrong_host_returns_none(self) -> None:
        assert (
            switchdash_to_gateway("switchdash://other?a=b", "https://gw.example")
            is None
        )


class TestGatewayQueryToSwitchdash:
    def test_reconstructs_deeplink_from_query(self) -> None:
        query = "server=https%3A%2F%2Fs&agent=a&room=r&session=x"
        assert gateway_query_to_switchdash(query) == f"switchdash://session?{query}"

    def test_empty_query_has_no_question_mark(self) -> None:
        assert gateway_query_to_switchdash("") == "switchdash://session"

    def test_round_trip(self) -> None:
        gateway = switchdash_to_gateway(_DEEPLINK, "https://gw.example")
        assert gateway is not None
        query = gateway.split(DEEPLINK_REDIRECT_PATH + "?", 1)[1]
        assert gateway_query_to_switchdash(query) == _DEEPLINK
