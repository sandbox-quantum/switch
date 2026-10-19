"""Following the conversation, against a real Postgres.

One test per branch of the decision tree, plus the edge cases that keep each
rule narrow. The rules read the room's history, so the history is real rows
written through `MessageStore`, with `sent_at` set to control the follow-up
window.
"""

from __future__ import annotations

import pytest

from switch_core.clients.admin_messages import (
    ADMIN_MARKER,
    AUTO_REPLY_FLAG,
    PLATFORM_MARKER,
    SENDER_IS_APP_MARKER,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.conversation import (
    ConversationMessage,
    ConversationSettings,
    is_small_talk,
    may_follow,
)
from tests.switch_core.delivery.world import (
    CHANNEL,
    MAIN,
    T0,
    THREAD,
    World,
    _settings,
)

# ── Checks that need no database read ───────────────────────────────────────


def _msg(body: str = "what next?", **content: object) -> ConversationMessage:
    return ConversationMessage(
        event_id="$x",
        sender="@alice:test",
        body=body,
        content=content,
        thread_root_id=None,
        sent_at=T0,
    )


class TestMayFollow:
    def test_off_unless_the_flag_is_on(self) -> None:
        off = ConversationSettings(enabled=False, window_seconds=300)
        assert not may_follow(off, channel_type=None, message=_msg())

    def test_a_mention_always_wins(self) -> None:
        assert not may_follow(
            _settings(), channel_type=None, message=_msg("@bob what next?")
        )

    def test_direct_chats_already_reach_the_agent(self) -> None:
        assert not may_follow(_settings(), channel_type="direct", message=_msg())

    @pytest.mark.parametrize(
        "marker", [ADMIN_MARKER, AUTO_REPLY_FLAG, PLATFORM_MARKER, SENDER_IS_APP_MARKER]
    )
    def test_never_for_switch_agents_or_apps(self, marker: str) -> None:
        assert not may_follow(
            _settings(), channel_type=None, message=_msg(**{marker: True})
        )


class TestSmallTalk:
    @pytest.mark.parametrize(
        "body", ["Thanks!", "thank you.", "thx", "  cheers  ", "great", "Perfect!"]
    )
    def test_thanks_and_praise(self, body: str) -> None:
        assert is_small_talk(body)

    @pytest.mark.parametrize("body", ["ok", "yes", "no", "+1", "👍", "lgtm", "got it"])
    def test_answers_are_not_small_talk(self, body: str) -> None:
        # Any of these may be the reply to an agent's question.
        assert not is_small_talk(body)

    @pytest.mark.parametrize(
        "body", ["why?", "thanks, and what about the tests?", "ok so what next"]
    )
    def test_real_questions(self, body: str) -> None:
        assert not is_small_talk(body)


# ── Who sent it ─────────────────────────────────────────────────────────────


class TestOnlyPeople:
    async def test_a_message_from_an_agent_reaches_nobody(self, world: World) -> None:
        answer = await world.post("helper", "Here you go", at=0)
        await world.post("reviewer", "a reply", at=5, thread=answer)
        reply = await world.post("reviewer", "and another", at=6, thread=answer)

        decision = await world.decide("helper", reply)

        assert decision.route is None
        assert decision.reason == "not sent by a person"


# ── Rule 1: thread follow-ups ───────────────────────────────────────────────


class TestThreadFollowUp:
    async def test_reply_under_the_agents_answer(self, world: World) -> None:
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post(
            "alice", "why two database roles?", at=30, thread=answer
        )

        assert await world.route("helper", reply) == THREAD
        assert await world.route("reviewer", reply) is None

    async def test_reply_in_a_thread_the_agent_replied_in(self, world: World) -> None:
        root = await world.post("bob", "deploy is red", at=0)
        await world.post("helper", "looking", at=10, thread=root)
        reply = await world.post("alice", "any luck?", at=60, thread=root)

        assert await world.route("helper", reply) == THREAD

    async def test_reply_under_a_question_that_mentioned_the_agent(
        self, world: World
    ) -> None:
        # The agent answered at the top of the channel, not in the thread.
        question = await world.post("alice", "@helper what does just up do?", at=0)
        await world.post("helper", "It starts the stack", at=10)
        reply = await world.post("alice", "and why?", at=60, thread=question)

        decision = await world.decide("helper", reply)
        assert decision.route == THREAD
        assert decision.reason == "the agent was tagged most recently in this thread"

    async def test_a_mention_by_alias_counts(self, world: World) -> None:
        async with world.session_factory() as session:
            await RoomStore().set_alias(
                session, world.room_id, world.agents["helper"].id, "h"
            )
            await session.commit()
        question = await world.post("alice", "@h can you check?", at=0)
        reply = await world.post("alice", "the tests too", at=60, thread=question)

        assert await world.route("helper", reply) == THREAD

    async def test_an_automatic_notice_is_not_taking_part(self, world: World) -> None:
        root = await world.post("bob", "anyone around?", at=0)
        await world.post(
            "helper",
            "Starting a session…",
            at=1,
            thread=root,
            **{AUTO_REPLY_FLAG: True},
        )
        reply = await world.post("alice", "hello?", at=60, thread=root)

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "the agent is not taking part in this thread"

    async def test_a_thread_between_people_reaches_nobody(self, world: World) -> None:
        root = await world.post("bob", "lunch at 1?", at=0)
        reply = await world.post(
            "alice", "sounds like a plan, see you there", at=30, thread=root
        )

        assert await world.route("helper", reply) is None
        assert await world.route("reviewer", reply) is None

    async def test_the_agent_that_spoke_last_owns_the_thread(
        self, world: World
    ) -> None:
        # helper answered first, then reviewer was tagged and answered: the
        # next untagged reply is reviewer's alone.
        root = await world.post("alice", "@helper @reviewer thoughts?", at=0)
        await world.post("helper", "looks fine", at=10, thread=root)
        await world.post("alice", "hey @reviewer, anything else?", at=15, thread=root)
        await world.post("reviewer", "one nit", at=20, thread=root)
        reply = await world.post("alice", "which nit?", at=60, thread=root)

        assert await world.route("reviewer", reply) == THREAD
        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "another agent spoke more recently in this thread"

    async def test_tagging_another_agent_hands_the_thread_over(
        self, world: World
    ) -> None:
        answer = await world.post("helper", "It starts the stack", at=0)
        await world.post(
            "alice", "hey @reviewer can you check this?", at=10, thread=answer
        )
        reply = await world.post(
            "alice", "the tests are slow too", at=20, thread=answer
        )

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert (
            decision.reason == "another agent was tagged more recently in this thread"
        )
        assert await world.route("reviewer", reply) == THREAD

    async def test_several_tagged_agents_share_it_until_one_answers(
        self, world: World
    ) -> None:
        root = await world.post("alice", "@helper @reviewer thoughts?", at=0)
        first = await world.post("alice", "either of you?", at=10, thread=root)
        assert await world.route("helper", first) == THREAD
        assert await world.route("reviewer", first) == THREAD

        await world.post("reviewer", "on it", at=20, thread=root)
        after = await world.post("alice", "thanks, go ahead", at=30, thread=root)
        assert await world.route("reviewer", after) == THREAD
        assert await world.route("helper", after) is None

    async def test_tagging_a_person_does_not_move_the_thread(
        self, world: World
    ) -> None:
        answer = await world.post("helper", "It starts the stack", at=0)
        await world.post("alice", "@bob what do you think?", at=10, thread=answer)
        reply = await world.post(
            "alice", "anyway, why two roles?", at=20, thread=answer
        )

        assert await world.route("helper", reply) == THREAD

    async def test_small_talk_in_a_thread_reaches_nobody(self, world: World) -> None:
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "thanks!", at=30, thread=answer)

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "small talk"

    async def test_no_time_limit_in_a_thread(self, world: World) -> None:
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "one more question", at=86_400, thread=answer)

        assert await world.route("helper", reply) == THREAD


# ── Rule 2: channel follow-ups ──────────────────────────────────────────────


class TestChannelFollowUp:
    async def test_the_next_message_after_an_answer(self, world: World) -> None:
        await world.post("alice", "@helper what does just up do?", at=0)
        await world.post("helper", "It starts the stack", at=20)
        follow_up = await world.post("alice", "and what does just down do?", at=60)

        decision = await world.decide("helper", follow_up)
        assert decision.route == CHANNEL
        assert decision.reason == "continues an exchange the agent has just answered"
        assert await world.route("reviewer", follow_up) is None

    async def test_a_longer_back_and_forth(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer 1", at=20)
        await world.post("alice", "second", at=60)
        await world.post("helper", "answer 2", at=120)
        third = await world.post("alice", "third", at=200)

        assert await world.route("helper", third) == CHANNEL

    async def test_a_burst_ends_once_the_answer_is_too_old(self, world: World) -> None:
        # Each gap is short, but the agent's answer is more than the window ago.
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("alice", "second", at=200)
        late = await world.post("alice", "third", at=20 + 301)

        decision = await world.decide("helper", late)
        assert decision.route is None
        assert decision.reason == "too long since the agent's last answer"

    async def test_two_quick_messages_in_a_row(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("alice", "second", at=40)
        burst = await world.post("alice", "oh and also this", at=45)

        assert await world.route("helper", burst) == CHANNEL

    async def test_ends_when_someone_else_posts(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("bob", "unrelated chat", at=30)
        follow_up = await world.post("alice", "and then?", at=60)

        decision = await world.decide("helper", follow_up)
        assert decision.route is None
        assert decision.reason == "someone else posted after the agent's last answer"

    async def test_ends_when_another_agent_posts(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        await world.post("reviewer", "status update", at=30)
        follow_up = await world.post("alice", "and then?", at=60)

        assert (await world.decide("helper", follow_up)).reason == (
            "someone else posted after the agent's last answer"
        )

    async def test_ends_after_the_window(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        late = await world.post("alice", "and then?", at=20 + 301)

        decision = await world.decide("helper", late)
        assert decision.route is None
        assert decision.reason == "too long since the last message"

    async def test_just_inside_the_window(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        on_time = await world.post("alice", "and then?", at=20 + 300)

        assert await world.route("helper", on_time) == CHANNEL

    async def test_not_before_the_agent_has_answered(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post(
            "helper", "Starting a session…", at=1, **{AUTO_REPLY_FLAG: True}
        )
        early = await world.post("alice", "are you there?", at=10)

        decision = await world.decide("helper", early)
        assert decision.route is None
        assert decision.reason == "the agent has not answered yet"

    async def test_switch_notices_do_not_break_the_exchange(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post(
            "helper", "Starting a session…", at=1, **{AUTO_REPLY_FLAG: True}
        )
        await world.post("helper", "answer", at=30)
        await world.post(
            "admin", "Added someone to this room", at=40, **{ADMIN_MARKER: {}}
        )
        follow_up = await world.post("alice", "and then?", at=60)

        assert await world.route("helper", follow_up) == CHANNEL

    async def test_someone_else_cannot_pick_up_the_exchange(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        bobs = await world.post("bob", "what about me?", at=40)

        assert await world.route("helper", bobs) is None

    async def test_thanks_does_not_wake_the_agent(self, world: World) -> None:
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        thanks = await world.post("alice", "thanks!", at=30)

        assert (await world.decide("helper", thanks)).reason == "small talk"

    async def test_no_exchange_at_all(self, world: World) -> None:
        await world.post("bob", "morning all", at=0)
        await world.post("alice", "morning", at=10)
        question = await world.post(
            "alice", "anyone know why the deploy failed?", at=20
        )

        decision = await world.decide("helper", question)
        assert decision.route is None
        assert decision.reason == "no recent exchange with this agent"
        assert await world.route("reviewer", question) is None

    async def test_thread_replies_do_not_count_in_the_channel(
        self, world: World
    ) -> None:
        # Bob talking in a thread does not end Alice's exchange in the channel.
        root = await world.post("bob", "lunch?", at=0)
        await world.post("alice", "@helper first", at=10)
        await world.post("helper", "answer", at=20)
        await world.post("bob", "1pm?", at=30, thread=root)
        follow_up = await world.post("alice", "and then?", at=40)

        assert await world.route("helper", follow_up) == CHANNEL


# ── Rule 3: main-agent rooms ────────────────────────────────────────────────


class TestMainAgent:
    async def test_every_message_reaches_the_main_agent(self, world: World) -> None:
        await world.assign("helper")
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)

        decision = await world.decide("helper", question)
        assert decision.route == MAIN
        assert await world.route("reviewer", question) is None

    async def test_including_small_talk(self, world: World) -> None:
        await world.assign("helper")
        thanks = await world.post("alice", "thanks", at=0)

        assert await world.route("helper", thanks) == MAIN

    async def test_a_follow_up_is_named_as_such(self, world: World) -> None:
        await world.assign("helper")
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)

        assert await world.route("helper", reply) == THREAD

    async def test_unassigned_goes_back_to_follow_ups_only(self, world: World) -> None:
        await world.assign("helper")
        await world.assign(None)
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)

        assert await world.route("helper", question) is None

    async def test_leaving_the_room_clears_it(self, world: World) -> None:
        await world.assign("helper")
        async with world.session_factory() as session:
            await RoomStore().remove_agents(
                session, world.room_id, [world.agents["helper"].id]
            )
            await session.commit()
            assert await RoomStore().main_agent_id(session, world.room_id) is None


# ── A room that turned follow-ups off ───────────────────────────────────────


class TestFollowUpsOff:
    async def _off(self, world: World) -> None:
        async with world.session_factory() as session:
            await RoomStore().set_follow_ups_enabled(session, world.room_id, False)
            await session.commit()

    async def test_no_thread_follow_up(self, world: World) -> None:
        await self._off(world)
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post(
            "alice", "why two database roles?", at=30, thread=answer
        )

        decision = await world.decide("helper", reply)
        assert decision.route is None
        assert decision.reason == "follow-ups are switched off in this room"

    async def test_no_channel_follow_up(self, world: World) -> None:
        await self._off(world)
        await world.post("alice", "@helper first", at=0)
        await world.post("helper", "answer", at=20)
        follow_up = await world.post("alice", "and then?", at=40)

        assert (await world.decide("helper", follow_up)).reason == (
            "follow-ups are switched off in this room"
        )

    async def test_the_main_agent_still_gets_everything(self, world: World) -> None:
        await self._off(world)
        await world.assign("helper")
        question = await world.post("bob", "anyone know why the deploy failed?", at=0)

        assert await world.route("helper", question) == MAIN

    async def test_back_on_restores_follow_ups(self, world: World) -> None:
        await self._off(world)
        async with world.session_factory() as session:
            await RoomStore().set_follow_ups_enabled(session, world.room_id, True)
            await session.commit()
        answer = await world.post("helper", "It starts the stack", at=0)
        reply = await world.post("alice", "why?", at=30, thread=answer)

        assert await world.route("helper", reply) == THREAD


# ── Fixes from review ───────────────────────────────────────────────────────


class TestReviewFixes:
    async def test_yes_in_the_agents_thread_reaches_it(self, world: World) -> None:
        # The agent asked a question; "yes" is the answer it is waiting for.
        answer = await world.post("helper", "Shall I also run the migrations?", at=0)
        for n, body in enumerate(("yes", "ok", "👍", "+1")):
            reply = await world.post("alice", body, at=30 + n, thread=answer)
            assert await world.route("helper", reply) == THREAD, body

    async def test_thanks_still_wakes_nobody(self, world: World) -> None:
        answer = await world.post("helper", "Done", at=0)
        reply = await world.post("alice", "thanks!", at=30, thread=answer)

        assert (await world.decide("helper", reply)).reason == "small talk"

    async def test_turning_to_another_agent_ends_the_exchange(
        self, world: World
    ) -> None:
        await world.post("alice", "@helper do X", at=0)
        await world.post("helper", "Done X", at=10)
        await world.post("alice", "@reviewer check Y", at=20)
        follow_up = await world.post("alice", "it's in PR 12", at=30)

        decision = await world.decide("helper", follow_up)
        assert decision.route is None
        assert decision.reason == "the sender turned to someone else since"

    async def test_a_long_exchange_keeps_going(self, world: World) -> None:
        # Twelve rounds: the opening mention is beyond what one walk reads.
        await world.post("alice", "@helper first", at=0)
        at = 0
        for n in range(12):
            at += 10
            await world.post("helper", f"answer {n}", at=at)
            at += 10
            last = await world.post("alice", f"next question {n}", at=at)

        decision = await world.decide("helper", last)
        assert decision.route == CHANNEL

    async def test_a_late_joiner_in_a_long_thread_takes_part(
        self, world: World
    ) -> None:
        root = await world.post("bob", "deploy notes", at=0)
        for n in range(60):
            await world.post("bob", f"note {n}", at=1 + n, thread=root)
        await world.post("helper", "I can help", at=100, thread=root)
        reply = await world.post("alice", "please do", at=110, thread=root)

        assert await world.route("helper", reply) == THREAD

    async def test_a_mention_late_in_a_long_thread_counts(self, world: World) -> None:
        root = await world.post("bob", "deploy notes", at=0)
        for n in range(60):
            await world.post("bob", f"note {n}", at=1 + n, thread=root)
        await world.post("alice", "@helper can you look?", at=100, thread=root)
        reply = await world.post("alice", "the logs are above", at=110, thread=root)

        assert await world.route("helper", reply) == THREAD

    async def test_an_email_address_is_not_a_mention(self, world: World) -> None:
        answer = await world.post("helper", "Who should I send it to?", at=0)
        reply = await world.post(
            "alice", "send it to ops@example.com", at=30, thread=answer
        )

        assert await world.route("helper", reply) == THREAD

    def test_a_real_mention_still_stands_the_rules_aside(self) -> None:
        assert not may_follow(
            _settings(), channel_type=None, message=_msg("cc @bob please")
        )
        assert may_follow(
            _settings(), channel_type=None, message=_msg("mail ops@example.com")
        )
