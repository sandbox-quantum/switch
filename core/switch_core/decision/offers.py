"""What the server's decision service offers workspaces: the backends its
`/health` lists under `backends`, each with its model, the label people see,
the confidence threshold it applies by default and the fallback it switches
to when it is slow.

The gateway reads this when a workspace admin opens, saves or tests Settings →
Message routing (`gateway/decision_settings.py`): a service-run choice is
offered iff the service lists its backend (`SERVICE_BACKENDS`), and Switch
Console names the server default and each choice from it. Deciding a message
never reads it.

The precedence, when the service:

- lists `backends`: that list alone decides what is offered;
  `DECISION_BEDROCK_ENABLED` is not read.
- answers its health route without `backends` (a decision service older than
  this release): Haiku on the Anthropic API is offered, Haiku on Bedrock iff
  `DECISION_BEDROCK_ENABLED`, and nothing else the service runs.
- cannot be read (unreachable, an error status, a body that is not health):
  nothing new is offered; the admin keeps what is saved and is told why.

A reading is kept for `OFFERS_CACHE_SECONDS`, failures too, so an admin
clicking around the page does not probe the service on every request.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

import httpx
from pydantic import BaseModel, ValidationError

from switch_core.decision.settings import SERVICE_BACKENDS, ServerDefault, ServiceChoice
from switch_core.observability.health import (
    DECISION_TIMEOUT_SECONDS,
    decision_health_url,
)

logger = logging.getLogger(__name__)

OFFERS_CACHE_SECONDS = 15.0
# A label or model name longer than this is cut: it is shown in a form.
_MAX_TEXT = 120

OfferState = Literal["listed", "unlisted", "unreadable", "no_service"]


@dataclass(frozen=True)
class FallbackInfo:
    """What a backend falls back to when it has not answered after `after_s`
    seconds. `label` is the fallback backend's own label when the service
    lists it, else its model id."""

    backend: str
    model: str
    label: str
    after_s: float


@dataclass(frozen=True)
class BackendInfo:
    backend: str
    model: str
    label: str
    threshold: float | None
    fallback: FallbackInfo | None


@dataclass(frozen=True)
class ServiceOffers:
    """One reading of the service's `/health`. `backends` is empty unless
    `state` is `listed`; `detail` says why it is `unreadable`."""

    state: OfferState
    backends: Mapping[str, BackendInfo]
    detail: str | None

    @property
    def default(self) -> BackendInfo | None:
        """The server default's entry: what a workspace with no choice uses."""
        return self.backends.get("default")

    def info(self, choice: ServiceChoice) -> BackendInfo | None:
        return self.backends.get(SERVICE_BACKENDS[choice])

    def offers(self, choice: ServiceChoice, server: ServerDefault) -> bool:
        """Whether a workspace may newly choose `choice` (see the module's
        precedence)."""
        if self.state == "listed":
            return SERVICE_BACKENDS[choice] in self.backends
        if self.state == "unlisted":
            if choice == "haiku_anthropic":
                return True
            if choice == "haiku_bedrock":
                return server.bedrock_enabled
        return False


class _Fallback(BaseModel):
    backend: str
    model: str
    after_s: float


class _Entry(BaseModel):
    backend: str
    model: str
    label: str
    threshold: float | None = None
    fallback: _Fallback | None = None


class _Health(BaseModel):
    backends: dict[str, _Entry] | None = None


def _text(value: str) -> str:
    return value.strip()[:_MAX_TEXT]


def parse_health(content: bytes) -> ServiceOffers:
    """The offers in a `/health` body; raises ValueError for a body that is
    not the service's health."""
    try:
        health = _Health.model_validate_json(content)
    except ValidationError as error:
        first = error.errors()[0]
        raise ValueError(
            f"{error.error_count()} problem(s), first: {first['loc']} {first['msg']}"
        ) from error
    if health.backends is None:
        return ServiceOffers(state="unlisted", backends={}, detail=None)
    labels = {name: _text(entry.label) for name, entry in health.backends.items()}
    backends = {
        name: BackendInfo(
            backend=_text(entry.backend),
            model=_text(entry.model),
            label=labels[name],
            threshold=entry.threshold,
            fallback=(
                None
                if entry.fallback is None
                else FallbackInfo(
                    backend=_text(entry.fallback.backend),
                    model=_text(entry.fallback.model),
                    label=labels.get(entry.fallback.backend)
                    or _text(entry.fallback.model),
                    after_s=entry.fallback.after_s,
                )
            ),
        )
        for name, entry in health.backends.items()
    }
    return ServiceOffers(state="listed", backends=backends, detail=None)


async def read_offers(
    client: httpx.AsyncClient, endpoint_url: str, api_key: str | None
) -> ServiceOffers:
    """Read the service's `/health` once. Never raises: a service that
    cannot be read is `unreadable`, with the reason, and logged."""
    url = decision_health_url(endpoint_url)
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def unreadable(detail: str) -> ServiceOffers:
        logger.warning(
            "Could not read which backends the decision service offers from %s: "
            "%s. Workspace admins are offered only what they have saved until it "
            "can be read.",
            url,
            detail,
        )
        return ServiceOffers(state="unreadable", backends={}, detail=detail)

    try:
        response = await client.get(
            url, headers=headers, timeout=DECISION_TIMEOUT_SECONDS
        )
    except httpx.TimeoutException:
        return unreadable(f"no answer within {DECISION_TIMEOUT_SECONDS:.0f}s")
    except httpx.HTTPError as error:
        return unreadable(f"it could not be reached ({type(error).__name__})")
    if response.status_code != 200:
        return unreadable(
            f"its health check answered with status {response.status_code}"
        )
    try:
        return parse_health(response.content)
    except ValueError as error:
        return unreadable(f"its health check answered something else ({error})")


class ServiceOffersReader:
    """The server default service's offers, read through a short cache; one
    reading at a time."""

    def __init__(
        self, *, server: ServerDefault, client: httpx.AsyncClient, cache_seconds: float
    ) -> None:
        self._server = server
        self._client = client
        self._cache_seconds = cache_seconds
        self._cached: tuple[float, ServiceOffers] | None = None
        self._lock = asyncio.Lock()

    async def read(self) -> ServiceOffers:
        endpoint = self._server.endpoint_url
        if endpoint is None:
            return ServiceOffers(state="no_service", backends={}, detail=None)
        async with self._lock:
            now = time.monotonic()
            if self._cached is not None and self._cached[0] > now:
                return self._cached[1]
            offers = await read_offers(self._client, endpoint, self._server.api_key)
            self._cached = (time.monotonic() + self._cache_seconds, offers)
            return offers
