"""The decision service: asked which agent, if any, should answer a person's
message that no rule delivered to anyone.

Switch posts the room's context to `DECISION_ENDPOINT_URL` and the service
names one of the candidate agents, or nobody. Which model decides, and how it
is asked, is the service's business: Switch depends only on the contract
below, so the model behind it can change without a Switch release.

Request::

    room:    {name, instructions}
    message: {sender, text, thread_id}
    agents:  [{name, description, role}]
    thread:  [{sender, sender_kind, text, addressed}]   oldest first
    recent:  [{sender, sender_kind, text, addressed}]   oldest first

Response::

    {agent, model_choice, confidence, threshold, reason?, model, latency_ms}

A decision never holds up the room or breaks it, so every way of not getting
an answer means nobody answers: a timeout, a connection error, a response
other than 200, a body that is not the response above. Each is logged as a
warning naming it. A response naming an agent that was not a candidate is
the service breaking its contract, and is logged as an error.
"""

from __future__ import annotations

import logging
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

logger = logging.getLogger(__name__)


class DecisionRoom(BaseModel):
    name: str
    instructions: str | None


class DecisionMessage(BaseModel):
    sender: str
    text: str
    thread_id: str | None


class DecisionAgent(BaseModel):
    name: str
    description: str
    role: str | None


class ContextMessage(BaseModel):
    """An earlier message in the room or the thread: who sent it, whether a
    person or an agent, and whom it addressed by name."""

    sender: str
    sender_kind: Literal["person", "agent"]
    text: str
    addressed: list[str]


class DecisionRequest(BaseModel):
    room: DecisionRoom
    message: DecisionMessage
    agents: list[DecisionAgent]
    thread: list[ContextMessage]
    recent: list[ContextMessage]


class DecisionAnswer(BaseModel):
    """What the service decided. `agent` is None when it picked nobody, or
    its pick fell below its confidence threshold; `model_choice` and
    `confidence` still say what the model chose."""

    model_config = ConfigDict(strict=True, frozen=True)

    agent: str | None
    model_choice: str | None
    confidence: float | None
    threshold: float
    reason: str | None = None
    model: str
    latency_ms: float


class DecisionServiceError(Exception):
    """The service gave no usable answer: it could not be reached, did not
    answer in time, answered with an error, or answered something else than
    a decision."""


class DecisionClient:
    """Posts to the decision service's endpoint. One per process, over one
    shared HTTP client."""

    def __init__(
        self,
        *,
        endpoint_url: str,
        api_key: str | None,
        timeout_seconds: float,
        client: httpx.AsyncClient,
    ) -> None:
        self.endpoint_url = endpoint_url
        self._headers = {"Content-Type": "application/json"}
        if api_key is not None:
            self._headers["Authorization"] = f"Bearer {api_key}"
        self._timeout_seconds = timeout_seconds
        self._client = client

    async def decide(
        self, request: DecisionRequest, *, room_id: str
    ) -> DecisionAnswer | None:
        """The service's decision about `request`, or None when there is no
        usable one, which has been logged."""
        try:
            answer = await self._ask(request)
        except DecisionServiceError as error:
            logger.warning(
                "Decision service gave no answer for a message in room %s, so "
                "no agent receives it: %s",
                room_id,
                error,
            )
            return None
        candidates = [agent.name for agent in request.agents]
        if answer.agent is not None and answer.agent not in candidates:
            logger.error(
                "Decision service at %s named %r for a message in room %s, which "
                "is not one of the candidates %s; no agent receives it",
                self.endpoint_url,
                answer.agent,
                room_id,
                candidates,
            )
            return None
        return answer

    async def _ask(self, request: DecisionRequest) -> DecisionAnswer:
        url = self.endpoint_url
        try:
            response = await self._client.post(
                url,
                json=request.model_dump(mode="json"),
                headers=self._headers,
                timeout=self._timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise DecisionServiceError(
                f"POST {url} did not answer within {self._timeout_seconds}s "
                f"({type(error).__name__})"
            ) from error
        except httpx.HTTPError as error:
            raise DecisionServiceError(
                f"POST {url} could not be reached: {type(error).__name__}: {error}"
            ) from error
        if response.status_code != 200:
            raise DecisionServiceError(
                f"POST {url} answered {response.status_code}: {response.text[:200]}"
            )
        try:
            return DecisionAnswer.model_validate_json(response.content)
        except ValidationError as error:
            raise DecisionServiceError(
                f"POST {url} answered something other than a decision: "
                f"{error.error_count()} problem(s), first: "
                f"{error.errors()[0]['loc']} {error.errors()[0]['msg']}"
            ) from error
