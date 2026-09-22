from __future__ import annotations

import pytest

from switch_core.deeplinks import (
    DEEPLINK_REDIRECT_PATH,
    deeplink_for_platform,
    gateway_query_to_switchdash,
    gateway_url_is_loopback,
    gateway_url_warning,
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


class TestGatewayUrlIsLoopback:
    """A configured origin that only the Switch host can reach.

    A locally managed server hands Switch Console's own `http://localhost:<port>`
    to GATEWAY_PUBLIC_URL, which makes every posted link clickable and useless to
    anyone reading from a phone.
    """

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:8000",
            "http://LOCALHOST",
            "http://localhost.:8000",
            "http://switch.localhost",
            "http://127.0.0.1:54212",
            "http://127.1.2.3",
            "http://[::1]:8000",
        ],
    )
    def test_an_origin_only_this_machine_can_reach_is_loopback(self, url: str) -> None:
        assert gateway_url_is_loopback(url) is True

    @pytest.mark.parametrize(
        "url",
        [
            "https://gw.example",
            "https://localhost.example",
            "http://10.0.0.1:8000",
            "http://0.0.0.0:8000",
            "https://[2001:db8::1]",
        ],
    )
    def test_an_origin_someone_else_could_reach_is_not(self, url: str) -> None:
        assert gateway_url_is_loopback(url) is False


class TestGatewayUrlWarning:
    def test_a_loopback_origin_is_announced_rather_than_left_silent(self) -> None:
        warning = gateway_url_warning("http://localhost:54212", False)
        assert warning is not None
        assert "http://localhost:54212" in warning
        assert "loopback" in warning

    def test_a_loopback_origin_is_announced_even_where_no_rewrite_happens(
        self,
    ) -> None:
        # The deeplink is posted raw here, but it still carries the origin as
        # the server Switch Console is told to reach.
        assert gateway_url_warning("http://127.0.0.1:54212", True) is not None

    def test_an_unset_origin_costs_a_clickable_link_on_an_http_only_platform(
        self,
    ) -> None:
        warning = gateway_url_warning(None, False)
        assert warning is not None
        assert "not set" in warning

    def test_an_unset_origin_costs_nothing_where_the_scheme_renders(self) -> None:
        assert gateway_url_warning(None, True) is None

    @pytest.mark.parametrize("renders", [True, False])
    def test_a_reachable_origin_warns_about_nothing(self, renders: bool) -> None:
        assert gateway_url_warning("https://gw.example", renders) is None


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
