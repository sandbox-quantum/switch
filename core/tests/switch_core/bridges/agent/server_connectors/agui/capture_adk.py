"""Capture a real AG-UI stream from a real Google ADK agent via ag-ui-adk.

Uses a stub LLM subclassing ADK's own BaseLlm so the capture needs no Google
credentials and does not drift between runs.
"""

import asyncio
import pathlib
import sys
from collections.abc import AsyncGenerator

from ag_ui.core import RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types


class StubLlm(BaseLlm):
    model: str = "stub-model"

    async def generate_content_async(
        self, llm_request, stream=False
    ) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(
            content=types.Content(
                role="model", parts=[types.Part(text="The deploy is green.")]
            )
        )


async def main():
    adk_agent = LlmAgent(name="probe", model=StubLlm(), instruction="Answer briefly.")
    agent = ADKAgent(adk_agent=adk_agent, app_name="probe", user_id="u1")

    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="how is the deploy?")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    frames = []
    async for event in agent.run(run_input):
        frames.append(
            event
            if isinstance(event, str)
            else event.model_dump_json(by_alias=True, exclude_none=True)
        )
    text = "".join(f if f.startswith("data:") else f"data: {f}\n\n" for f in frames)
    pathlib.Path(sys.argv[1]).write_text(text)
    print(f"captured {len(frames)} frames")
    for f in frames[:5]:
        print("  ", f[:110])


asyncio.run(main())
