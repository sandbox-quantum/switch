"""The 502 body's `error_kind`: one test per way each backend can fail."""

from types import SimpleNamespace

import anthropic
import httpx
import pytest
from botocore.exceptions import (
    ClientError,
    EndpointConnectionError,
    NoCredentialsError,
    ReadTimeoutError,
)

from switch_decision import backends
from switch_decision.readers import ERROR_KINDS
from tests.helpers import ANTHROPIC_KEY, BODY, SECRET_TEXT, settings_for

ANTHROPIC_HEADERS = {
    "X-Decision-Backend": "anthropic",
    "X-Decision-Anthropic-Key": ANTHROPIC_KEY,
}
BEDROCK_HEADERS = {"X-Decision-Backend": "bedrock"}


def _failed(response: httpx.Response, kind: str) -> None:
    assert response.status_code == 502, response.text
    body = response.json()
    assert body["error_kind"] == kind
    assert body["error_kind"] in ERROR_KINDS
    assert isinstance(body["detail"], str) and body["detail"]


def _raise(exc: Exception):
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    return handler


# ── llama.cpp, SystemOne and Ollama (plain HTTP) ───────────────────────────

HTTP_BACKENDS = [
    settings_for(),
    settings_for(backend="systemone", model="strands-decider-E4B"),
    settings_for(backend="ollama", model="qwen3.5:9b"),
]
HTTP_IDS = ["llamacpp", "systemone", "ollama"]


@pytest.mark.parametrize("settings", HTTP_BACKENDS, ids=HTTP_IDS)
@pytest.mark.parametrize(
    ("handler", "kind"),
    [
        (_raise(httpx.ConnectError("refused")), "model_server_unreachable"),
        (_raise(httpx.ConnectTimeout("no answer")), "model_server_unreachable"),
        (_raise(httpx.ReadError("reset")), "model_server_unreachable"),
        (_raise(httpx.ReadTimeout("slow")), "model_server_timeout"),
        (lambda r: httpx.Response(500, text="boom"), "model_server_error"),
        (lambda r: httpx.Response(502, text="bad gateway"), "model_server_error"),
        (lambda r: httpx.Response(504, text="gateway timeout"), "model_server_timeout"),
        (lambda r: httpx.Response(503, text="Loading model"), "model_unavailable"),
        (lambda r: httpx.Response(404, text="model not found"), "model_unavailable"),
        (lambda r: httpx.Response(401, text="no token"), "backend_refused"),
        (lambda r: httpx.Response(403, text="forbidden"), "backend_refused"),
        (lambda r: httpx.Response(429, text="slow down"), "backend_refused"),
        (lambda r: httpx.Response(200, text="<html>"), "model_server_error"),
        (lambda r: httpx.Response(200, json={"unexpected": 1}), "model_server_error"),
    ],
    ids=[
        "connect-error",
        "connect-timeout",
        "read-error",
        "read-timeout",
        "500",
        "502",
        "504",
        "503-loading",
        "404-model",
        "401",
        "403",
        "429",
        "non-json",
        "garbled",
    ],
)
def test_http_backend_failure_kinds(make_client, settings, handler, kind):
    _failed(make_client(settings, handler=handler).post("/decide", json=BODY), kind)


def test_ollama_output_that_is_not_the_schema_is_model_server_error(make_client):
    tc = make_client(
        settings_for(backend="ollama", model="qwen3.5:9b"),
        handler=lambda r: httpx.Response(200, json={"message": {"content": "hi"}}),
    )
    _failed(tc.post("/decide", json=BODY), "model_server_error")


def test_llamacpp_with_no_option_letter_is_model_server_error(make_client):
    top = [{"token": "Z", "logprob": -0.1}]
    body = {"choices": [{"logprobs": {"content": [{"top_logprobs": top}]}}]}
    tc = make_client(handler=lambda r: httpx.Response(200, json=body))
    _failed(tc.post("/decide", json=BODY), "model_server_error")


def test_error_body_from_the_backend_is_never_logged(make_client, caplog):
    tc = make_client(handler=lambda r: httpx.Response(503, text=f"x {SECRET_TEXT}"))
    with caplog.at_level("DEBUG"):
        _failed(tc.post("/decide", json=BODY), "model_unavailable")
    assert SECRET_TEXT not in caplog.text
    assert "error_kind=model_unavailable" in caplog.text


# ── Anthropic ──────────────────────────────────────────────────────────────


class _Anthropic:
    def __init__(self, outcome):
        self.messages = self
        self._outcome = outcome

    async def create(self, **kw):
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


def _status(cls, status: int) -> anthropic.APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.test/v1/messages")
    return cls("refused", response=httpx.Response(status, request=request), body=None)


_REQUEST = httpx.Request("POST", "https://api.anthropic.test/v1/messages")


@pytest.mark.parametrize(
    ("outcome", "kind"),
    [
        (anthropic.APIConnectionError(request=_REQUEST), "model_server_unreachable"),
        (anthropic.APITimeoutError(request=_REQUEST), "model_server_timeout"),
        (_status(anthropic.AuthenticationError, 401), "backend_refused"),
        (_status(anthropic.PermissionDeniedError, 403), "backend_refused"),
        (_status(anthropic.RateLimitError, 429), "backend_refused"),
        (_status(anthropic.NotFoundError, 404), "model_unavailable"),
        (_status(anthropic.OverloadedError, 529), "model_unavailable"),
        (_status(anthropic.InternalServerError, 500), "model_server_error"),
        (_status(anthropic.BadRequestError, 400), "model_server_error"),
        (anthropic.CredentialsError("no profile"), "credentials_missing"),
        (SimpleNamespace(stop_reason="refusal", content=[]), "backend_refused"),
        (SimpleNamespace(stop_reason="end_turn", content=[]), "model_server_error"),
    ],
    ids=[
        "unreachable",
        "timeout",
        "401",
        "403",
        "429",
        "404-model",
        "529-overloaded",
        "500",
        "400",
        "credentials",
        "refusal",
        "no-tool-call",
    ],
)
def test_anthropic_failure_kinds(make_client, monkeypatch, outcome, kind):
    monkeypatch.setattr(
        backends, "anthropic_client", lambda s, k=None: _Anthropic(outcome)
    )
    r = make_client().post("/decide", json=BODY, headers=ANTHROPIC_HEADERS)
    _failed(r, kind)


def test_anthropic_backend_without_a_service_key_is_credentials_missing(
    make_client, monkeypatch
):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(
        backends,
        "anthropic_client",
        lambda s, k=None: pytest.fail("no call without a key"),
    )
    tc = make_client(settings_for(backend="anthropic", model="claude-haiku-5-5"))
    _failed(tc.post("/decide", json=BODY), "credentials_missing")


# ── Bedrock ────────────────────────────────────────────────────────────────


class _Bedrock:
    def __init__(self, outcome):
        self._outcome = outcome

    def converse(self, **kw):
        if isinstance(self._outcome, Exception):
            raise self._outcome
        return self._outcome


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "m"}}, "Converse")


@pytest.mark.parametrize(
    ("outcome", "kind"),
    [
        (NoCredentialsError(), "credentials_missing"),
        (
            EndpointConnectionError(endpoint_url="https://bedrock.test"),
            "model_server_unreachable",
        ),
        (ReadTimeoutError(endpoint_url="https://bedrock.test"), "model_server_timeout"),
        (_client_error("AccessDeniedException"), "backend_refused"),
        (_client_error("UnrecognizedClientException"), "backend_refused"),
        (_client_error("ThrottlingException"), "backend_refused"),
        (_client_error("ResourceNotFoundException"), "model_unavailable"),
        (_client_error("ModelNotReadyException"), "model_unavailable"),
        (_client_error("ModelTimeoutException"), "model_server_timeout"),
        (_client_error("ValidationException"), "model_server_error"),
        (_client_error("InternalServerException"), "model_server_error"),
        ({"stopReason": "guardrail_intervened", "output": {}}, "backend_refused"),
        ({"stopReason": "end_turn", "output": {}}, "model_server_error"),
    ],
    ids=[
        "no-credentials",
        "unreachable",
        "read-timeout",
        "access-denied",
        "bad-key",
        "throttled",
        "model-not-found",
        "model-not-ready",
        "model-timeout",
        "validation",
        "internal",
        "guardrail",
        "garbled",
    ],
)
def test_bedrock_failure_kinds(make_client, monkeypatch, outcome, kind):
    monkeypatch.setattr(backends, "bedrock_client", lambda s: _Bedrock(outcome))
    tc = make_client(settings_for(bedrock_enabled=True))
    _failed(tc.post("/decide", json=BODY, headers=BEDROCK_HEADERS), kind)


def test_a_failure_body_names_only_kinds_from_the_fixed_set():
    assert set(ERROR_KINDS) == {
        "model_server_unreachable",
        "model_server_timeout",
        "model_server_error",
        "model_unavailable",
        "credentials_missing",
        "backend_refused",
    }
