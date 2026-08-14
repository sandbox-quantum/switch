"""Capture a real AG-UI stream from a real LangGraph graph via ag-ui-langgraph.

Uses a deterministic fake chat model so the capture needs no API key and the
fixture does not change between runs.
"""

import asyncio
import pathlib
import sys
from typing import Annotated, TypedDict

from ag_ui.core import RunAgentInput, UserMessage
from ag_ui_langgraph import LangGraphAgent
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages


class S(TypedDict):
    messages: Annotated[list, add_messages]


model = GenericFakeChatModel(messages=iter([AIMessage(content="The deploy is green.")]))


async def respond(state: S):
    return {"messages": [await model.ainvoke(state["messages"])]}


builder = StateGraph(S)
builder.add_node("respond", respond)
builder.add_edge(START, "respond")
builder.add_edge("respond", END)
graph = builder.compile(checkpointer=MemorySaver())


async def main():
    agent = LangGraphAgent(name="probe", graph=graph)
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
    for f in frames[:4]:
        print("  ", f[:120])


asyncio.run(main())
