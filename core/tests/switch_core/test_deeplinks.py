from __future__ import annotations

from switch_core.deeplinks import (
    DEEPLINK_REDIRECT_PATH,
    deeplink_for_platform,
    gateway_query_to_switchdash,
    switchdash_to_gateway,
)

_DEEPLINK = "switchdash://session?server=https%3A%2F%2Fs&agent=a&room=r&session=x"


class TestDeeplinkForPlatform:
    """Which form of the link a platform is given (CHOO-2173).

    The gateway redirect exists for platforms that will not linkify a custom
    scheme — Discord, Telegram. It was being handed to every platform on any
    deployment that configured a gateway URL, which every managed stack does,
    so Mattermost was sending readers through the browser to reach a link its
    own client would have opened.
    """

    def test_a_platform_that_renders_the_scheme_gets_the_real_link(self) -> None:
        assert deeplink_for_platform(_DEEPLINK, "https://gw.example", True) == _DEEPLINK

    def test_a_platform_that_does_not_gets_the_redirect(self) -> None:
        assert deeplink_for_platform(_DEEPLINK, "https://gw.example", False) == (
            "https://gw.example/deeplink/session"
            "?server=https%3A%2F%2Fs&agent=a&room=r&session=x"
        )

    def test_without_a_gateway_url_there_is_nothing_to_rewrite_to(self) -> None:
        assert deeplink_for_platform(_DEEPLINK, None, False) == _DEEPLINK

    def test_no_deeplink_stays_no_deeplink(self) -> None:
        assert deeplink_for_platform(None, "https://gw.example", False) is None

    def test_a_link_that_is_not_a_session_deeplink_is_left_alone(self) -> None:
        assert (
            deeplink_for_platform("https://elsewhere/x", "https://gw.example", False)
            == "https://elsewhere/x"
        )


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
