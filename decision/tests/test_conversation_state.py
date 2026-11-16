"""The conversation-state context: when the sender is mid-exchange with an agent."""

import pytest

from switch_decision.models import Agent, DecideRequest, Incoming, Message, Room
from switch_decision.prompt import (
    CONVERSATION_RULE,
    LETTER_SYSTEM,
    SPEAKER_INSTRUCTIONS,
    SPEAKER_QUESTION,
    SYSTEM,
    build_messages,
    build_state,
    conversation_state,
    letter_messages,
    systemone_request,
)

AGENTS = [
    Agent(name="manager", description="tracks tasks"),
    Agent(name="worker", description="writes code"),
]


def P(sender, text, to=()):
    return Message(sender=sender, sender_kind="person", text=text, addressed=list(to))


def A(sender, text, to=()):
    return Message(sender=sender, sender_kind="agent", text=text, addressed=list(to))


def req(text="ok what else", *, thread=(), recent=(), sender="nora"):
    return DecideRequest(
        room=Room(name="product"),
        message=Incoming(sender=sender, text=text, thread_id="t1" if thread else None),
        agents=AGENTS,
        thread=list(thread),
        recent=list(recent),
    )


def test_thread_back_and_forth_with_the_agent():
    r = req(
        thread=[P("nora", "manager whats up", ["manager"]), A("manager", "nothing new")]
    )
    assert conversation_state(r, 8) == [
        "- nora's current back-and-forth with agents, nobody else speaking in between: manager (1)",
        "- In this thread, the last agent to speak or be addressed is manager; nobody else has spoken since.",
        "- The message just before this one is from manager, to nora.",
    ]


def test_someone_else_spoke_since_the_agent():
    r = req(
        thread=[
            P("nora", "status?", ["manager"]),
            A("manager", "one ticket waiting"),
            P("tom", "I can take it"),
        ]
    )
    assert conversation_state(r, 8) == [
        "- In this thread, the last agent to speak or be addressed is manager; since then tom spoke.",
    ]


def test_an_agent_only_addressed_in_the_thread():
    r = req(thread=[P("tom", "can you look", ["worker"])])
    assert conversation_state(r, 8) == [
        "- In this thread, the last agent to speak or be addressed is worker; it has not spoken in the visible thread.",
    ]


def test_top_level_agent_addressed_the_sender():
    r = req(
        "yes",
        recent=[
            P("tom", "lunch?"),
            A("worker", "PR is up, want screenshots?", ["nora"]),
        ],
    )
    assert conversation_state(r, 8) == [
        "- nora's current back-and-forth with agents, nobody else speaking in between: worker (1)",
        "- The message just before this one is from worker, to nora.",
    ]


def test_top_level_agent_answered_the_sender():
    r = req(
        "merged",
        recent=[P("nora", "cut a canary"), A("worker", "merge the pin PR first")],
    )
    assert (
        "- The message just before this one is from worker, to nora."
        in conversation_state(r, 8)
    )


def test_agent_message_to_someone_else_is_not_an_exchange_with_the_sender():
    r = req("yes", recent=[P("tom", "lunch?"), A("worker", "PR is up", ["tom"])])
    assert conversation_state(r, 8) == []


def test_no_exchange_gives_no_block():
    r = req(
        "priya, did you hear back about the invoice?",
        recent=[P("tom", "standup at 10:30"), P("ivy", "ok")],
    )
    assert conversation_state(r, 8) == []
    assert "Conversation state" not in build_state(r, 8)


def test_history_limit_applies():
    old = [P("nora", "hi", ["worker"]), A("worker", "hello", ["nora"])]
    chatter = [P("tom", f"line {i}") for i in range(8)]
    assert conversation_state(req("yes", recent=old + chatter), 8) == []
    assert conversation_state(req("yes", recent=old + chatter[:1]), 8) == []
    assert conversation_state(req("yes", recent=old), 8)


def test_block_sits_just_before_the_latest_message():
    r = req(
        thread=[P("nora", "manager whats up", ["manager"]), A("manager", "nothing new")]
    )
    state = build_state(r, 8)
    assert state.index("Conversation state:") < state.index(
        "Latest message, in the thread above"
    )
    assert state.index("Who talked to whom recently") < state.index(
        "Conversation state:"
    )


NO_EXCHANGE = req(
    "priya, did you hear back about the invoice?", recent=[P("tom", "standup at 10:30")]
)
EXCHANGE = req(
    thread=[P("nora", "manager whats up", ["manager"]), A("manager", "nothing new")]
)


def test_no_exchange_payloads_are_unchanged_for_every_backend():
    assert (
        systemone_request(NO_EXCHANGE, "m", 8)["questions"][SPEAKER_QUESTION][
            "instructions"
        ]
        == SPEAKER_INSTRUCTIONS
    )
    assert build_messages(NO_EXCHANGE, 8)[0]["content"] == SYSTEM
    assert letter_messages(NO_EXCHANGE, 8)[0][0]["content"] == LETTER_SYSTEM


@pytest.mark.parametrize(
    "instructions",
    [
        lambda r: systemone_request(r, "m", 8)["questions"][SPEAKER_QUESTION][
            "instructions"
        ],
        lambda r: build_messages(r, 8)[0]["content"],
        lambda r: letter_messages(r, 8)[0][0]["content"],
    ],
    ids=["strands", "chat", "letters"],
)
def test_exchange_payloads_carry_the_rule(instructions):
    text = instructions(EXCHANGE)
    assert CONVERSATION_RULE in text


def test_chat_prompt_keeps_the_answer_format_last():
    system = build_messages(EXCHANGE, 8)[0]["content"]
    assert system.index(CONVERSATION_RULE) < system.index("Give a short reason first")
    letters = letter_messages(EXCHANGE, 8)[0][0]["content"]
    assert letters.endswith("Answer with the letter of your choice only.")
