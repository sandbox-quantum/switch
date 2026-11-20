"""Turn one Switch room's activity and messages into Claude-Office events.

Pure: no network, no clock of its own. The adapter feeds it gateway frames
(``activity`` / ``approval`` items from ``/chats/activity/events`` and
``message`` items from ``/chats/events``, in their camelCase wire shape) and
posts whatever office events it returns to the office's ``POST /event``.

Each agent in the room gets one office session, keyed by the agent rather than
by the Switch session id, so its desk and name pill stay put across Switch
sessions. See openspec/changes/demo-office-view/design.md for the mapping.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

OfficeEvent = dict[str, Any]

# A session's own chat line in the office is cut at 200 characters (unless the
# office logs prompts in full), so long text is trimmed here, at a word.
CHAT_LIMIT = 200

# What Switch posts in an agent's name while it starts the agent a session
# (`_STARTING_SESSION_MESSAGE` in core/switch_core/delivery/recipient.py). It is
# not the agent at work, so it is no reply in the office.
SESSION_STARTING_NOTICE = "Starting a session to handle this — one moment."
STATUS_LIMIT = 120

_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9][\w.\-]*)")
_SLACK_MENTION = re.compile(r"<@[A-Z0-9]+(?:\|([^>]+))?>")

# Tool names Switch's agents use, said the way a person would.
_TOOL_WORDS = {
    "mcp__switch__post_message": "posting in the room",
    "mcp__switch__send_targeted_message": "messaging a teammate",
    "mcp__switch__read_context": "catching up on the room",
    "mcp__switch__send_attachment": "sharing a file",
    "ToolSearch": "looking for the right tool",
    "TodoWrite": "updating the task list",
    "WebSearch": "searching the web",
    "WebFetch": "reading a web page",
}

# Shell commands that mean something on screen (the office's "signals").
_SIGNALS = [
    (
        re.compile(
            r"\b(pytest|vitest|jest|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|just test)\b"
        ),
        "test",
    ),
    (
        re.compile(
            r"\b(npm run build|pnpm (run )?build|yarn build|cargo build|go build|tsc\b|vite build|make\b)"
        ),
        "build",
    ),
    (
        re.compile(
            r"\b(deploy|kubectl apply|helm (upgrade|install)|terraform apply|fly deploy|vercel)\b"
        ),
        "deploy",
    ),
    (re.compile(r"\bgit push\b"), "push"),
]
_SIGNAL_KINDS = {
    "test": ("test_start", "test_ok", "test_failed"),
    "build": ("build_start", "build_ok", "build_failed"),
    "deploy": ("deploy_start", "deploy_success", "deploy_fail"),
    "push": ("push", "push_done", "push_failed"),
}
_FAILED = {"failed", "error", "errored", "declined", "denied", "cancelled", "canceled"}
_DONE = {"completed", "succeeded", "done"} | _FAILED
_TURN_OVER = {"completed", "interrupted", "error", "failed", "cancelled", "canceled"}


def strip_mentions(text: str) -> str:
    """Drop the ``@`` from every mention, so ``@pixel do X`` reads ``pixel do
    X``. The office never sees a mention it could act on."""
    text = _SLACK_MENTION.sub(lambda m: m.group(1) or "", text)
    return _MENTION.sub(lambda m: m.group(1), text).strip()


_HOME = re.compile(r"(?:/Users|/home)/[^/\s]+")
_LONG_PATH = re.compile(r"(?:~|/)[\w.\-]*(?:/[\w.\-]+){2,}/?")


def tidy_paths(text: str) -> str:
    """A home directory reads ``~``, and a deep path only its last part, so
    whose machine it ran on (and its layout) stays off screen."""
    text = _HOME.sub("~", text)
    return _LONG_PATH.sub(
        lambda m: m.group(0).rstrip("/").rsplit("/", 1)[-1] or m.group(0), text
    )


def clip(text: str, limit: int) -> str:
    """One paragraph of plain text, at most ``limit`` characters."""
    text = tidy_paths(text)
    text = re.sub(
        r"```.*?```", " ", text, flags=re.S
    )  # code blocks read badly in a chat line
    text = re.sub(r"\*\*|__|`|^#+\s*|^>\s*", "", text, flags=re.M)
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:-") + "…"


def tool_words(title: str) -> str:
    """What a tool call is doing, for the office's status line."""
    title = tidy_paths((title or "").strip())
    if title in _TOOL_WORDS:
        return _TOOL_WORDS[title]
    if title.startswith("mcp__switch__"):
        return title.removeprefix("mcp__switch__").replace("_", " ")
    head, _, rest = title.partition(" ")
    if head in ("Write", "Edit", "Read", "MultiEdit") and rest:
        verb = {
            "Read": "reading",
            "Write": "writing",
            "Edit": "editing",
            "MultiEdit": "editing",
        }[head]
        return f"{verb} {rest.rsplit('/', 1)[-1]}"
    return title or "working"


def tool_name(title: str) -> str:
    """The office's notion of a tool: one word."""
    head = (title or "").split(" ", 1)[0]
    if head in (
        "Write",
        "Edit",
        "Read",
        "MultiEdit",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "ToolSearch",
        "TodoWrite",
    ):
        return head
    if head.startswith("mcp__"):
        return "MCP"
    return "Bash"


def signal_kind(title: str) -> str | None:
    for pattern, kind in _SIGNALS:
        if pattern.search(title or ""):
            return kind
    return None


def worker_id(item_id: str) -> str:
    return "sub-" + hashlib.sha1(item_id.encode()).hexdigest()[:12]


@dataclass
class _Desk:
    """One agent's office session."""

    session: str  # the office session id
    name: str
    running: bool = False
    turn: str | None = None
    hand_up: set[str] = field(default_factory=set)  # open approval request ids
    held: list[str] = field(
        default_factory=list
    )  # replies posted during the running turn
    workers: set[str] = field(default_factory=set)  # office worker ids still at a desk


class Mapper:
    """Switch room frames in, office events out.

    ``baseline`` records items without emitting anything (what was already
    there when the adapter started, or a snapshot it has caught up with);
    ``activity`` / ``approval`` / ``message`` emit for what moved.
    """

    def __init__(self, room_id: str, agents: dict[str, str]):
        self.room_id = room_id
        self.agents = dict(agents)  # agent id -> name shown on the desk
        self.desks: dict[str, _Desk] = {}
        self.revisions: dict[tuple[str, str], int] = {}
        self.approvals: dict[str, str] = {}  # request id -> last state seen
        self.messages: set[str] = set()  # message ids already handled

    # ── desks ──────────────────────────────────────────────────────────────

    def desk_for(self, agent_id: str) -> tuple[_Desk, list[OfficeEvent]]:
        desk = self.desks.get(agent_id)
        if desk is not None:
            return desk, []
        name = self.agents.get(agent_id) or agent_id[:8]
        desk = _Desk(
            session=f"switch-{re.sub(r'[^A-Za-z0-9_-]', '-', name.lower())}-{agent_id[:6]}",
            name=name,
        )
        self.desks[agent_id] = desk
        return desk, [
            {
                "type": "session_started",
                "sessionId": desk.session,
                "project": name,
                "source": "startup",
            }
        ]

    def open_desks(self) -> list[OfficeEvent]:
        """A desk for every agent in the room, so the whole team is in from the start."""
        out: list[OfficeEvent] = []
        for agent_id in self.agents:
            out += self.desk_for(agent_id)[1]
        return out

    def close_desks(self) -> list[OfficeEvent]:
        out = [
            {"type": "session_ended", "sessionId": d.session, "reason": "other"}
            for d in self.desks.values()
        ]
        self.desks.clear()
        return out

    # ── input ──────────────────────────────────────────────────────────────

    def _mine(self, item: dict[str, Any]) -> bool:
        return item.get("roomId") == self.room_id

    def _newer(self, item: dict[str, Any]) -> bool:
        key = (item.get("sessionId", ""), item.get("itemId", ""))
        rev = int(item.get("revision") or 0)
        if self.revisions.get(key, -1) >= rev:
            return False
        self.revisions[key] = rev
        return True

    def baseline(
        self,
        items: list[dict[str, Any]],
        approvals: list[dict[str, Any]],
        messages: list[dict[str, Any]],
    ) -> None:
        for item in items:
            if self._mine(item):
                self._newer(item)
        for req in approvals:
            if self._mine(req):
                self.approvals[req["requestId"]] = req.get("state", "")
        for msg in messages:
            self.messages.add(msg.get("messageId") or "")

    def activity(self, item: dict[str, Any]) -> list[OfficeEvent]:
        if not self._mine(item) or not self._newer(item):
            return []
        desk, out = self.desk_for(item["agentId"])
        kind, status = item.get("kind"), item.get("status", "")
        s = desk.session
        if kind == "turn":
            if status == "running" and not desk.running:
                desk.running, desk.turn = True, item.get("turnId")
            elif (
                status in _TURN_OVER
                and desk.running
                and item.get("turnId") == desk.turn
            ):
                desk.running = False
                out += self._turn_end(desk)
        elif kind == "user-message":
            text = strip_mentions(item.get("text") or "")
            if text:
                out.append(
                    {
                        "type": "session_prompt",
                        "sessionId": s,
                        "text": clip(text, CHAT_LIMIT),
                    }
                )
            desk.running, desk.turn = True, item.get("turnId")
        elif kind == "tool-activity" and item.get("subagent"):
            wid = worker_id(item["itemId"])
            title = (item.get("title") or "subagent").removeprefix("fork: ").strip()
            if status in _DONE:
                if wid in desk.workers:
                    desk.workers.discard(wid)
                    out.append(
                        {
                            "type": "agent_completed",
                            "sessionId": s,
                            "agentId": wid,
                            "result": clip(item.get("text") or "done", STATUS_LIMIT),
                        }
                    )
            elif wid not in desk.workers:
                desk.workers.add(wid)
                out.append(
                    {
                        "type": "agent_spawned",
                        "sessionId": s,
                        "agent": {
                            "id": wid,
                            "name": clip(title, 40),
                            "role": "general-purpose",
                            "task": clip(title, STATUS_LIMIT),
                        },
                    }
                )
                out.append(
                    {
                        "type": "agent_working",
                        "sessionId": s,
                        "agentId": wid,
                        "status": clip(title, STATUS_LIMIT),
                    }
                )
        elif kind == "tool-activity":
            title = item.get("title") or ""
            sig = signal_kind(title) if tool_name(title) == "Bash" else None
            if status in _DONE:
                failed = status in _FAILED
                out.append(
                    {
                        "type": "session_tool_done",
                        "sessionId": s,
                        "toolName": tool_name(title),
                        **({"error": "failed"} if failed else {}),
                    }
                )
                if sig:
                    out.append(
                        {
                            "type": "signal",
                            "sessionId": s,
                            "signals": [
                                {"kind": _SIGNAL_KINDS[sig][2 if failed else 1]}
                            ],
                        }
                    )
            else:
                out.append(
                    {
                        "type": "agent_working",
                        "sessionId": s,
                        "tool": tool_name(title),
                        "status": clip(tool_words(title), STATUS_LIMIT),
                    }
                )
                if sig:
                    out.append(
                        {
                            "type": "signal",
                            "sessionId": s,
                            "signals": [{"kind": _SIGNAL_KINDS[sig][0]}],
                        }
                    )
        return out

    def approval(self, req: dict[str, Any]) -> list[OfficeEvent]:
        if not self._mine(req):
            return []
        rid, state = req["requestId"], req.get("state", "")
        seen = self.approvals.get(rid)
        if seen == state or (seen not in (None, "open")):
            return []
        self.approvals[rid] = state
        desk, out = self.desk_for(req["agentId"])
        if state == "open":
            desk.hand_up.add(rid)
            out.append(
                {
                    "type": "session_needs_you",
                    "sessionId": desk.session,
                    "kind": "permission",
                    "summary": clip(req.get("title") or "an approval", STATUS_LIMIT),
                }
            )
        elif rid in desk.hand_up:
            desk.hand_up.discard(rid)
            if not desk.hand_up:
                out.append(
                    {
                        "type": "session_tool_done",
                        "sessionId": desk.session,
                        "batch": True,
                    }
                )
        return out

    def message(self, msg: dict[str, Any]) -> list[OfficeEvent]:
        """An agent's own room message. Held while its turn runs (the last one
        becomes the turn's reply); an earlier one held shows as a status line."""
        mid = msg.get("messageId") or ""
        if not self._mine(msg) or mid in self.messages:
            return []
        self.messages.add(mid)
        sender = msg.get("sender") or {}
        agent_id = sender.get("agentId")
        if sender.get("kind") != "agent" or not agent_id:
            return []
        if agent_id not in self.agents and sender.get("name"):
            self.agents[agent_id] = sender["name"]
        desk, out = self.desk_for(agent_id)
        text = strip_mentions(msg.get("body") or "")
        if not text or text == SESSION_STARTING_NOTICE:
            return out
        if desk.running:
            for earlier in desk.held:
                out.append(
                    {
                        "type": "agent_working",
                        "sessionId": desk.session,
                        "status": "💬 " + clip(earlier, STATUS_LIMIT - 2),
                    }
                )
            desk.held = [text]
        else:
            out.append(
                {
                    "type": "session_turn_end",
                    "sessionId": desk.session,
                    "text": clip(text, CHAT_LIMIT),
                }
            )
        return out

    def _turn_end(self, desk: _Desk) -> list[OfficeEvent]:
        reply = desk.held[-1] if desk.held else ""
        desk.held = []
        event: OfficeEvent = {"type": "session_turn_end", "sessionId": desk.session}
        if reply:
            event["text"] = clip(reply, CHAT_LIMIT)
        return [event]
