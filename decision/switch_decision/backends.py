"""Model backends: turn a /decide request into one model call and read the answer back."""

import asyncio
import hashlib
import json
import math
import os
from dataclasses import dataclass
from typing import Any, Literal, get_args

import anthropic
import boto3
import httpx
from botocore.config import Config
from botocore.exceptions import (
    BotoCoreError,
    ClientError,
    ConnectTimeoutError,
    CredentialRetrievalError,
    EndpointConnectionError,
    NoCredentialsError,
    PartialCredentialsError,
    ProfileNotFound,
    ReadTimeoutError,
    SSOError,
    TokenRetrievalError,
)

from switch_decision.config import Settings
from switch_decision.models import DecideRequest
from switch_decision.prompt import (
    NONE,
    PICK_TOOL,
    SPEAKER_QUESTION,
    SYSTEM,
    build_messages,
    build_state,
    letter_messages,
    output_schema,
    pick_tool,
    systemone_request,
)

# Why a model call failed, as the 502 body's `error_kind`. switch-core counts
# failures by it and reads nothing else from the body, so the set is fixed.
ErrorKind = Literal[
    "model_server_unreachable",
    "model_server_timeout",
    "model_server_error",
    "model_unavailable",
    "credentials_missing",
    "backend_refused",
]
ERROR_KINDS: tuple[str, ...] = get_args(ErrorKind)


class ModelServerError(Exception):
    """The model server could not be reached or gave an answer we cannot use.

    `kind` classifies the failure. `log_text` is what the service logs: the same
    as the message, minus anything the backend sent back (an error body could
    echo room content)."""

    def __init__(self, message: str, *, kind: ErrorKind, log_text: str | None = None):
        super().__init__(message)
        self.kind = kind
        self.log_text = log_text if log_text is not None else message


def kind_of_status(status: int) -> ErrorKind:
    """An HTTP error status from a model server or API, classified."""
    if status in (401, 403, 429):
        return "backend_refused"
    if status in (404, 503, 529):
        # Ollama answers 404 for a model it has not pulled, llama.cpp 503
        # while its model is still loading, Anthropic 529 when overloaded.
        return "model_unavailable"
    if status == 504:
        return "model_server_timeout"
    return "model_server_error"


def kind_of_httpx_error(exc: httpx.HTTPError) -> ErrorKind:
    if isinstance(exc, httpx.ConnectTimeout | httpx.NetworkError):
        return "model_server_unreachable"
    if isinstance(exc, httpx.TimeoutException):
        return "model_server_timeout"
    if isinstance(exc, httpx.HTTPStatusError):
        return kind_of_status(exc.response.status_code)
    return "model_server_error"


_AWS_CREDENTIAL_ERRORS = (
    NoCredentialsError,
    PartialCredentialsError,
    CredentialRetrievalError,
    ProfileNotFound,
    TokenRetrievalError,
    SSOError,
)

_BEDROCK_REFUSED = {
    "AccessDeniedException",
    "UnrecognizedClientException",
    "ExpiredTokenException",
    "InvalidSignatureException",
    "ThrottlingException",
    "ServiceQuotaExceededException",
}
_BEDROCK_UNAVAILABLE = {"ResourceNotFoundException", "ModelNotReadyException"}

# What a Converse answer says when a guardrail or content filter stopped it.
_BEDROCK_REFUSAL_STOPS = {"guardrail_intervened", "content_filtered"}


def kind_of_bedrock_error(exc: BotoCoreError | ClientError) -> ErrorKind:
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        if code in _BEDROCK_REFUSED:
            return "backend_refused"
        if code in _BEDROCK_UNAVAILABLE:
            return "model_unavailable"
        if code == "ModelTimeoutException":
            return "model_server_timeout"
        return "model_server_error"
    if isinstance(exc, _AWS_CREDENTIAL_ERRORS):
        return "credentials_missing"
    if isinstance(exc, ConnectTimeoutError | EndpointConnectionError):
        return "model_server_unreachable"
    if isinstance(exc, ReadTimeoutError):
        return "model_server_timeout"
    return "model_server_error"


class InvalidChoiceError(ModelServerError):
    """The model answered, but named something that is not one of the options.

    The API turns this into "no agent" rather than a failure: the backend worked,
    its answer just can't be routed."""

    def __init__(self, choice: object, confidence: float = 0.0):
        super().__init__(
            f"model chose {choice!r}, which is not one of the options",
            kind="model_server_error",
        )
        self.choice = str(choice)
        self.confidence = confidence


def _confidence_of(value: object) -> float:
    try:
        c = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return c if 0.0 <= c <= 1.0 else 0.0


@dataclass(frozen=True)
class ModelAnswer:
    choice: str
    confidence: float
    reason: str


def read_systemone(body: object, options: list[str]) -> ModelAnswer:
    """Map a SystemOne response to a choice and the chosen option's probability."""
    try:
        answer = body["answers"][SPEAKER_QUESTION]  # type: ignore[index]
        choice = answer["choice"]
        probabilities = answer.get("probabilities") or {}
    except (KeyError, TypeError) as exc:
        raise ModelServerError(
            f"SystemOne response has no '{SPEAKER_QUESTION}' answer",
            kind="model_server_error",
        ) from exc
    if choice not in options:
        raise InvalidChoiceError(
            choice, _confidence_of(probabilities.get(choice, answer.get("confidence")))
        )
    confidence = probabilities.get(choice, answer.get("confidence"))
    if not isinstance(confidence, (int, float)):
        raise ModelServerError(
            f"SystemOne response has no probability for {choice!r}",
            kind="model_server_error",
        )
    top = sorted(probabilities.items(), key=lambda kv: kv[1], reverse=True)[:3]
    reason = (
        "probabilities: " + ", ".join(f"{k}={v:.2f}" for k, v in top) if top else ""
    )
    return ModelAnswer(choice=choice, confidence=float(confidence), reason=reason)


def read_ollama(body: object, options: list[str]) -> ModelAnswer:
    try:
        content = body["message"]["content"]  # type: ignore[index]
        out = json.loads(content)
        choice, confidence, reason = (
            out["agent"],
            float(out["confidence"]),
            out.get("reason", ""),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ModelServerError(
            "Ollama output was not the expected JSON", kind="model_server_error"
        ) from exc
    if choice not in options:
        raise InvalidChoiceError(choice, _confidence_of(confidence))
    return ModelAnswer(choice=choice, confidence=confidence, reason=reason)


def read_bedrock(body: dict, options: list[str]) -> ModelAnswer:
    """Map a Converse response whose message calls the pick tool."""
    try:
        blocks = body["output"]["message"]["content"]
        call = next(
            b["toolUse"]
            for b in blocks
            if "toolUse" in b and b["toolUse"]["name"] == PICK_TOOL
        )
        out = call["input"]
        choice, confidence, reason = (
            out["agent"],
            float(out["confidence"]),
            out.get("reason", ""),
        )
    except (KeyError, TypeError, ValueError, StopIteration) as exc:
        raise ModelServerError(
            "Bedrock response did not call the pick tool with a decision",
            kind="model_server_error",
        ) from exc
    if choice not in options:
        raise InvalidChoiceError(choice, _confidence_of(confidence))
    if not 0.0 <= confidence <= 1.0:
        raise ModelServerError(
            f"model gave confidence {confidence}, outside 0 to 1",
            kind="model_server_error",
        )
    return ModelAnswer(choice=choice, confidence=confidence, reason=reason)


def _is_claude(model_id: str) -> bool:
    return "anthropic." in model_id or model_id.startswith("claude")


def bedrock_request(req: DecideRequest, settings: Settings) -> dict:
    names = [a.name for a in req.agents]
    body: dict[str, Any] = {
        "modelId": settings.model,
        "system": [{"text": SYSTEM}],
        "messages": [
            {
                "role": "user",
                "content": [{"text": build_state(req, settings.history_limit)}],
            }
        ],
        "inferenceConfig": {"temperature": 0, "maxTokens": 200},
        "toolConfig": {
            "tools": [pick_tool(names)],
            "toolChoice": {"tool": {"name": PICK_TOOL}},
        },
    }
    if _is_claude(settings.model):
        # Haiku 5.5 refuses a non-default temperature, and thinks by default:
        # turn thinking off so the forced tool call is the whole answer.
        body["inferenceConfig"] = {"maxTokens": 256}
        body["additionalModelRequestFields"] = {"thinking": {"type": "disabled"}}
    return body


_bedrock_clients: dict[tuple[str, str | None], Any] = {}


def bedrock_client(settings: Settings) -> Any:
    key = (settings.aws_region, settings.aws_profile)
    if key not in _bedrock_clients:
        session = boto3.Session(
            profile_name=settings.aws_profile, region_name=settings.aws_region
        )
        _bedrock_clients[key] = session.client(
            "bedrock-runtime",
            config=Config(
                read_timeout=settings.timeout_s,
                connect_timeout=5,
                retries={"max_attempts": 2},
            ),
        )
    return _bedrock_clients[key]


async def ask_bedrock(settings: Settings, req: DecideRequest) -> ModelAnswer:
    options = [a.name for a in req.agents] + [NONE]
    where = f"Bedrock {settings.model} in {settings.aws_region}"
    try:
        body = await asyncio.to_thread(
            bedrock_client(settings).converse, **bedrock_request(req, settings)
        )
    except (BotoCoreError, ClientError) as exc:
        code = (
            exc.response.get("Error", {}).get("Code", "")
            if isinstance(exc, ClientError)
            else ""
        )
        raise ModelServerError(
            f"{where} failed: {type(exc).__name__}: {exc}",
            kind=kind_of_bedrock_error(exc),
            log_text=f"{where} failed: {type(exc).__name__} {code}".rstrip(),
        ) from exc
    stop = body.get("stopReason")
    if stop in _BEDROCK_REFUSAL_STOPS:
        raise ModelServerError(
            f"{where} declined to answer (stopReason={stop})", kind="backend_refused"
        )
    return read_bedrock(body, options)


def read_letter_logprobs(body: dict, options: dict[str, str]) -> ModelAnswer:
    """Probabilities over the option letters from the first token's top logprobs,
    renormalised over the letters that are options."""
    try:
        top = body["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelServerError(
            "llama.cpp response has no top logprobs for the first token",
            kind="model_server_error",
        ) from exc
    mass: dict[str, float] = {}
    for t in top:
        letter = t["token"].strip()
        if letter in options:
            mass[letter] = mass.get(letter, 0.0) + math.exp(t["logprob"])
    total = sum(mass.values())
    if total <= 0:
        raise ModelServerError(
            "the model put no probability on any option letter",
            kind="model_server_error",
        )
    probs = {options[k]: v / total for k, v in mass.items()}
    choice = max(probs, key=probs.get)
    ranked = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)[:3]
    return ModelAnswer(
        choice=choice,
        confidence=probs[choice],
        reason="probabilities: " + ", ".join(f"{k}={v:.2f}" for k, v in ranked),
    )


def anthropic_request(req: DecideRequest, settings: Settings) -> dict:
    """One Messages API call whose forced tool call is the decision. Haiku 5.5
    takes no temperature; thinking is off and effort low, for a fast pick."""
    names = [a.name for a in req.agents]
    schema = {**output_schema(names), "additionalProperties": False}
    # Strict tools don't take numeric bounds; the range is stated instead and
    # read_bedrock refuses a value outside it.
    schema["properties"] = {
        **schema["properties"],
        "confidence": {"type": "number", "description": "0 to 1"},
    }
    if not settings.with_reason:
        schema["properties"] = {
            k: v for k, v in schema["properties"].items() if k != "reason"
        }
        schema["required"] = [k for k in schema["required"] if k != "reason"]
    return {
        "model": settings.model,
        "max_tokens": 256,
        "system": SYSTEM,
        "messages": [
            {"role": "user", "content": build_state(req, settings.history_limit)}
        ],
        "tools": [
            {
                "name": PICK_TOOL,
                "description": "Record which agent, if any, should answer the latest message.",
                "input_schema": schema,
                "strict": True,
            }
        ],
        "tool_choice": {"type": "tool", "name": PICK_TOOL},
        "thinking": {"type": "disabled"},
        "output_config": {"effort": "low"},
    }


def read_anthropic(message: Any, options: list[str]) -> ModelAnswer:
    block = next(
        (b for b in message.content if b.type == "tool_use" and b.name == PICK_TOOL),
        None,
    )
    if block is None:
        raise ModelServerError(
            f"Claude did not call the pick tool (stop_reason={message.stop_reason})",
            kind="backend_refused"
            if message.stop_reason == "refusal"
            else "model_server_error",
        )
    return read_bedrock(
        {
            "output": {
                "message": {
                    "content": [{"toolUse": {"name": PICK_TOOL, "input": block.input}}]
                }
            }
        },
        options,
    )


# One client per API key, cached by a hash of the key so the raw key is never
# a dict key that could end up in a log or a traceback.
_anthropic_clients: dict[str, anthropic.AsyncAnthropic] = {}
_SERVICE_KEY = "service"


def key_fingerprint(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()


def anthropic_client(
    settings: Settings, api_key: str | None = None
) -> anthropic.AsyncAnthropic:
    """The client for a per-request key, or the service-wide one (ANTHROPIC_API_KEY)."""
    cache_key = key_fingerprint(api_key) if api_key else _SERVICE_KEY
    client = _anthropic_clients.get(cache_key)
    if client is None:
        kwargs: dict[str, Any] = {"timeout": settings.timeout_s, "max_retries": 1}
        if api_key:
            kwargs["api_key"] = api_key
        client = anthropic.AsyncAnthropic(**kwargs)
        _anthropic_clients[cache_key] = client
    return client


async def ask_anthropic(
    settings: Settings, req: DecideRequest, api_key: str | None = None
) -> ModelAnswer:
    options = [a.name for a in req.agents] + [NONE]
    if api_key is None and not os.environ.get("ANTHROPIC_API_KEY"):
        raise ModelServerError(
            "ANTHROPIC_API_KEY is not set", kind="credentials_missing"
        )
    try:
        message = await anthropic_client(settings, api_key).messages.create(
            **anthropic_request(req, settings)
        )
    except anthropic.CredentialsError as exc:
        raise ModelServerError(
            f"Anthropic credentials unavailable: {exc}", kind="credentials_missing"
        ) from exc
    except anthropic.APITimeoutError as exc:
        raise ModelServerError(
            f"Anthropic API timed out: {exc}", kind="model_server_timeout"
        ) from exc
    except anthropic.APIConnectionError as exc:
        raise ModelServerError(
            f"Anthropic API unreachable: {exc}", kind="model_server_unreachable"
        ) from exc
    except anthropic.APIStatusError as exc:
        raise ModelServerError(
            f"Anthropic API returned {exc.status_code} for {settings.model}: {exc.message}",
            kind=kind_of_status(exc.status_code),
            log_text=f"Anthropic API returned {exc.status_code} for {settings.model}",
        ) from exc
    return read_anthropic(message, options)


def model_server(settings: Settings) -> str:
    if settings.backend == "bedrock":
        return f"bedrock:{settings.aws_region}"
    if settings.backend == "llamacpp":
        return settings.llamacpp_url
    if settings.backend == "anthropic":
        return "api.anthropic.com"
    return (
        settings.systemone_url
        if settings.backend == "systemone"
        else settings.ollama_url
    )


def model_server_headers(settings: Settings) -> dict[str, str]:
    """The llama.cpp or SystemOne server's bearer token, when one is set. The
    headers are never logged."""
    if settings.model_server_token is None:
        return {}
    return {"Authorization": f"Bearer {settings.model_server_token}"}


async def ask(
    client: httpx.AsyncClient,
    settings: Settings,
    req: DecideRequest,
    anthropic_key: str | None = None,
) -> ModelAnswer:
    if settings.backend == "bedrock":
        return await ask_bedrock(settings, req)
    if settings.backend == "anthropic":
        return await ask_anthropic(settings, req, anthropic_key)
    if settings.backend == "llamacpp":
        messages, letters = letter_messages(req, settings.history_limit)
        url = f"{settings.llamacpp_url}/v1/chat/completions"
        payload = {
            "messages": messages,
            "max_tokens": 1,
            "temperature": 0,
            "logprobs": True,
            "top_logprobs": 20,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        try:
            r = await client.post(
                url,
                json=payload,
                headers=model_server_headers(settings),
                timeout=settings.timeout_s,
            )
        except httpx.HTTPError as exc:
            raise ModelServerError(
                f"model server {url} unreachable: {type(exc).__name__}: {exc}",
                kind=kind_of_httpx_error(exc),
            ) from exc
        if r.status_code != 200:
            raise ModelServerError(
                f"model server {url} returned {r.status_code}: {r.text[:300]}",
                kind=kind_of_status(r.status_code),
                log_text=f"model server {url} returned {r.status_code}",
            )
        try:
            body = r.json()
        except ValueError as exc:
            raise ModelServerError(
                f"model server {url} returned non-JSON", kind="model_server_error"
            ) from exc
        return read_letter_logprobs(body, letters)
    options = [a.name for a in req.agents] + [NONE]
    headers: dict[str, str] = {}
    if settings.backend == "systemone":
        url = settings.systemone_url
        payload = systemone_request(req, settings.model, settings.history_limit)
        headers = model_server_headers(settings)
    else:
        url = f"{settings.ollama_url}/api/chat"
        payload = {
            "model": settings.model,
            "messages": build_messages(req, settings.history_limit),
            "format": output_schema([a.name for a in req.agents]),
            "think": False,
            "stream": False,
            "options": {"temperature": 0},
        }
    try:
        r = await client.post(
            url, json=payload, headers=headers, timeout=settings.timeout_s
        )
    except httpx.HTTPError as exc:
        raise ModelServerError(
            f"model server {url} unreachable: {type(exc).__name__}: {exc}",
            kind=kind_of_httpx_error(exc),
        ) from exc
    if r.status_code != 200:
        raise ModelServerError(
            f"model server {url} returned {r.status_code}: {r.text[:300]}",
            kind=kind_of_status(r.status_code),
            log_text=f"model server {url} returned {r.status_code}",
        )
    try:
        body = r.json()
    except ValueError as exc:
        raise ModelServerError(
            f"model server {url} returned non-JSON", kind="model_server_error"
        ) from exc
    return (
        read_systemone(body, options)
        if settings.backend == "systemone"
        else read_ollama(body, options)
    )


async def check(client: httpx.AsyncClient, settings: Settings) -> dict:
    """Probe the model server; raise ModelServerError when it is down."""
    if settings.backend == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise ModelServerError(
                "ANTHROPIC_API_KEY is not set", kind="credentials_missing"
            )
        return {"status": "api key set"}
    if settings.backend == "bedrock":
        try:
            creds = await asyncio.to_thread(
                lambda: boto3.Session(
                    profile_name=settings.aws_profile
                ).get_credentials()
            )
        except BotoCoreError as exc:
            raise ModelServerError(
                f"AWS credentials unavailable: {exc}", kind="credentials_missing"
            ) from exc
        if creds is None:
            raise ModelServerError(
                "AWS credentials unavailable: no profile or environment credentials found",
                kind="credentials_missing",
            )
        return {"status": "credentials found", "region": settings.aws_region}
    if settings.backend == "llamacpp":
        url = f"{settings.llamacpp_url}/health"
        try:
            r = await client.get(url, timeout=5)
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ModelServerError(
                f"model server {url} unavailable: {type(exc).__name__}: {exc}",
                kind=kind_of_httpx_error(exc)
                if isinstance(exc, httpx.HTTPError)
                else "model_server_error",
            ) from exc
    if settings.backend == "systemone":
        base = settings.systemone_url.rsplit("/v1/", 1)[0]
        url = f"{base}/health"
    else:
        url = f"{settings.ollama_url}/api/version"
    try:
        r = await client.get(url, timeout=5)
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ModelServerError(
            f"model server {url} unavailable: {type(exc).__name__}: {exc}",
            kind=kind_of_httpx_error(exc)
            if isinstance(exc, httpx.HTTPError)
            else "model_server_error",
        ) from exc
