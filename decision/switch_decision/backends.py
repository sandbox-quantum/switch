"""Model backends: turn a /decide request into one model call and read the answer back."""

import asyncio
import hashlib
import os
from typing import Any

import anthropic
import boto3
import httpx
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from switch_decision.config import Settings
from switch_decision.models import DecideRequest
from switch_decision.prompt import (
    NONE,
    PICK_TOOL,
    SYSTEM,
    build_messages,
    build_state,
    llamacpp_request,
    output_schema,
    pick_tool,
    systemone_request,
)
from switch_decision.readers import (
    ModelAnswer,
    ModelServerError,
    read_bedrock,
    read_letter_logprobs,
    read_ollama,
    read_systemone,
)


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
            f"{where} failed: {type(exc).__name__} {code}".rstrip(),
        ) from exc
    return read_bedrock(body, options)


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
            f"Claude did not call the pick tool (stop_reason={message.stop_reason})"
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
    try:
        message = await anthropic_client(settings, api_key).messages.create(
            **anthropic_request(req, settings)
        )
    except anthropic.APIConnectionError as exc:
        raise ModelServerError(f"Anthropic API unreachable: {exc}") from exc
    except anthropic.APIStatusError as exc:
        raise ModelServerError(
            f"Anthropic API returned {exc.status_code} for {settings.model}: {exc.message}",
            f"Anthropic API returned {exc.status_code} for {settings.model}",
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
        payload, letters = llamacpp_request(req, settings.history_limit)
        url = f"{settings.llamacpp_url}/v1/chat/completions"
        try:
            r = await client.post(url, json=payload, timeout=settings.timeout_s)
        except httpx.HTTPError as exc:
            raise ModelServerError(
                f"model server {url} unreachable: {type(exc).__name__}: {exc}"
            ) from exc
        if r.status_code != 200:
            raise ModelServerError(
                f"model server {url} returned {r.status_code}: {r.text[:300]}",
                f"model server {url} returned {r.status_code}",
            )
        return read_letter_logprobs(r.json(), letters)
    options = [a.name for a in req.agents] + [NONE]
    if settings.backend == "systemone":
        url = settings.systemone_url
        payload = systemone_request(req, settings.model, settings.history_limit)
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
        r = await client.post(url, json=payload, timeout=settings.timeout_s)
    except httpx.HTTPError as exc:
        raise ModelServerError(
            f"model server {url} unreachable: {type(exc).__name__}: {exc}"
        ) from exc
    if r.status_code != 200:
        raise ModelServerError(
            f"model server {url} returned {r.status_code}: {r.text[:300]}",
            f"model server {url} returned {r.status_code}",
        )
    try:
        body = r.json()
    except ValueError as exc:
        raise ModelServerError(f"model server {url} returned non-JSON") from exc
    return (
        read_systemone(body, options)
        if settings.backend == "systemone"
        else read_ollama(body, options)
    )


async def check(client: httpx.AsyncClient, settings: Settings) -> dict:
    """Probe the model server; raise ModelServerError when it is down."""
    if settings.backend == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise ModelServerError("ANTHROPIC_API_KEY is not set")
        return {"status": "api key set"}
    if settings.backend == "bedrock":
        try:
            creds = await asyncio.to_thread(
                lambda: boto3.Session(
                    profile_name=settings.aws_profile
                ).get_credentials()
            )
        except BotoCoreError as exc:
            raise ModelServerError(f"AWS credentials unavailable: {exc}") from exc
        if creds is None:
            raise ModelServerError(
                "AWS credentials unavailable: no profile or environment credentials found"
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
                f"model server {url} unavailable: {type(exc).__name__}: {exc}"
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
            f"model server {url} unavailable: {type(exc).__name__}: {exc}"
        ) from exc
