"""The office-view mapping, replayed over frames recorded from a real room.

The fixtures are the gateway's two streams for a Slack-bridged room with three
agents, recorded while a person asked Atlas to research (three subagents),
Nova to build (two approvals, answered in Slack) and Pixel for a name.

    uv run --with pytest pytest scripts/office-view/tests
"""

from __future__ import annotations

import copy
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from mapping import Mapper, clip, signal_kind, strip_mentions, tool_words  # noqa: E402

ROOM = "ea3e946c-f078-4f6b-b3d9-09509c207e65"
ATLAS, NOVA, PIXEL = (
    "aa05b629-ccca-4402-98cf-0b7d455bbbd6",
    "68473d41-6f7c-4abc-8c76-8889427118b0",
    "d29e27ce-3cfa-4df1-a8a9-a3b6df18d1b8",
)
AGENTS = {ATLAS: "Atlas", NOVA: "Nova", PIXEL: "Pixel"}


def frames() -> list[dict]:
    rows = []
    for name in ("activity.jsonl", "chat.jsonl"):
        rows += [
            json.loads(line)
            for line in (HERE.parent / "fixtures" / name).read_text().splitlines()
            if line
        ]
    return sorted(rows, key=lambda r: r["at"])


def feed(mapper: Mapper, rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        if row["event"] == "activity":
            out += mapper.activity(row["data"])
        elif row["event"] == "approval":
            out += mapper.approval(row["data"])
        elif row["event"] == "message":
            out += mapper.message(row["data"])
    return out


def session_of(mapper: Mapper, agent_id: str) -> str:
    return mapper.desks[agent_id].session


def test_every_agent_gets_a_named_desk_up_front():
    mapper = Mapper(ROOM, AGENTS)
    out = mapper.open_desks()
    assert [e["project"] for e in out] == ["Atlas", "Nova", "Pixel"]
    assert all(e["type"] == "session_started" for e in out)
    assert len({e["sessionId"] for e in out}) == 3


def test_recorded_room_plays_as_the_office_should():
    mapper = Mapper(ROOM, AGENTS)
    mapper.open_desks()
    out = feed(mapper, frames())
    atlas, nova = session_of(mapper, ATLAS), session_of(mapper, NOVA)
    kinds = Counter((e["type"], e["sessionId"]) for e in out)

    prompts = [e for e in out if e["type"] == "session_prompt"]
    assert [p["sessionId"] for p in prompts] == [atlas, nova]
    assert prompts[0]["text"].startswith("atlas we want to launch a public status page")
    assert not any("@" in p["text"] for p in prompts)

    assert kinds[("agent_spawned", atlas)] == 3
    assert kinds[("agent_completed", atlas)] == 3
    spawned = [e["agent"]["name"] for e in out if e["type"] == "agent_spawned"]
    assert spawned == [
        "Status page hosting options",
        "Incident communication research",
        "What to monitor research",
    ]

    hands = [
        e
        for e in out
        if e["sessionId"] == nova
        and (e["type"] == "session_needs_you" or e.get("batch"))
    ]
    assert [e["type"] for e in hands] == [
        "session_needs_you",
        "session_tool_done",
        "session_needs_you",
        "session_tool_done",
    ]

    replies = {
        e["sessionId"]: e.get("text", "")
        for e in out
        if e["type"] == "session_turn_end"
    }
    assert replies[atlas].startswith(
        "Here's the research summary for the status page launch"
    )
    assert replies[nova].startswith("Done! Wrote uptime_checker.py")
    assert all(len(e.get("text", "")) <= 200 for e in out)

    assert ("agent_working", nova) in kinds
    assert not [
        e
        for e in out
        if e["sessionId"] == session_of(mapper, PIXEL)
        and e["type"] != "session_started"
    ]


def test_an_earlier_reply_in_the_same_turn_shows_as_a_status_line():
    mapper = Mapper(ROOM, AGENTS)
    mapper.open_desks()
    out = feed(mapper, frames())
    nova = session_of(mapper, NOVA)
    said = [
        e["status"]
        for e in out
        if e["sessionId"] == nova
        and e["type"] == "agent_working"
        and e["status"].startswith("💬")
    ]
    assert said == ["💬 On it — writing a quick uptime checker now."]


def test_a_repeated_revision_moves_nothing():
    mapper = Mapper(ROOM, AGENTS)
    rows = frames()
    first = feed(mapper, rows)
    assert first
    assert feed(mapper, rows) == []


def test_another_room_moves_nothing():
    mapper = Mapper("some-other-room", AGENTS)
    assert feed(mapper, frames()) == []


def test_catching_up_on_an_unchanged_room_emits_nothing():
    rows = frames()
    items = [r["data"] for r in rows if r["event"] == "activity"]
    approvals = [r["data"] for r in rows if r["event"] == "approval"]
    messages = [r["data"] for r in rows if r["event"] == "message"]
    mapper = Mapper(ROOM, AGENTS)
    mapper.baseline(items, approvals, messages)
    assert feed(mapper, copy.deepcopy(rows)) == []


def test_catching_up_after_a_gap_emits_only_what_moved():
    rows = frames()
    half = len(rows) // 2
    mapper = Mapper(ROOM, AGENTS)
    feed(mapper, rows[:half])
    caught_up = feed(
        mapper, rows
    )  # a resync rereads everything; only the second half is new
    fresh = feed(Mapper(ROOM, AGENTS), rows)
    assert 0 < len(caught_up) < len(fresh)


def test_a_person_in_the_room_is_never_a_desk():
    mapper = Mapper(ROOM, AGENTS)
    person = {
        "messageId": "m1",
        "roomId": ROOM,
        "sender": {"kind": "user", "name": "demo-person", "agentId": None},
        "body": "hello",
    }
    assert mapper.message(person) == []
    assert mapper.desks == {}


def test_mentions_lose_their_at():
    assert strip_mentions("@pixel suggest a name") == "pixel suggest a name"
    assert (
        strip_mentions("ask <@U0123|nova> and @atlas.lead") == "ask nova and atlas.lead"
    )
    assert strip_mentions("mail me at ops@example.com") == "mail me at ops@example.com"


def test_text_is_clipped_at_a_word():
    text = "word " * 100
    assert len(clip(text, 200)) <= 200
    assert clip(text, 200).endswith("…")
    assert clip("**Pulse**\n\n```\nart\n```\nShort.", 200) == "Pulse Short."


def test_tool_titles_read_like_a_person_wrote_them():
    assert tool_words("mcp__switch__post_message") == "posting in the room"
    assert (
        tool_words("Write /Users/demo/x/uptime_checker.py")
        == "writing uptime_checker.py"
    )
    assert tool_words("python3 uptime_checker.py") == "python3 uptime_checker.py"


def test_signals_come_only_from_commands_that_mean_something():
    assert signal_kind("uv run pytest tests/billing") == "test"
    assert signal_kind("pnpm run build") == "build"
    assert signal_kind("git push origin main") == "push"
    assert signal_kind("python3 uptime_checker.py") is None
    assert signal_kind("ls -la") is None


def test_whose_machine_it_ran_on_stays_off_screen():
    assert (
        tool_words("ls /Users/someone/.switch/agents/localhost-8100/nova/") == "ls nova"
    )
    assert clip("Write /home/someone/work/app/main.py", 200) == "Write main.py"
    assert clip("see ~/notes.md", 200) == "see ~/notes.md"


def test_a_notice_outside_any_turn_is_not_a_reply():
    mapper = Mapper(ROOM, AGENTS)
    notice = {
        "messageId": "n1",
        "roomId": ROOM,
        "sender": {"kind": "agent", "name": "pixel", "agentId": PIXEL},
        "body": "Starting a session to handle this — one moment.",
    }
    assert [e["type"] for e in mapper.message(notice)] == ["session_started"]


def test_a_reply_after_the_turn_ended_still_lands():
    mapper = Mapper(ROOM, AGENTS)
    base = {"agentId": PIXEL, "sessionId": "s", "turnId": "t", "roomId": ROOM}
    mapper.activity(
        {
            **base,
            "itemId": "u",
            "kind": "user-message",
            "status": "completed",
            "revision": 1,
            "text": "@pixel hi",
        }
    )
    mapper.activity(
        {**base, "itemId": "turn", "kind": "turn", "status": "completed", "revision": 9}
    )
    late = {
        "messageId": "r1",
        "roomId": ROOM,
        "sender": {"kind": "agent", "name": "pixel", "agentId": PIXEL},
        "body": "Hello!",
    }
    assert mapper.message(late) == [
        {
            "type": "session_turn_end",
            "sessionId": mapper.desks[PIXEL].session,
            "text": "Hello!",
        }
    ]
