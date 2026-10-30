"""A machine that serves auto-route's decision model, for tests: its
controller row as its status reports would leave it, its connection held by
a process, and a stand-in for the controller answering `decision.request`
frames with fixed logprobs from a stub model server."""

from __future__ import annotations

import asyncio
import math
import re
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.bridges.agent.protocol.controller_presence import (
    ControllerConnection,
    ControllerPresence,
)
from switch_core.db.models import CONTROLLER_KEY_TYPE, AgentController, ApiKey

MODEL = "qwen3.5-4b-q4_k_m"
MACHINE_NAME = "Studio Mac"

OFFER = {
    "model": MODEL,
    "label": "Qwen3.5-4B",
    "kind": "llamacpp",
    "runtime": "llamacpp-metal",
    "download_bytes": 2_740_000_000,
    "speed": "fast",
}


def status(
    *,
    state: str = "running",
    model: str | None = MODEL,
    capabilities: list[str] | None = None,
    progress: dict[str, int] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """A controller's stored status report, with the decision block."""
    decision: dict[str, Any] = {
        "hardware": {"accelerator": "apple_silicon", "memory_bytes": 25_769_803_776},
        "offered": [OFFER],
        "state": state,
        "model": model,
        "applied_revision": 1,
        "restarts_10m": 0,
        "since": "2026-10-29T09:00:00Z",
    }
    if progress is not None:
        decision["progress"] = progress
    if reason is not None:
        decision["reason"] = reason
    return {
        "seq": 1,
        "controller": {
            "version": "0.9.0",
            "protocol": 2,
            "assignment_revision": 1,
            "capabilities": ["decision.v1"] if capabilities is None else capabilities,
        },
        "decision": decision,
    }


def old_controller_status() -> dict[str, Any]:
    """A controller from before decisions on machines."""
    return {"seq": 1, "controller": {"version": "0.8.0", "protocol": 2}}


async def add_controller(
    session: AsyncSession,
    owner_id: str,
    *,
    name: str = MACHINE_NAME,
    reported: dict[str, Any] | None = None,
) -> AgentController:
    """A machine `owner_id` enrolled in the session's workspace."""
    key = ApiKey(
        user_id=owner_id,
        key_hash=f"hash-{uuid.uuid4()}",
        encrypted_key="",
        label=name,
        type=CONTROLLER_KEY_TYPE,
    )
    session.add(key)
    await session.flush()
    controller = AgentController(
        owner_id=owner_id,
        name=name,
        kind="console",
        api_key_id=key.id,
        status=status() if reported is None else reported,
    )
    session.add(controller)
    await session.flush()
    return controller


def hold(
    presence: ControllerPresence, controller_id: str, tenant_id: str
) -> ControllerConnection:
    """The controller's live connection, held by this process."""
    conn = presence.open(
        controller_id=controller_id, tenant_id=tenant_id, resume_cursors={}
    )
    presence.attach_stream(conn)
    return conn


def letter_for(payload: dict[str, Any], name: str | None) -> str:
    """The option letter the prompt gives `name` (None: nobody)."""
    if name is None:
        return "N"
    prompt = payload["messages"][-1]["content"]
    found = re.search(rf"^([A-M])\) {re.escape(name)}: ", prompt, re.MULTILINE)
    assert found is not None, f"{name} is not an option in the prompt"
    return found.group(1)


def logprobs_body(letter: str, confidence: float) -> dict[str, Any]:
    """What llama-server answers for a one-token completion."""
    other = "N" if letter != "N" else "A"
    return {
        "choices": [
            {
                "logprobs": {
                    "content": [
                        {
                            "token": letter,
                            "top_logprobs": [
                                {"token": letter, "logprob": math.log(confidence)},
                                {"token": other, "logprob": math.log(1 - confidence)},
                            ],
                        }
                    ]
                }
            }
        ]
    }


class FakeMachine:
    """The controller's side of the connection: takes each decision request
    off the socket's urgent queue and answers it as the controller would,
    from a model that picks `pick` with `confidence`, or with `error`."""

    def __init__(self, conn: ControllerConnection) -> None:
        self.conn = conn
        self.pick: str | None = None
        self.confidence = 0.9
        self.error: str | None = None
        self.silent = False
        self.requests: list[dict[str, Any]] = []

    async def serve(self) -> None:
        conn = self.conn
        while True:
            await conn.urgent_ready.wait()
            for frame in conn.take_urgent():
                data = frame["data"]
                self.requests.append(frame)
                if self.silent:
                    continue
                if self.error is not None:
                    answer: dict[str, Any] = {
                        "type": "decision.result",
                        "request_id": data["request_id"],
                        "ok": False,
                        "error": {"code": self.error, "message": "stub"},
                    }
                else:
                    answer = {
                        "type": "decision.result",
                        "request_id": data["request_id"],
                        "ok": True,
                        "body": logprobs_body(
                            letter_for(data["payload"], self.pick), self.confidence
                        ),
                        "model_ms": 412,
                    }
                conn.settle_decision(answer)

    @asynccontextmanager
    async def running(self) -> AsyncIterator[FakeMachine]:
        task = asyncio.create_task(self.serve())
        try:
            yield self
        finally:
            task.cancel()
