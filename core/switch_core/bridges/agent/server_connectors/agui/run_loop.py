"""The continuation loop: run, execute tools, run again.

A client-executed tool result cannot be streamed back into the run that asked
for it. AG-UI returns it as a `ToolResultMessage` in the `messages` array of a
*new* run, so a single room turn is a sequence of runs, each carrying the
results of the last, until one completes without asking for anything.

**The loop's bound is ours to choose.** Neither the protocol nor the AG-UI
client SDK defines an iteration cap — `@ag-ui/mcp-middleware` has one, but it
governs its own MCP loop and explicitly hands back rather than managing client
tools. So an agent that calls a tool every turn would otherwise loop until
something else broke. Exhausting the cap raises; it never quietly returns
whatever had accumulated, which would present an abandoned turn as a finished
one.

Text is yielded as it completes rather than accumulated, so a long turn reaches
the room progressively instead of arriving in one lump at the end.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator
from typing import Any

from switch_core.bridges.agent.server_connectors.agui.assembly import (
    RunAssembler,
    RunOutput,
    StateOutput,
    TextOutput,
    ToolCallOutput,
)
from switch_core.bridges.agent.server_connectors.agui.client import AgUiClient
from switch_core.bridges.agent.server_connectors.agui.dispatch import execute_tool_call
from switch_core.bridges.agent.server_connectors.agui.events import AgUiProtocolError
from switch_core.bridges.agent.server_connectors.agui.request import (
    AssistantMessage,
    Context,
    Message,
    RunAgentInput,
    Tool,
    ToolCallFunction,
    ToolCallRef,
)
from switch_core.bridges.agent.server_connectors.agui.state import apply_patch

logger = logging.getLogger(__name__)

DEFAULT_MAX_ITERATIONS = 16


class IterationLimitError(AgUiProtocolError):
    """The agent kept calling tools past the cap, so the turn was abandoned."""


class AgUiRunLoop:
    """Drives one room turn to completion across however many runs it takes."""

    def __init__(
        self,
        *,
        client: AgUiClient,
        tools: list[Tool],
        agent_id: str,
        session_key: str,
        max_iterations: int,
    ) -> None:
        self._client = client
        self._tools = tools
        self._agent_id = agent_id
        self._session_key = session_key
        self._max_iterations = max_iterations
        self.latest_state: Any = None

    async def run(
        self,
        *,
        thread_id: str,
        messages: list[Message],
        context: list[Context],
        state: Any,
    ) -> AsyncIterator[RunOutput]:
        """Yield room-bound output until the agent stops asking for tools.

        The final state is available from `latest_state` once the loop ends.
        """
        working: list[Message] = list(messages)
        self.latest_state = state

        for iteration in range(1, self._max_iterations + 1):
            assembler = RunAssembler()
            tool_calls: list[ToolCallOutput] = []
            spoken: list[str] = []

            request = RunAgentInput(
                thread_id=thread_id,
                run_id=str(uuid.uuid4()),
                messages=working,
                tools=self._tools,
                context=context,
                state=self.latest_state,
            )

            async for event in self._client.run(request):
                for output in assembler.feed(event):
                    if isinstance(output, ToolCallOutput):
                        tool_calls.append(output)
                    elif isinstance(output, StateOutput):
                        self.latest_state = self._fold_state(self.latest_state, output)
                    else:
                        if isinstance(output, TextOutput):
                            spoken.append(output.content)
                        yield output

            assembler.finish()

            if not tool_calls:
                return

            logger.debug(
                "AG-UI agent %s requested %d tool call(s) on iteration %d",
                self._agent_id,
                len(tool_calls),
                iteration,
            )
            working.append(self._assistant_turn(spoken, tool_calls))
            for call in tool_calls:
                working.append(
                    await execute_tool_call(
                        call,
                        agent_id=self._agent_id,
                        session_key=self._session_key,
                    )
                )

        raise IterationLimitError(
            f"AG-UI agent {self._agent_id} was still calling tools after "
            f"{self._max_iterations} runs; the turn was abandoned rather than "
            "left running"
        )

    def _assistant_turn(
        self, spoken: list[str], tool_calls: list[ToolCallOutput]
    ) -> AssistantMessage:
        """Replay the agent's own turn back to it, as AG-UI expects."""
        return AssistantMessage(
            id=f"assistant-{uuid.uuid4()}",
            content="".join(spoken) or None,
            tool_calls=[
                ToolCallRef(
                    id=call.tool_call_id,
                    function=ToolCallFunction(name=call.name, arguments=call.arguments),
                )
                for call in tool_calls
            ],
        )

    def _fold_state(self, current: Any, output: StateOutput) -> Any:
        if output.delta is not None:
            return apply_patch(current, output.delta)
        return output.snapshot
