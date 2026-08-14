"""Generate AG-UI SSE fixtures using the reference Python SDK's own encoder."""

import pathlib
import sys

import ag_ui.core as c
from ag_ui.encoder import EventEncoder

OUT = pathlib.Path(sys.argv[1])
enc = EventEncoder()


def write(name, events):
    OUT.joinpath(name).write_text("".join(enc.encode(e) for e in events))
    print(f"  {name}: {len(events)} events")


write(
    "text_run.sse",
    [
        c.RunStartedEvent(thread_id="t1", run_id="r1"),
        c.TextMessageStartEvent(message_id="m1", role="assistant"),
        c.TextMessageContentEvent(message_id="m1", delta="The deploy "),
        c.TextMessageContentEvent(message_id="m1", delta="is green."),
        c.TextMessageEndEvent(message_id="m1"),
        c.RunFinishedEvent(thread_id="t1", run_id="r1"),
    ],
)

write(
    "tool_call_run.sse",
    [
        c.RunStartedEvent(thread_id="t1", run_id="r1"),
        c.ToolCallStartEvent(tool_call_id="c1", tool_call_name="post_message"),
        c.ToolCallArgsEvent(tool_call_id="c1", delta='{"body":'),
        c.ToolCallArgsEvent(tool_call_id="c1", delta='"done"}'),
        c.ToolCallEndEvent(tool_call_id="c1"),
        c.RunFinishedEvent(thread_id="t1", run_id="r1"),
    ],
)

write(
    "chunk_run.sse",
    [
        c.RunStartedEvent(thread_id="t1", run_id="r1"),
        c.TextMessageChunkEvent(message_id="m1", role="assistant", delta="Chunked "),
        c.TextMessageChunkEvent(delta="output "),
        c.TextMessageChunkEvent(delta="works."),
        c.RunFinishedEvent(thread_id="t1", run_id="r1"),
    ],
)

write(
    "state_and_steps_run.sse",
    [
        c.RunStartedEvent(thread_id="t1", run_id="r1"),
        c.StepStartedEvent(step_name="retrieve"),
        c.StateSnapshotEvent(snapshot={"visited": ["a"]}),
        c.StateDeltaEvent(delta=[{"op": "add", "path": "/visited/-", "value": "b"}]),
        c.StepFinishedEvent(step_name="retrieve"),
        c.TextMessageStartEvent(message_id="m1", role="assistant"),
        c.TextMessageContentEvent(message_id="m1", delta="Looked at a and b."),
        c.TextMessageEndEvent(message_id="m1"),
        c.RunFinishedEvent(thread_id="t1", run_id="r1"),
    ],
)

write(
    "reasoning_run.sse",
    [
        c.RunStartedEvent(thread_id="t1", run_id="r1"),
        c.ReasoningStartEvent(message_id="r1"),
        c.ReasoningMessageStartEvent(message_id="r1", role="reasoning"),
        c.ReasoningMessageContentEvent(message_id="r1", delta="internal deliberation"),
        c.ReasoningMessageEndEvent(message_id="r1"),
        c.ReasoningEndEvent(message_id="r1"),
        c.TextMessageStartEvent(message_id="m1", role="assistant"),
        c.TextMessageContentEvent(message_id="m1", delta="Here is the answer."),
        c.TextMessageEndEvent(message_id="m1"),
        c.RunFinishedEvent(thread_id="t1", run_id="r1"),
    ],
)

write(
    "error_run.sse",
    [
        c.RunStartedEvent(thread_id="t1", run_id="r1"),
        c.RunErrorEvent(message="upstream model unavailable", code="E_UPSTREAM"),
    ],
)

names = sorted(m.value for m in c.EventType)
OUT.joinpath("event_types.txt").write_text("\n".join(names) + "\n")
print(f"  event_types.txt: {len(names)} types")
