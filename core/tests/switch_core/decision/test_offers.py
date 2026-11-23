"""What the server's decision service offers, read from its `/health`."""

from __future__ import annotations

import json

import httpx
import pytest

from switch_core.decision.offers import ServiceOffersReader, parse_health
from switch_core.decision.settings import ServerDefault

_SERVER = ServerDefault(
    endpoint_url="http://decision.test/decide", api_key="k", bedrock_enabled=False
)
_HEALTH = {
    "ok": True,
    "backends": {
        "default": {
            "backend": "open_model",
            "model": "open-235b",
            "label": "Open 235B (hosted)",
            "threshold": 0.89,
            "fallback": None,
            "is_default": True,
        },
        "systemone": {
            "backend": "systemone",
            "model": "small",
            "label": "  Small (self-hosted)  ",
            "threshold": 0.56,
            "fallback": None,
        },
        "gemini_decision": {
            "backend": "gemini_decision",
            "model": "gemini-decision-1",
            "label": "Gemini (gemini-decision-1)",
            "threshold": 0.8,
            "fallback": {"backend": "bedrock", "model": "haiku", "after_s": 1.5},
        },
        "bedrock": {
            "backend": "bedrock",
            "model": "haiku",
            "label": "Claude Haiku (Bedrock)",
            "threshold": 0.65,
            "fallback": None,
        },
    },
}


def test_a_listed_health_offers_exactly_what_it_lists() -> None:
    offers = parse_health(json.dumps(_HEALTH).encode())

    assert offers.state == "listed"
    assert offers.default is not None and offers.default.label == "Open 235B (hosted)"
    assert offers.offers("self_hosted", _SERVER)
    assert offers.offers("gemini", _SERVER)
    # Listed, so DECISION_BEDROCK_ENABLED (off here) is not read.
    assert offers.offers("haiku_bedrock", _SERVER)
    # Not listed: the service can't be asked for Haiku with a workspace key.
    assert not offers.offers("haiku_anthropic", _SERVER)
    self_hosted = offers.info("self_hosted")
    assert self_hosted is not None and self_hosted.label == "Small (self-hosted)"
    gemini = offers.info("gemini")
    assert gemini is not None and gemini.fallback is not None
    assert gemini.fallback.label == "Claude Haiku (Bedrock)"
    assert gemini.fallback.after_s == 1.5


@pytest.mark.parametrize("bedrock", [False, True])
def test_an_unlisted_health_falls_back_to_configuration(bedrock: bool) -> None:
    server = ServerDefault(
        endpoint_url="http://decision.test", api_key=None, bedrock_enabled=bedrock
    )
    offers = parse_health(b'{"ok": true, "backend": "llamacpp"}')

    assert offers.state == "unlisted"
    assert offers.offers("haiku_anthropic", server)
    assert offers.offers("haiku_bedrock", server) is bedrock
    assert not offers.offers("self_hosted", server)
    assert not offers.offers("gemini", server)


@pytest.mark.parametrize(
    "body", [b"", b"[]", b'{"backends": {"default": {"label": "x"}}}', b"not json"]
)
def test_a_body_that_is_not_health_is_refused(body: bytes) -> None:
    with pytest.raises(ValueError):
        parse_health(body)


async def test_the_reader_caches_and_sends_the_server_key() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_HEALTH)

    reader = ServiceOffersReader(
        server=_SERVER,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        cache_seconds=60,
    )
    first = await reader.read()
    second = await reader.read()

    assert first is second and first.state == "listed"
    [request] = seen
    assert str(request.url) == "http://decision.test/health"
    assert request.headers["authorization"] == "Bearer k"


async def test_no_server_default_reads_nothing() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise AssertionError("nothing should be read")

    reader = ServiceOffersReader(
        server=ServerDefault(endpoint_url=None, api_key=None, bedrock_enabled=True),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        cache_seconds=60,
    )
    offers = await reader.read()

    assert offers.state == "no_service"
    assert not offers.offers("haiku_bedrock", _SERVER)
