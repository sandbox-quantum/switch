"""What a Matrix room event becomes in Switch."""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.bridges.collaboration.matrix.adapter import MatrixAdapter
from switch_core.bridges.collaboration.session.renderers import parse_answer_position
from tests.switch_core.bridges.collaboration.matrix_fakes import (
    ALICE,
    BOT,
    ROOM,
    FakeHomeserver,
    Recorder,
    batch,
    make_adapter,
    message_event,
    start,
)

POSITION = "com.switch.matrix.sync.bridge-1"


async def _deliver(
    monkeypatch: pytest.MonkeyPatch,
    events: list[dict[str, Any]],
    homeserver: FakeHomeserver | None = None,
) -> tuple[Recorder, FakeHomeserver, MatrixAdapter]:
    homeserver = homeserver or FakeHomeserver()
    homeserver.account_data[POSITION] = {"next_batch": "s1"}
    homeserver.queue(batch("s2", events))
    adapter = make_adapter(monkeypatch, homeserver)
    recorder = Recorder()
    await start(adapter, recorder)
    await homeserver.until_syncs(2)
    await adapter.stop()
    return recorder, homeserver, adapter


class TestMessages:
    async def test_a_message_reaches_switch_with_its_event_id_as_reference(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.state[(ROOM, "m.room.name", "")] = {"name": "Ops"}
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m1", "hello there")], homeserver
        )
        [message] = recorder.messages
        assert message.channel_id == ROOM
        assert message.channel_type == "channel_private"
        assert message.channel_name == "Ops"
        assert message.sender_id == ALICE
        assert message.sender_name == "alice"
        assert message.content == "hello there"
        assert message.message_ref == "$m1"
        assert message.root_id is None
        assert message.sender_is_app is False

    async def test_someone_on_another_homeserver_keeps_their_server_in_the_handle(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "hi", sender="@alice:other.example")]
        )
        assert recorder.messages[0].sender_name == "alice.other.example"

    async def test_an_unaddressed_message_still_reaches_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "just chatting")]
        )
        assert recorder.messages[0].self_mention_token is None

    async def test_an_agent_named_in_the_text_is_left_for_switch_to_route(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "@coder can you look at this?")]
        )
        assert recorder.messages[0].content == "@coder can you look at this?"

    @pytest.mark.parametrize(
        "content",
        [
            {"body": "Switch Bot: hi", "m.mentions": {"user_ids": [BOT]}},
            {"body": "@switch-bot hi"},
            {"body": f"{BOT} hi"},
        ],
    )
    async def test_mentioning_the_bot_itself_is_flagged(
        self, monkeypatch: pytest.MonkeyPatch, content: dict[str, Any]
    ) -> None:
        event = message_event("$m", content.pop("body"), **content)
        recorder, _, _ = await _deliver(monkeypatch, [event])
        assert recorder.messages[0].self_mention_token == "switch-bot"

    async def test_the_bots_own_messages_are_ignored(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$mine", "an agent's reply", sender=BOT)]
        )
        assert recorder.messages == []

    async def test_history_of_a_room_the_bot_just_joined_is_not_relayed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        join = {
            "type": "m.room.member",
            "state_key": BOT,
            "event_id": "$joined",
            "sender": BOT,
            "content": {"membership": "join"},
            "unsigned": {"prev_content": {"membership": "invite"}},
        }
        recorder, _, _ = await _deliver(
            monkeypatch,
            [
                message_event("$history", "said before the bot was there"),
                join,
                message_event("$new", "said to the bot"),
            ],
        )
        assert [m.message_ref for m in recorder.messages] == ["$new"]

    async def test_a_notice_is_marked_as_coming_from_an_app(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder, _, _ = await _deliver(
            monkeypatch,
            [
                message_event(
                    "$n", "build passed", sender="@ci:example.org", msgtype="m.notice"
                )
            ],
        )
        assert recorder.messages[0].sender_is_app is True

    async def test_an_emote_reads_as_one(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$e", "waves", msgtype="m.emote")]
        )
        assert recorder.messages[0].content == "* alice waves"

    async def test_a_delivered_event_is_handled_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        event = message_event("$twice", "hello")
        recorder, _, _ = await _deliver(monkeypatch, [event, event])
        assert len(recorder.messages) == 1

    async def test_a_two_person_room_is_a_direct_conversation(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(members={ROOM: [BOT, ALICE]})
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "hi")], homeserver
        )
        assert recorder.messages[0].channel_type == "direct"

    async def test_a_room_anyone_can_join_is_public(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.state[(ROOM, "m.room.join_rules", "")] = {"join_rule": "public"}
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "hi")], homeserver
        )
        assert recorder.messages[0].channel_type == "channel_public"

    async def test_a_room_switch_created_says_what_it_is(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(members={ROOM: [BOT, ALICE]})
        homeserver.state[(ROOM, "m.room.create", "")] = {
            "com.switch.channel_type": "channel_private"
        }
        homeserver.state_senders[(ROOM, "m.room.create", "")] = BOT
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "hi")], homeserver
        )
        assert recorder.messages[0].channel_type == "channel_private"

    async def test_a_room_someone_else_created_cannot_declare_itself_direct(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Anyone can write the key into a room of their own; a group room
        passed off as direct would have every message go to its agent."""
        homeserver = FakeHomeserver()
        homeserver.state[(ROOM, "m.room.create", "")] = {
            "com.switch.channel_type": "direct"
        }
        homeserver.state_senders[(ROOM, "m.room.create", "")] = ALICE
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$m", "hi")], homeserver
        )
        assert recorder.messages[0].channel_type == "channel_private"


class TestThreads:
    async def test_a_thread_reply_names_its_root(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        event = message_event(
            "$r",
            "in the thread",
            **{
                "m.relates_to": {
                    "rel_type": "m.thread",
                    "event_id": "$root",
                    "is_falling_back": True,
                    "m.in_reply_to": {"event_id": "$latest"},
                }
            },
        )
        recorder, _, _ = await _deliver(monkeypatch, [event])
        assert recorder.messages[0].root_id == "$root"

    async def test_a_reply_outside_a_thread_threads_under_what_it_answers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        event = message_event(
            "$r",
            "> <@bob:example.org> the original\n\nmy answer",
            **{"m.relates_to": {"m.in_reply_to": {"event_id": "$original"}}},
        )
        recorder, _, _ = await _deliver(monkeypatch, [event])
        [message] = recorder.messages
        assert message.root_id == "$original"
        assert message.content == "my answer"

    async def test_a_reply_to_a_message_inside_a_thread_belongs_to_that_thread(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """What a client without threads sends. Threading under the replied-to
        message itself would start a thread from an event that already has a
        relation, which a homeserver refuses."""
        homeserver = FakeHomeserver()
        homeserver.put_event(
            ROOM,
            message_event(
                "$in-thread",
                "said in the thread",
                **{"m.relates_to": {"rel_type": "m.thread", "event_id": "$root"}},
            ),
        )
        replies = [
            message_event(
                f"$reply{n}",
                "an answer",
                **{"m.relates_to": {"m.in_reply_to": {"event_id": "$in-thread"}}},
            )
            for n in (1, 2)
        ]
        recorder, homeserver, _ = await _deliver(monkeypatch, replies, homeserver)
        assert [m.root_id for m in recorder.messages] == ["$root", "$root"]
        # Looked up once, then remembered.
        reads = [r for r in homeserver.requests if r.url.path.endswith("/$in-thread")]
        assert len(reads) == 1


class TestCommands:
    async def test_a_bang_command_is_a_command(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        thread = {"m.relates_to": {"rel_type": "m.thread", "event_id": "$root"}}
        recorder, _, _ = await _deliver(
            monkeypatch, [message_event("$c", "!invite-agent @coder", **thread)]
        )
        assert recorder.messages == []
        [command] = recorder.commands
        assert (command.command, command.args) == ("invite-agent", "@coder")
        assert command.message_ref == "$c"
        assert command.root_id == "$root"
        assert command.sender_name == "alice"

    async def test_a_lone_bang_is_just_a_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder, _, _ = await _deliver(monkeypatch, [message_event("$c", "!")])
        assert recorder.commands == []
        assert [m.content for m in recorder.messages] == ["!"]

    @pytest.mark.parametrize(
        ("msgtype", "content"),
        [("m.notice", {}), ("m.text", {"com.switch.relayed": True})],
        ids=["another-bots-notice", "another-switch-bridge"],
    )
    async def test_an_apps_message_runs_no_command_and_answers_nothing(
        self, monkeypatch: pytest.MonkeyPatch, msgtype: str, content: dict[str, Any]
    ) -> None:
        """Two bridges in one room would otherwise run each other's notices."""
        event = message_event(
            "$c",
            "!invite-agent @coder",
            sender="@ci:example.org",
            msgtype=msgtype,
            **content,
        )
        recorder, _, _ = await _deliver(monkeypatch, [event])
        assert recorder.commands == []
        [message] = recorder.messages
        assert message.sender_is_app is True


class TestEditsAndRedactions:
    """Neither is carried into the room yet; Switch's own are mirrored out."""

    async def test_an_edit_is_not_relayed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        edit = message_event(
            "$edit",
            "* hello @coder",
            **{
                "m.new_content": {"msgtype": "m.text", "body": "hello @coder"},
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$orig"},
            },
        )
        recorder, homeserver, _ = await _deliver(monkeypatch, [edit])
        assert recorder.messages == []
        assert recorder.commands == []
        # Nothing is looked up for it either: the original is not fetched.
        assert not any("/event/" in r.url.path for r in homeserver.requests)

    async def test_an_edit_that_looks_like_a_command_runs_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        edit = message_event(
            "$edit",
            "* !invite-agent @coder",
            **{
                "m.new_content": {"msgtype": "m.text", "body": "!invite-agent @coder"},
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$orig"},
            },
        )
        recorder, _, _ = await _deliver(monkeypatch, [edit])
        assert recorder.commands == []
        assert recorder.messages == []

    async def test_a_redaction_is_not_relayed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        redaction = {
            "type": "m.room.redaction",
            "event_id": "$red",
            "sender": ALICE,
            "redacts": "$orig",
            "content": {},
        }
        recorder, homeserver, _ = await _deliver(monkeypatch, [redaction])
        assert recorder.messages == []
        # Not even asked for: the sync filter leaves redactions out.
        assert "m.room.redaction" not in homeserver.syncs[-1]["filter"]


class TestAttachments:
    async def test_a_file_arrives_with_its_bytes_and_caption(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.media["mxc://example.org/abc"] = (b"PNGDATA", "image/png")
        event = message_event(
            "$f",
            "look at this",
            msgtype="m.image",
            filename="shot.png",
            url="mxc://example.org/abc",
            info={"mimetype": "image/png", "size": 7},
        )
        recorder, _, _ = await _deliver(monkeypatch, [event], homeserver)
        [message] = recorder.messages
        assert message.content == "look at this"
        [attachment] = message.attachments
        assert (attachment.filename, attachment.mimetype, attachment.data) == (
            "shot.png",
            "image/png",
            b"PNGDATA",
        )
        download = next(r for r in homeserver.requests if "download" in r.url.path)
        assert download.url.path.startswith("/_matrix/client/v1/media/download/")

    async def test_a_file_without_a_caption_is_named_by_its_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.media["mxc://example.org/doc"] = (b"%PDF", "application/pdf")
        event = message_event(
            "$f", "report.pdf", msgtype="m.file", url="mxc://example.org/doc", info={}
        )
        recorder, _, _ = await _deliver(monkeypatch, [event], homeserver)
        [message] = recorder.messages
        assert message.content == ""
        assert message.attachments[0].filename == "report.pdf"
        assert message.attachments[0].mimetype == "application/pdf"

    async def test_an_oversized_file_is_refused_visibly_without_downloading(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        event = message_event(
            "$big",
            "huge.bin",
            msgtype="m.file",
            url="mxc://example.org/big",
            info={"size": 5000, "mimetype": "application/octet-stream"},
        )
        recorder, homeserver, _ = await _deliver(monkeypatch, [event], homeserver)
        [message] = recorder.messages
        assert message.attachments == []
        [failure] = message.attachment_failures
        assert failure.filename == "huge.bin"
        assert "5000 bytes exceeds the 1000 byte limit" in failure.reason
        assert not any("download" in r.url.path for r in homeserver.requests)

    async def test_a_file_that_understated_its_size_is_stopped_while_downloading(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.media["mxc://example.org/liar"] = (b"x" * 5000, "text/plain")
        event = message_event(
            "$liar",
            "small.txt",
            msgtype="m.file",
            url="mxc://example.org/liar",
            info={"size": 10},
        )
        recorder, _, _ = await _deliver(monkeypatch, [event], homeserver)
        [failure] = recorder.messages[0].attachment_failures
        assert "1000 byte limit" in failure.reason

    async def test_an_encrypted_file_is_disclosed_rather_than_dropped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        event = message_event(
            "$enc", "secret.txt", msgtype="m.file", file={"url": "mxc://example.org/e"}
        )
        recorder, _, _ = await _deliver(monkeypatch, [event])
        [failure] = recorder.messages[0].attachment_failures
        assert "encrypted" in failure.reason

    async def test_a_download_redirected_within_the_homeserver_is_followed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.media_redirects["mxc://example.org/moved"] = (
            "https://matrix.example.org/media-store/moved"
        )
        homeserver.media["store:moved"] = (b"the file", "text/plain")
        event = message_event(
            "$f", "notes.txt", msgtype="m.file", url="mxc://example.org/moved", info={}
        )
        recorder, _, _ = await _deliver(monkeypatch, [event], homeserver)
        assert recorder.messages[0].attachments[0].data == b"the file"

    async def test_a_download_redirected_off_the_homeserver_is_not_followed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every request carries the bot's token, and a redirect's own body is
        not the file."""
        homeserver = FakeHomeserver()
        homeserver.media_redirects["mxc://example.org/away"] = (
            "https://cdn.example.net/away"
        )
        event = message_event(
            "$f", "notes.txt", msgtype="m.file", url="mxc://example.org/away", info={}
        )
        recorder, homeserver, _ = await _deliver(monkeypatch, [event], homeserver)
        [failure] = recorder.messages[0].attachment_failures
        assert "redirect off the homeserver" in failure.reason
        assert not any(r.url.host == "cdn.example.net" for r in homeserver.requests)

    async def test_a_download_failure_is_disclosed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        event = message_event(
            "$gone",
            "gone.txt",
            msgtype="m.file",
            url="mxc://example.org/missing",
            info={},
        )
        recorder, _, _ = await _deliver(monkeypatch, [event])
        [failure] = recorder.messages[0].attachment_failures
        assert failure.reason.startswith("download failed")


class TestReactions:
    def _card(self, homeserver: FakeHomeserver) -> None:
        homeserver.put_event(
            ROOM,
            {
                "event_id": "$card",
                "sender": BOT,
                "type": "m.room.message",
                "content": {
                    "msgtype": "m.text",
                    "body": "Permission needed",
                    "com.switch.publication": {"token": "tok-1", "kind": "request"},
                    "m.relates_to": {"rel_type": "m.thread", "event_id": "$root"},
                },
            },
        )

    def _reaction(self, key: str, target: str = "$card") -> dict[str, Any]:
        return {
            "type": "m.reaction",
            "event_id": f"$react-{key}",
            "sender": ALICE,
            "content": {
                "m.relates_to": {
                    "rel_type": "m.annotation",
                    "event_id": target,
                    "key": key,
                }
            },
        }

    async def test_a_keycap_on_a_card_is_a_press_of_that_option(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        self._card(homeserver)
        recorder, _, _ = await _deliver(
            monkeypatch, [self._reaction("2\ufe0f\u20e3")], homeserver
        )
        [press] = recorder.interactions
        assert parse_answer_position(press.action_id) == 2
        assert press.value == "tok-1"
        assert press.message_ref == "$card"
        assert press.thread_ref == "$root"
        assert (press.sender_id, press.sender_name) == (ALICE, "alice")

    async def test_a_keycap_without_its_variation_selector_counts_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        self._card(homeserver)
        recorder, _, _ = await _deliver(
            monkeypatch, [self._reaction("1\u20e3")], homeserver
        )
        assert parse_answer_position(recorder.interactions[0].action_id) == 1

    async def test_other_reactions_and_other_messages_are_not_answers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        self._card(homeserver)
        homeserver.put_event(ROOM, message_event("$human", "a person's message"))
        homeserver.put_event(
            ROOM,
            {
                "event_id": "$status",
                "sender": BOT,
                "type": "m.room.message",
                "content": {
                    "body": "Working…",
                    "com.switch.publication": {"token": "t", "kind": "turn"},
                },
            },
        )
        recorder, _, _ = await _deliver(
            monkeypatch,
            [
                self._reaction("\U0001f44d"),
                self._reaction("1\ufe0f\u20e3", target="$human"),
                self._reaction("3\ufe0f\u20e3", target="$status"),
            ],
            homeserver,
        )
        assert recorder.interactions == []

    async def test_a_forged_card_from_anyone_but_the_bot_answers_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Anyone can put the marker in a message of their own, a real card's
        token included. Only the bot's own events are cards."""
        homeserver = FakeHomeserver()
        homeserver.put_event(
            ROOM,
            {
                "event_id": "$forged",
                "sender": ALICE,
                "type": "m.room.message",
                "content": {
                    "msgtype": "m.text",
                    "body": "Permission needed",
                    "com.switch.publication": {"token": "tok-1", "kind": "request"},
                },
            },
        )
        reaction = self._reaction("1\ufe0f\u20e3", target="$forged")
        reaction["sender"] = "@mallory:example.org"
        recorder, _, _ = await _deliver(monkeypatch, [reaction], homeserver)
        assert recorder.interactions == []
