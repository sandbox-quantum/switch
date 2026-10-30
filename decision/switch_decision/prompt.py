from collections import Counter

from switch_decision.models import DecideRequest, Message

NONE = "none"

# How many of the thread's and the room's latest messages a prompt carries.
DEFAULT_HISTORY_LIMIT = 8

SYSTEM = """You decide which single agent in a team chat room, if any, should answer the latest message.

People and AI agents share the room. Nobody tagged an agent in the latest message, so you decide.

Choose exactly one agent whose job clearly covers the message, or "none".
Choose "none" when:
- people are talking to each other, or the message is meant for a named person
- it is small talk, thanks, an acknowledgement or social chatter
- no agent's description covers it
Prefer an agent already helping in this conversation when the message continues that topic.

Give a short reason first, then your choice, then your confidence from 0 to 1 that the
choice is right (for "none", your confidence that no agent should answer)."""


def _line(m: Message) -> str:
    kind = "agent" if m.sender_kind == "agent" else "person"
    to = f" (to {', '.join(m.addressed)})" if m.addressed else ""
    return f"- {m.sender} [{kind}]{to}: {m.text}"


def _interactions(messages: list[Message]) -> list[str]:
    pairs: Counter[tuple[str, str]] = Counter()
    for m in messages:
        for target in m.addressed:
            pairs[(m.sender, target)] += 1
    # A reply right after someone spoke is also an interaction.
    for prev, cur in zip(messages, messages[1:]):
        if prev.sender != cur.sender and not cur.addressed:
            pairs[(cur.sender, prev.sender)] += 1
    return [f"- {a} -> {b}: {n}" for (a, b), n in pairs.most_common(10)]


def build_state(req: DecideRequest, history_limit: int) -> str:
    """The room's context as one text block: what a decision model reads."""
    agents = "\n".join(
        f"- {a.name}: {a.description}" + (f" (role: {a.role})" if a.role else "")
        for a in req.agents
    )
    recent = req.recent[-history_limit:]
    thread = req.thread[-history_limit:]
    parts = [f"Room: {req.room.name}"]
    if req.room.instructions:
        parts.append(f"Room instructions:\n{req.room.instructions}")
    parts.append(f"Agents in the room:\n{agents}")
    if recent:
        parts.append(
            "Recent messages in the room (oldest first):\n"
            + "\n".join(map(_line, recent))
        )
    if thread:
        parts.append(
            "The thread this message is in (oldest first):\n"
            + "\n".join(map(_line, thread))
        )
    talked = _interactions(recent + thread)
    if talked:
        parts.append("Who talked to whom recently:\n" + "\n".join(talked))
    where = (
        "in the thread above"
        if req.message.thread_id
        else "at the top level of the room"
    )
    parts.append(
        f"Latest message, {where}:\n- {req.message.sender} [person]: {req.message.text}"
    )
    return "\n\n".join(parts)


def build_messages(req: DecideRequest, history_limit: int) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": build_state(req, history_limit)},
    ]


SPEAKER_QUESTION = "speaker"

SPEAKER_INSTRUCTIONS = (
    "Which single agent in this room should answer the latest message? Nobody tagged "
    "an agent. Pick the agent whose job clearly covers the message; prefer an agent "
    "already helping in this conversation when the message continues that topic. "
    "Pick none when people are talking to each other, the message is for a named "
    "person, it is small talk or thanks, or no agent's job covers it."
)

NONE_CRITERION = (
    "No agent should answer: people talking to each other, a message meant for a "
    "named person, small talk, thanks or acknowledgement, or nothing any agent covers."
)


def systemone_request(req: DecideRequest, model: str, history_limit: int) -> dict:
    criteria = {
        a.name: f"{a.name}: {a.description}" + (f" (role: {a.role})" if a.role else "")
        for a in req.agents
    }
    criteria[NONE] = NONE_CRITERION
    return {
        "model": model,
        "state": build_state(req, history_limit),
        "questions": {
            SPEAKER_QUESTION: {
                "type": "choice",
                "instructions": SPEAKER_INSTRUCTIONS,
                "criteria": criteria,
            }
        },
    }


def output_schema(agent_names: list[str]) -> dict:
    return {
        "type": "object",
        "properties": {
            "reason": {"type": "string"},
            "agent": {"type": "string", "enum": [*agent_names, NONE]},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["reason", "agent", "confidence"],
    }


PICK_TOOL = "pick_speaker"


def pick_tool(agent_names: list[str]) -> dict:
    """A Bedrock Converse tool the model is forced to call: its input is the decision."""
    return {
        "toolSpec": {
            "name": PICK_TOOL,
            "description": "Record which agent, if any, should answer the latest message.",
            "inputSchema": {"json": output_schema(agent_names)},
        }
    }


NONE_LETTER = "N"
AGENT_LETTERS = "ABCDEFGHIJKLM"  # N is none


def lettered_options(agent_names: list[str]) -> dict[str, str]:
    """Letter -> option name: one single-token letter per agent, and N for none."""
    if len(agent_names) > len(AGENT_LETTERS):
        raise ValueError(
            f"at most {len(AGENT_LETTERS)} agents can be lettered, got {len(agent_names)}"
        )
    return {**dict(zip(AGENT_LETTERS, agent_names)), NONE_LETTER: NONE}


LETTER_SYSTEM = (
    SYSTEM.split("Give a short reason first")[0].rstrip()
    + "\n\nAnswer with the letter of your choice only."
)


def letter_messages(
    req: DecideRequest, history_limit: int
) -> tuple[list[dict[str, str]], dict[str, str]]:
    options = lettered_options([a.name for a in req.agents])
    by_name = {a.name: a for a in req.agents}
    lines = []
    for letter, name in options.items():
        if name == NONE:
            lines.append(f"{letter}) none: {NONE_CRITERION}")
        else:
            a = by_name[name]
            lines.append(
                f"{letter}) {a.name}: {a.description}"
                + (f" (role: {a.role})" if a.role else "")
            )
    user = (
        build_state(req, history_limit)
        + "\n\nWho should answer the latest message?\n"
        + "\n".join(lines)
        + "\n\nAnswer:"
    )
    return [
        {"role": "system", "content": LETTER_SYSTEM},
        {"role": "user", "content": user},
    ], options


def llamacpp_request(
    req: DecideRequest, history_limit: int
) -> tuple[dict, dict[str, str]]:
    """The llama.cpp `POST /v1/chat/completions` body for a decision, and the
    letter each option goes by: one token, read back with its logprobs
    (`readers.read_letter_logprobs`). The service sends it to its llama.cpp
    server; switch-core sends the same body to a model served on a user's own
    machine."""
    messages, letters = letter_messages(req, history_limit)
    return {
        "messages": messages,
        "max_tokens": 1,
        "temperature": 0,
        "logprobs": True,
        "top_logprobs": 20,
        "chat_template_kwargs": {"enable_thinking": False},
    }, letters
