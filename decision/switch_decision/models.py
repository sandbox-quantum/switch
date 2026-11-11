from typing import Literal

from pydantic import BaseModel, Field


class Agent(BaseModel):
    name: str
    description: str
    role: str | None = None


class Message(BaseModel):
    sender: str
    sender_kind: Literal["person", "agent"] = "person"
    text: str
    # Who this message addressed by name (@mentions or targeted messages).
    addressed: list[str] = Field(default_factory=list)


class Room(BaseModel):
    name: str
    instructions: str | None = None


class Incoming(BaseModel):
    sender: str
    text: str
    thread_id: str | None = None


class DecideRequest(BaseModel):
    room: Room
    message: Incoming
    agents: list[Agent]
    # The thread the message is in (oldest first), empty for a top-level message.
    thread: list[Message] = Field(default_factory=list)
    # Recent top-level messages in the room (oldest first).
    recent: list[Message] = Field(default_factory=list)
    # Per-request override of the configured threshold.
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)


class DecideResponse(BaseModel):
    agent: str | None
    model_choice: str
    confidence: float
    threshold: float
    reason: str
    model: str
    # The backend that answered: the configured one, or the per-request override.
    backend: str
    latency_ms: int
