"""Replaying real AG-UI streams through the decoder and assembler.

Every fixture in `fixtures/` was **produced by real AG-UI software**, not
written by hand:

- `langgraph_text_run.sse` is a genuine capture from a LangGraph graph driven
  through the `ag-ui-langgraph` adapter (v0.0.42, LangGraph 1.2.11), using a
  deterministic fake chat model so the capture needs no API key. See
  `capture_langgraph.py`.
- `adk_text_run.sse` is a genuine capture from a Google ADK `LlmAgent` driven
  through the `ag-ui-adk` adapter (v0.7.0, google-adk 2.7.0), using a stub
  model subclassing ADK's own `BaseLlm` so it needs no Google credentials. See
  `capture_adk.py`.
- The rest were encoded by the reference Python SDK's own `EventEncoder`
  (`ag-ui-protocol` 0.1.19). See `generate_fixtures.py`.

The two framework captures are what make the ticket's central claim testable:
one client, two frameworks that share no code, neither knowing Switch exists.

That distinction matters. Switch hand-rolls its AG-UI types because no Python
client exists to depend on, and the wire carries no version — so a
hand-written fixture would only ever prove our decoder agrees with our own
assumptions. These prove it agrees with the software that will actually be on
the other end.

Neither generator runs in CI, and neither is a dependency of the test suite:
the fixtures are committed, so this whole file runs offline on every pull
request. Regenerating them needs the scripts and a throwaway virtualenv.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from switch_core.bridges.agent.server_connectors.agui.assembly import (
    RunAssembler,
    RunFailedError,
    StateOutput,
    StatusOutput,
    TextOutput,
    ToolCallOutput,
)
from switch_core.bridges.agent.server_connectors.agui.events import (
    DEPRECATED_ALIASES,
    EventType,
    parse_event,
)
from switch_core.bridges.agent.server_connectors.agui.sse import (
    SseDecoder,
    decode_json_frame,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _replay(name: str) -> list[Any]:
    """Decode a fixture exactly as the client would, and assemble it."""
    decoder = SseDecoder()
    assembler = RunAssembler()
    outputs: list[Any] = []

    raw = (FIXTURES / name).read_text()
    # Feed in small slices so frame boundaries land mid-JSON, as they do on a
    # real socket.
    for index in range(0, len(raw), 17):
        for payload in decoder.feed(raw[index : index + 17]):
            outputs.extend(assembler.feed(parse_event(decode_json_frame(payload))))
    for payload in decoder.close():
        outputs.extend(assembler.feed(parse_event(decode_json_frame(payload))))

    assembler.finish()
    return outputs


def _event_types(name: str) -> list[str]:
    return [
        json.loads(line[len("data: ") :])["type"]
        for line in (FIXTURES / name).read_text().splitlines()
        if line.startswith("data: ")
    ]


# ── The real LangGraph capture ────────────────────────────────────────────────


def test_a_real_langgraph_run_assembles_into_one_room_message() -> None:
    outputs = _replay("langgraph_text_run.sse")
    texts = [output for output in outputs if isinstance(output, TextOutput)]

    assert len(texts) == 1
    assert texts[0].content == "The deploy is green."


def test_the_real_capture_streams_text_as_many_deltas() -> None:
    # Seven TEXT_MESSAGE_CONTENT events for one short sentence. Relaying those
    # to a room individually would post seven fragments; buffering them into
    # one message is the whole reason the assembler exists.
    types = _event_types("langgraph_text_run.sse")
    assert types.count("TEXT_MESSAGE_CONTENT") > 3


def test_the_real_capture_is_mostly_events_we_ignore() -> None:
    # LangGraph emits RAW passthrough heavily — more RAW than anything else.
    # Ignoring unknown and uninteresting events is not a nicety here.
    types = _event_types("langgraph_text_run.sse")
    assert types.count("RAW") > types.count("TEXT_MESSAGE_CONTENT")


def test_raw_and_snapshots_never_reach_the_room() -> None:
    outputs = _replay("langgraph_text_run.sse")
    assert not any(isinstance(output, ToolCallOutput) for output in outputs)
    for output in outputs:
        assert isinstance(output, (TextOutput, StatusOutput, StateOutput))


def test_every_frame_in_the_real_capture_parses() -> None:
    # Not "we handle all of them" — we deliberately do not — but that no frame
    # a real adapter emits makes the parser fall over. Parsed as sent, whole
    # payload and all, because a bare type would omit required fields and prove
    # nothing about real traffic.
    frames = [
        json.loads(line[len("data: ") :])
        for line in (FIXTURES / "langgraph_text_run.sse").read_text().splitlines()
        if line.startswith("data: ")
    ]
    assert frames
    for frame in frames:
        assert parse_event(frame).type == frame["type"]


# ── The real Google ADK capture ───────────────────────────────────────────────


def test_a_real_adk_run_assembles_into_one_room_message() -> None:
    outputs = _replay("adk_text_run.sse")
    texts = [output for output in outputs if isinstance(output, TextOutput)]

    assert len(texts) == 1
    assert texts[0].content == "The deploy is green."


def test_adk_carries_its_own_bookkeeping_in_state_not_into_the_room() -> None:
    # ADK puts its thread/app/user identifiers in a STATE_SNAPSHOT. That is the
    # agent's memory, not conversation, and must not surface as a message.
    outputs = _replay("adk_text_run.sse")
    states = [output for output in outputs if isinstance(output, StateOutput)]

    assert states
    assert any("_ag_ui_thread_id" in (state.snapshot or {}) for state in states)


def test_two_unrelated_frameworks_produce_the_same_room_output() -> None:
    # The ticket's actual claim, as a test. LangGraph and ADK share no code and
    # neither knows Switch exists, yet one client turns both into one message.
    langgraph = [
        o for o in _replay("langgraph_text_run.sse") if isinstance(o, TextOutput)
    ]
    adk = [o for o in _replay("adk_text_run.sse") if isinstance(o, TextOutput)]

    assert [output.content for output in langgraph] == [
        output.content for output in adk
    ]


# ── Streams encoded by the reference SDK ──────────────────────────────────────


def test_reference_text_run() -> None:
    assert _replay("text_run.sse") == [
        TextOutput(message_id="m1", role="assistant", content="The deploy is green.")
    ]


def test_reference_tool_call_run() -> None:
    assert _replay("tool_call_run.sse") == [
        ToolCallOutput(
            tool_call_id="c1", name="post_message", arguments='{"body":"done"}'
        )
    ]


def test_reference_chunk_run() -> None:
    # The chunk shape as the reference encoder actually emits it.
    assert _replay("chunk_run.sse") == [
        TextOutput(message_id="m1", role="assistant", content="Chunked output works.")
    ]


def test_reference_state_run_applies_its_delta() -> None:
    outputs = _replay("state_and_steps_run.sse")
    states = [output for output in outputs if isinstance(output, StateOutput)]

    assert states[0].snapshot == {"visited": ["a"]}
    assert states[1].delta == [{"op": "add", "path": "/visited/-", "value": "b"}]


def test_reference_reasoning_run_keeps_deliberation_out_of_the_room() -> None:
    outputs = _replay("reasoning_run.sse")
    assert outputs == [
        TextOutput(message_id="m1", role="assistant", content="Here is the answer.")
    ]


def test_reference_error_run_raises_with_the_agents_message() -> None:
    with pytest.raises(RunFailedError, match="upstream model unavailable"):
        _replay("error_run.sse")


# ── The taxonomy, pinned against the reference SDK ────────────────────────────


def test_our_event_taxonomy_matches_the_reference_sdk() -> None:
    # `event_types.txt` is the reference SDK's own EventType enum, dumped at
    # 0.1.19. If AG-UI adds or removes an event, regenerating the fixtures
    # fails here rather than leaving us quietly behind.
    reference = {
        line.strip()
        for line in (FIXTURES / "event_types.txt").read_text().splitlines()
        if line.strip()
    }
    ours = {member.value for member in EventType} | set(DEPRECATED_ALIASES)

    assert ours == reference, {
        "missing from Switch": sorted(reference - ours),
        "unknown to the SDK": sorted(ours - reference),
    }


def test_the_reference_sdk_defines_thirty_three_events() -> None:
    reference = [
        line for line in (FIXTURES / "event_types.txt").read_text().splitlines() if line
    ]
    assert len(reference) == 33
