"""The Zulip connect form: what an operator types, and what is refused.

The config *is* the form Console draws, and a mistake here surfaces as a saved
connection that fails later, so every field that can be checked without a
network call is checked here.
"""

from __future__ import annotations

import httpx
import pytest

from switch_core.bridges.collaboration.models import BridgeCredentialError
from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)
from switch_core.bridges.collaboration.zulip.http_client import ZulipClient


def _config(**overrides: object) -> ZulipConnectionConfig:
    values: dict[str, object] = {
        "url": "https://acme.zulipchat.com",
        "email": "switch-bot@acme.zulipchat.com",
        "api_key": "key",
    }
    values.update(overrides)
    return ZulipConnectionConfig.model_validate(values)


def _against_organization(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """Point the adapter's client factory at a fake organization.

    Only the transport is replaced, so `verify_credentials` runs exactly the
    code production runs and the request it makes is what the test reads.
    """
    import switch_core.bridges.collaboration.zulip.adapter as module

    original = module.ZulipClient

    def fake_client(**kwargs: object) -> ZulipClient:
        return original(**kwargs, transport=httpx.MockTransport(handler))  # type: ignore[arg-type]

    monkeypatch.setattr(module, "ZulipClient", fake_client)


def test_a_trailing_slash_is_not_part_of_the_address() -> None:
    # The bridge appends /api/v1 itself; a stored slash would make it //api/v1.
    assert (
        _config(url="https://acme.zulipchat.com/").url == "https://acme.zulipchat.com"
    )


@pytest.mark.parametrize(
    "url",
    [
        "acme.zulipchat.com",
        "ftp://acme.zulipchat.com",
        "https://acme.zulipchat.com/api/v1",
        "https://acme.zulipchat.com/with/a/path",
    ],
)
def test_an_address_that_is_not_an_organization_is_refused(url: str) -> None:
    with pytest.raises(ValueError):
        _config(url=url)


@pytest.mark.parametrize("email", ["switch-bot", "@acme.zulipchat.com", "bot@"])
def test_the_bot_address_must_be_an_address(email: str) -> None:
    # The bot's address, not the person who created it: the two differ and the
    # form is the only place that can say so.
    with pytest.raises(ValueError):
        _config(email=email)


def test_an_empty_api_key_is_refused() -> None:
    with pytest.raises(ValueError):
        _config(api_key="   ")


@pytest.mark.parametrize("topic", ["", "   ", "x" * 61, "two\nlines"])
def test_a_topic_zulip_would_refuse_is_refused_here(topic: str) -> None:
    with pytest.raises(ValueError):
        _config(default_topic=topic)


def test_the_default_topic_is_a_single_line_within_the_cap() -> None:
    assert _config(default_topic=" Switch ").default_topic == "Switch"
    assert len(_config(default_topic="t" * 60).default_topic) == 60


def test_the_url_is_declared_for_the_outbound_policy() -> None:
    assert ZulipAdapter.outbound_urls({"url": "https://acme.zulipchat.com"}) == [
        "https://acme.zulipchat.com"
    ]


async def test_bad_credentials_are_refused_at_connect_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Without this a mistyped key looks saved and fails when the first message
    # is due, hours later.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "result": "error",
                "msg": "Your API key is not valid",
                "code": "UNAUTHORIZED",
            },
        )

    _against_organization(monkeypatch, handler)

    with pytest.raises(BridgeCredentialError, match="Your API key is not valid"):
        await ZulipAdapter.verify_credentials(
            {
                "url": "https://acme.zulipchat.com",
                "email": "bot@acme.zulipchat.com",
                "api_key": "wrong",
            }
        )


async def test_good_credentials_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/users/me"
        return httpx.Response(
            200,
            json={
                "result": "success",
                "msg": "",
                "user_id": 9,
                "email": "bot@acme.zulipchat.com",
                "full_name": "Switch",
            },
        )

    _against_organization(monkeypatch, handler)

    await ZulipAdapter.verify_credentials(
        {
            "url": "https://acme.zulipchat.com",
            "email": "bot@acme.zulipchat.com",
            "api_key": "key",
        }
    )
