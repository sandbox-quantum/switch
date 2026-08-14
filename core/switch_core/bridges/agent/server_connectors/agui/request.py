"""The client→server half of the AG-UI wire contract.

Switch is the AG-UI *client*, so this is what Switch sends: a `RunAgentInput`
carrying the conversation so far, the tools Switch will execute on the agent's
behalf, and whatever state the agent asked to keep.

Serialise with ``model_dump(by_alias=True)`` — the wire is camelCase.

One asymmetry is deliberate. `state` and `forwarded_props` are always emitted,
including as ``null``, because the two reference SDKs disagree about whether
the keys may be absent: the TypeScript schema treats them as optional, the
Python one requires the key to be present. Emitting them always satisfies both,
and costs two nulls.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class WireModel(BaseModel):
    """Base for everything that goes out on the wire."""

    model_config = ConfigDict(populate_by_name=True)


class Tool(WireModel):
    """A tool Switch executes on the agent's behalf.

    AG-UI reserves `RunAgentInput.tools` for client-executed tools specifically
    — not the agent's own backend tools — which is exactly what a Switch room
    operation is.
    """

    name: str
    description: str
    parameters: dict[str, Any]


class Context(WireModel):
    """A labelled piece of ambient context, outside the message history."""

    description: str
    value: str


class ToolCallFunction(WireModel):
    name: str
    arguments: str


class ToolCallRef(WireModel):
    """An assistant's request to call a tool, as replayed back in history."""

    id: str
    type: Literal["function"] = "function"
    function: ToolCallFunction


class UserMessage(WireModel):
    id: str
    role: Literal["user"] = "user"
    content: str
    name: str | None = None


class SystemMessage(WireModel):
    id: str
    role: Literal["system"] = "system"
    content: str


class AssistantMessage(WireModel):
    id: str
    role: Literal["assistant"] = "assistant"
    content: str | None = None
    tool_calls: list[ToolCallRef] | None = Field(
        default=None, serialization_alias="toolCalls"
    )


class ToolResultMessage(WireModel):
    """The result of a tool Switch executed, returned on the next run.

    `error` is what distinguishes a tool that failed from one that returned
    nothing interesting. Omitting it on failure makes the two identical to the
    agent, which is how a model ends up confidently reporting success.
    """

    id: str
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str = Field(serialization_alias="toolCallId")
    error: str | None = None


Message = UserMessage | SystemMessage | AssistantMessage | ToolResultMessage


class RunAgentInput(WireModel):
    """One AG-UI run request."""

    thread_id: str = Field(serialization_alias="threadId")
    run_id: str = Field(serialization_alias="runId")
    messages: list[Message]
    tools: list[Tool]
    context: list[Context]
    state: Any = None
    forwarded_props: Any = Field(default=None, serialization_alias="forwardedProps")
