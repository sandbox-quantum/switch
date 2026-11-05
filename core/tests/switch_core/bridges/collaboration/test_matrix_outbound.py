"""What the Matrix bridge sends to the homeserver."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    RequestCard,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.matrix import client as client_module
from switch_core.bridges.collaboration.matrix.adapter import MatrixAdapter
from switch_core.bridges.collaboration.matrix.chunking import (
    MAX_BODY_BYTES,
    split_message,
)
from switch_core.bridges.collaboration.matrix.formatting import to_html
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
)
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalOption,
    SnapshotRequest,
    TurnUpsert,
)
from tests.switch_core.bridges.collaboration.matrix_fakes import (
    ALICE,
    BOT,
    ROOM,
    FakeHomeserver,
    Recorder,
    make_adapter,
    start,
)

ONE = "1\ufe0f\u20e3"
TWO = "2\ufe0f\u20e3"


async def _adapter(
    monkeypatch: pytest.MonkeyPatch, homeserver: FakeHomeserver | None = None
) -> tuple[MatrixAdapter, FakeHomeserver]:
    homeserver = homeserver or FakeHomeserver()
    adapter = make_adapter(monkeypatch, homeserver, listening=False)
    await start(adapter, Recorder())
    return adapter, homeserver


def _last(homeserver: FakeHomeserver) -> dict[str, Any]:
    return homeserver.messages_to(ROOM)[-1].content


class TestMessages:
    async def test_a_reply_goes_out_under_the_agents_name_as_html(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        ref = await adapter.send_message(ROOM, "coder", "Done: **all** tests pass")
        content = _last(homeserver)
        assert ref == homeserver.messages_to(ROOM)[-1].event_id
        assert content["msgtype"] == "m.text"
        assert content["body"] == "**coder**: Done: **all** tests pass"
        assert content["format"] == "org.matrix.custom.html"
        assert content["formatted_body"] == (
            "<strong>coder</strong>: Done: <strong>all</strong> tests pass"
        )
        assert content["m.mentions"] == {"user_ids": []}
        assert "m.relates_to" not in content

    async def test_a_multi_line_reply_puts_the_name_on_its_own_line(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.send_message(ROOM, "coder", "first\nsecond")
        assert _last(homeserver)["body"] == "**coder**\nfirst\nsecond"

    async def test_a_reply_in_a_thread_stays_in_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.send_message(ROOM, "coder", "in thread", thread_root_id="$root")
        assert _last(homeserver)["m.relates_to"] == {
            "rel_type": "m.thread",
            "event_id": "$root",
            "is_falling_back": True,
            "m.in_reply_to": {"event_id": "$root"},
        }

    async def test_a_long_reply_is_split_on_lines_each_part_attributed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        text = "\n".join(f"line {i}: " + "word " * 20 for i in range(200))
        first = await adapter.send_message(ROOM, "coder", text, thread_root_id="$root")
        parts = homeserver.messages_to(ROOM)
        assert len(parts) > 1
        assert first == parts[0].event_id
        for part in parts:
            assert part.content["body"].startswith("**coder**\n")
            assert len(part.content["body"].encode()) <= MAX_BODY_BYTES
            assert part.content["m.relates_to"]["event_id"] == "$root"
        rejoined = "\n".join(
            p.content["body"].removeprefix("**coder**\n") for p in parts
        )
        assert rejoined == text

    async def test_a_person_switch_knows_is_mentioned_as_a_pill(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        adapter.prime_mention_targets({"alice": ALICE})
        await adapter.send_message(
            ROOM,
            "coder",
            adapter.translate_outbound("@alice see `@alice` and @nobody."),
        )
        content = _last(homeserver)
        assert content["m.mentions"] == {"user_ids": [ALICE]}
        assert content["body"] == "**coder**: @alice see `@alice` and @nobody."
        assert (
            f'<a href="https://matrix.to/#/{ALICE}">@alice</a>'
            in content["formatted_body"]
        )
        assert "<code>@alice</code>" in content["formatted_body"]

    async def test_a_full_user_id_becomes_a_pill_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.send_message(
            ROOM, "coder", adapter.translate_outbound("ping @bob:other.example.")
        )
        content = _last(homeserver)
        assert content["m.mentions"]["user_ids"] == ["@bob:other.example"]
        assert content["body"] == "**coder**: ping @bob.other.example."

    async def test_a_mass_mention_in_text_pages_nobody(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.send_message(
            ROOM, "coder", adapter.translate_outbound("@room @here")
        )
        assert "room" not in _last(homeserver)["m.mentions"]

    async def test_a_room_wide_mention_the_server_marked_pages_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        body = adapter.render_room_wide_mention("@everyone deploy at five")
        await adapter.send_message(ROOM, "coder", body, room_wide_mention=True)
        content = _last(homeserver)
        assert content["body"] == "**coder**: @room deploy at five"
        assert content["m.mentions"]["room"] is True
        assert adapter.room_wide_mention_notifies is True

    async def test_raw_html_from_an_agent_is_shown_not_rendered(self) -> None:
        assert to_html("<img src=x> & <b>bold</b>") == (
            "&lt;img src=x&gt; &amp; &lt;b&gt;bold&lt;/b&gt;"
        )

    async def test_a_link_to_anything_but_the_web_keeps_only_its_text(self) -> None:
        assert to_html("[click](javascript:alert(1)) [ok](https://example.org)") == (
            '<span>click</span> <a href="https://example.org">ok</a>'
        )

    @pytest.mark.parametrize(
        "text",
        [
            '[x](javascript:alert(1) "a title")',
            '[x][r]\n\n[r]: javascript:alert(1) "title"',
            "[x](JaVaScRiPt:alert(1))",
            "[x](  javascript:alert(1))",
            "[x](data:text/html;base64,PHNjcmlwdD4=)",
            "[x](vbscript:msgbox)",
            "[x](relative/path)",
        ],
    )
    async def test_no_way_of_writing_a_link_gets_an_unsafe_target_through(
        self, text: str
    ) -> None:
        html = to_html(text)
        assert "href" not in html
        assert "x" in html

    async def test_a_remote_image_is_reduced_to_its_description(self) -> None:
        """A remote image is a request to wherever the agent chose, from the
        client of everyone who reads it."""
        html = to_html("see ![the chart](https://tracker.example/pixel.png)")
        assert "<img" not in html
        assert "tracker.example" not in html
        assert "the chart" in html

    async def test_a_homeserver_image_is_kept_with_its_scheme_as_clients_read_it(
        self,
    ) -> None:
        html = to_html("![chart](MXC://example.org/abc)")
        assert 'src="mxc://example.org/abc"' in html

    async def test_a_list_under_a_sentence_is_a_list(self) -> None:
        assert "<li>a</li>" in to_html("Steps:\n- a\n- b")

    async def test_a_refused_send_returns_no_reference(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={
                ("PUT", r"/send/"): (403, {"errcode": "M_FORBIDDEN", "error": "no"})
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        assert await adapter.send_message(ROOM, "coder", "hello") is None

    async def test_a_rate_limit_is_waited_out_and_the_message_sent_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(rate_limited={("PUT", r"/send/"): 2})
        adapter, _ = await _adapter(monkeypatch, homeserver)
        ref = await adapter.send_message(ROOM, "coder", "hello")
        [sent] = homeserver.messages_to(ROOM)
        assert ref == sent.event_id
        # The same transaction each time, so a retry the homeserver had in
        # fact taken is answered with the event it made.
        attempts = [r.url.path for r in homeserver.requests if "/send/" in r.url.path]
        assert len(attempts) == 3 and len(set(attempts)) == 1

    async def test_a_long_reply_the_homeserver_stops_taking_is_visibly_cut(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        adapter, _ = await _adapter(monkeypatch, homeserver)
        text = "\n".join(f"line {i}: " + "word " * 20 for i in range(200))
        sent_parts: list[str] = []
        original = homeserver._route

        async def limit_after_first(
            method: str, path: str, request: Any, body: Any
        ) -> Any:
            if (
                "/send/m.room.message/" in path
                and sent_parts
                and body.get("msgtype") != "m.notice"
            ):
                # An hour: more than any one wait is allowed to be.
                return httpx.Response(
                    429,
                    json={"errcode": "M_LIMIT_EXCEEDED", "retry_after_ms": 3_600_000},
                )
            response = await original(method, path, request, body)
            if "/send/" in path:
                sent_parts.append(body.get("body", ""))
            return response

        monkeypatch.setattr(homeserver, "_route", limit_after_first)
        first = await adapter.send_message(ROOM, "coder", text)
        parts = homeserver.messages_to(ROOM)
        assert first == parts[0].event_id
        [notice] = [p for p in parts if p.content["msgtype"] == "m.notice"]
        assert "Only 1 of" in notice.content["body"]
        assert "could not be confirmed delivered" in notice.content["body"]
        assert homeserver.waits == []

    @pytest.mark.parametrize("wait_ms", [0, None], ids=["zero", "unnamed"])
    async def test_a_limit_naming_no_wait_is_waited_a_second_a_few_times(
        self, monkeypatch: pytest.MonkeyPatch, wait_ms: int | None
    ) -> None:
        """Without a floor, `retry_after_ms: 0` would resend at once, forever."""
        homeserver = FakeHomeserver(
            rate_limited={("PUT", r"/send/"): 1000}, rate_limit_wait_ms=wait_ms
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        assert await adapter.send_message(ROOM, "coder", "hello") is None
        attempts = [r for r in homeserver.requests if "/send/" in r.url.path]
        assert len(attempts) == client_module.RATE_LIMIT_ATTEMPTS + 1
        assert homeserver.waits == [1.0] * client_module.RATE_LIMIT_ATTEMPTS
        assert homeserver.messages_to(ROOM) == []

    async def test_a_wait_longer_than_a_minute_is_not_taken(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            rate_limited={("PUT", r"/send/"): 1}, rate_limit_wait_ms=3_600_000
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        assert await adapter.send_message(ROOM, "coder", "hello") is None
        assert homeserver.waits == []

    async def test_a_waits_total_is_capped_for_one_request(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            rate_limited={("PUT", r"/send/"): 1000}, rate_limit_wait_ms=12_000
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        assert await adapter.send_message(ROOM, "coder", "hello") is None
        assert homeserver.waits == [12.0, 12.0]
        assert sum(homeserver.waits) <= client_module.RATE_LIMIT_BUDGET_SECONDS

    async def test_one_reply_shares_one_wait_budget_across_its_parts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Each part waiting out its own limit would let one reply stall for
        minutes; past the reply's budget it is cut, visibly."""
        homeserver = FakeHomeserver(rate_limit_wait_ms=20_000)
        adapter, _ = await _adapter(monkeypatch, homeserver)
        seen: set[str] = set()
        original = homeserver._route

        async def limit_each_new_send_once(
            method: str, path: str, request: Any, body: Any
        ) -> Any:
            if "/send/m.room.message/" in path and path not in seen:
                seen.add(path)
                return httpx.Response(
                    429, json={"errcode": "M_LIMIT_EXCEEDED", "retry_after_ms": 20_000}
                )
            return await original(method, path, request, body)

        monkeypatch.setattr(homeserver, "_route", limit_each_new_send_once)
        text = "\n".join(f"line {i}: " + "word " * 30 for i in range(400))
        first = await adapter.send_message(ROOM, "coder", text)
        parts = homeserver.messages_to(ROOM)
        assert first == parts[0].event_id
        # Three parts at 20 s each spend the minute; the fourth is not waited for.
        [notice] = [p for p in parts if p.content["msgtype"] == "m.notice"]
        assert notice.content["body"].startswith("\u26a0\ufe0f Only 3 of")
        assert len(parts) == 4
        assert homeserver.waits == [20.0] * 4  # the notice waits on its own

    async def test_an_admin_message_is_a_notice_from_the_bot(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.admin_message(ROOM, "No agents are in this room yet.", "$root")
        content = _last(homeserver)
        assert content["msgtype"] == "m.notice"
        assert content["body"] == "No agents are in this room yet."
        assert content["m.relates_to"]["event_id"] == "$root"


class TestEditsAndDeletes:
    async def test_an_edit_replaces_the_message_in_place(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.update_message(ROOM, "$orig", "**new** text")
        content = _last(homeserver)
        assert content["m.relates_to"] == {"rel_type": "m.replace", "event_id": "$orig"}
        assert content["m.new_content"]["body"] == "**new** text"
        assert content["m.new_content"]["formatted_body"] == "<strong>new</strong> text"
        assert content["body"] == "* **new** text"
        assert content["m.mentions"] == {}

    async def test_a_delete_is_a_redaction(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.delete_message(ROOM, "$gone")
        assert homeserver.redacted == [(ROOM, "$gone")]


class TestTypingAndMarks:
    async def test_typing_is_switched_on_and_off(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.send_typing(ROOM, "coder", True)
        await adapter.send_typing(ROOM, "coder", False)
        assert homeserver.typing == [
            (ROOM, {"typing": True, "timeout": 30000}),
            (ROOM, {"typing": False}),
        ]

    async def test_the_working_mark_is_a_reaction_taken_off_by_redaction(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.mark_activity(
            ROOM, "$ask", agent_name="coder", mark="working", on=True
        )
        [reaction] = [s for s in homeserver.sent if s.event_type == "m.reaction"]
        assert reaction.content["m.relates_to"] == {
            "rel_type": "m.annotation",
            "event_id": "$ask",
            "key": "\U0001f440",
        }
        homeserver.relations[("$ask", "m.annotation")] = [
            {"event_id": reaction.event_id, "sender": BOT, "content": reaction.content},
            {
                "event_id": "$someone-elses",
                "sender": ALICE,
                "content": reaction.content,
            },
        ]
        await adapter.mark_activity(
            ROOM, "$ask", agent_name="coder", mark="working", on=False
        )
        assert homeserver.redacted == [(ROOM, reaction.event_id)]

    async def test_a_mark_already_there_is_not_an_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={
                ("PUT", r"/send/m\.reaction/"): (
                    400,
                    {"errcode": "M_DUPLICATE_ANNOTATION", "error": "already"},
                )
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        await adapter.mark_activity(
            ROOM, "$ask", agent_name="coder", mark="queued", on=True
        )

    async def test_a_room_that_forbids_reactions_refuses_the_mark(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={("PUT", r"/send/m\.reaction/"): (403, {"errcode": "M_FORBIDDEN"})}
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        with pytest.raises(ActivityMarkRefused):
            await adapter.mark_activity(
                ROOM, "$ask", agent_name="coder", mark="working", on=True
            )

    async def test_no_mark_goes_into_an_encrypted_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.state[(ROOM, "m.room.encryption", "")] = {
            "algorithm": "m.megolm.v1.aes-sha2"
        }
        adapter, _ = await _adapter(monkeypatch, homeserver)
        with pytest.raises(ActivityMarkRefused, match="end-to-end encrypted"):
            await adapter.mark_activity(
                ROOM, "$ask", agent_name="coder", mark="working", on=True
            )
        assert homeserver.sent == []


class TestAttachments:
    async def test_a_file_is_uploaded_and_posted_with_the_agents_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        ref = await adapter.send_attachment(
            ROOM, "coder", "chart.png", "image/png", b"PNG", "the chart", "$root"
        )
        assert homeserver.uploads == [(b"PNG", "image/png", "chart.png")]
        content = _last(homeserver)
        assert ref == homeserver.messages_to(ROOM)[-1].event_id
        assert content["msgtype"] == "m.image"
        assert content["url"].startswith("mxc://example.org/")
        assert content["filename"] == "chart.png"
        assert content["body"] == "**coder**: the chart"
        assert content["info"] == {"mimetype": "image/png", "size": 3}
        assert content["m.relates_to"]["event_id"] == "$root"

    async def test_a_file_over_the_homeservers_limit_is_refused_in_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(
            monkeypatch, FakeHomeserver(upload_limit=2)
        )
        await adapter.send_attachment(
            ROOM, "coder", "big.zip", "application/zip", b"123"
        )
        assert homeserver.uploads == []
        body = _last(homeserver)["body"]
        assert "couldn't be relayed: big.zip" in body
        assert "2-byte upload limit" in body

    async def test_a_file_the_homeserver_refuses_as_too_large_is_said_so(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            upload_limit=None,
            refusals={("POST", r"/upload"): (413, {"errcode": "M_TOO_LARGE"})},
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        await adapter.send_attachment(
            ROOM, "coder", "big.zip", "application/zip", b"123"
        )
        assert "refused it as too large" in _last(homeserver)["body"]

    async def test_a_file_whose_message_is_refused_is_said_so_in_the_room(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        original = homeserver._route

        async def refuse_the_file_message(
            method: str, path: str, request: Any, body: Any
        ) -> Any:
            if "/send/m.room.message/" in path and "url" in body:
                return httpx.Response(403, json={"errcode": "M_FORBIDDEN"})
            return await original(method, path, request, body)

        monkeypatch.setattr(homeserver, "_route", refuse_the_file_message)
        adapter, _ = await _adapter(monkeypatch, homeserver)
        ref = await adapter.send_attachment(
            ROOM, "coder", "chart.png", "image/png", b"PNG", "the chart"
        )
        [notice] = homeserver.messages_to(ROOM)
        assert ref == notice.event_id
        assert "couldn't be relayed: chart.png" in notice.content["body"]
        assert "refused the message carrying it" in notice.content["body"]

    async def test_an_upload_waits_out_a_rate_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(rate_limited={("POST", r"/upload"): 1})
        adapter, _ = await _adapter(monkeypatch, homeserver)
        await adapter.send_attachment(ROOM, "coder", "a.txt", "text/plain", b"x")
        assert len(homeserver.uploads) == 1
        assert _last(homeserver)["msgtype"] == "m.file"

    async def test_a_room_whose_encryption_cannot_be_read_gets_no_file(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={
                ("GET", r"/state/m\.room\.encryption/"): (502, {"errcode": "M_UNKNOWN"})
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        ref = await adapter.send_attachment(ROOM, "coder", "a.txt", "text/plain", b"x")
        assert ref is None
        assert homeserver.uploads == []
        assert homeserver.sent == []


def _option(option_id: str, label: str, decision: str) -> ApprovalOption:
    return ApprovalOption.model_validate(
        {"optionId": option_id, "label": label, "decision": decision}
    )


def _approval(state: str = "open") -> RequestCard:
    request = SnapshotRequest.model_validate(
        {
            "requestId": "req-1",
            "turnId": "turn-1",
            "revision": 1,
            "state": state,
            "expiresAt": None,
            "result": None,
            "decidedBy": None,
            "content": ApprovalContent(
                kind="approval",
                title="Run the build?",
                detail=None,
                options=[
                    _option("yes", "Allow", "accept"),
                    _option("no", "Deny", "decline"),
                ],
            ).model_dump(by_alias=True),
        }
    )
    return RequestCard(
        request=request, reference=RequestReference(token="tok-1", handle="A1")
    )


class TestCards:
    async def test_a_card_is_posted_with_one_reaction_per_option(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        ref = await adapter.post_rich(ROOM, "coder", _approval(), "$root")
        [card] = homeserver.messages_to(ROOM)
        assert card.event_id == ref
        assert card.content["msgtype"] == "m.text"
        assert card.content["com.switch.publication"] == {
            "token": "tok-1",
            "kind": "request",
        }
        body = card.content["body"]
        assert body.startswith("**coder**\n")
        assert "1. Allow" in body and "2. Deny" in body
        assert "`A1 1`" in body
        assert f"Or react with {ONE} {TWO} to choose." in body
        reactions = [
            s.content["m.relates_to"]
            for s in homeserver.sent
            if s.event_type == "m.reaction"
        ]
        assert [(r["event_id"], r["key"]) for r in reactions] == [
            (ref, ONE),
            (ref, TWO),
        ]

    async def test_every_keycap_is_put_on_through_a_rate_limit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A card offering 1️⃣ 2️⃣ with only 1️⃣ under it asks for an answer it
        does not let a reader give."""
        homeserver = FakeHomeserver(rate_limited={("PUT", r"/send/m\.reaction/"): 3})
        adapter, homeserver = await _adapter(monkeypatch, homeserver)
        ref = await adapter.post_rich(ROOM, "coder", _approval(), None)
        keys = [
            s.content["m.relates_to"]["key"]
            for s in homeserver.sent
            if s.event_type == "m.reaction"
        ]
        assert keys == [ONE, TWO]
        assert homeserver.messages_to(ROOM)[0].event_id == ref

    async def test_a_card_in_an_encrypted_room_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.state[(ROOM, "m.room.encryption", "")] = {
            "algorithm": "m.megolm.v1.aes-sha2"
        }
        adapter, homeserver = await _adapter(monkeypatch, homeserver)
        with pytest.raises(RichContentFailed, match="end-to-end encrypted"):
            await adapter.post_rich(ROOM, "coder", _approval(), None)
        assert homeserver.sent == []

    async def test_a_settled_card_is_redrawn_and_its_reactions_taken_off(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        ref = await adapter.post_rich(ROOM, "coder", _approval(), None)
        reactions = [s for s in homeserver.sent if s.event_type == "m.reaction"]
        homeserver.relations[(ref, "m.annotation")] = [
            {"event_id": r.event_id, "sender": BOT, "content": r.content}
            for r in reactions
        ]
        await adapter.update_rich(ROOM, "coder", ref, _approval("closed"), None)
        edit = _last(homeserver)
        assert edit["m.relates_to"] == {"rel_type": "m.replace", "event_id": ref}
        assert "react" not in edit["m.new_content"]["body"]
        assert sorted(homeserver.redacted) == sorted(
            (ROOM, r.event_id) for r in reactions
        )

    async def test_a_refused_card_is_reported_as_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={
                ("PUT", r"/send/m\.room\.message/"): (403, {"errcode": "M_FORBIDDEN"})
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        with pytest.raises(RichContentFailed) as caught:
            await adapter.post_rich(ROOM, "coder", _approval(), None)
        assert "1. Allow" in caught.value.text

    async def test_a_rate_limit_longer_than_the_bound_asks_the_caller_to_wait(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A wait longer than the client will sit through is handed to the
        publisher, which schedules the redraw for then."""
        monkeypatch.setattr(client_module, "RATE_LIMIT_BUDGET_SECONDS", 1.0)
        homeserver = FakeHomeserver(
            refusals={
                ("PUT", r"/send/"): (
                    429,
                    {"errcode": "M_LIMIT_EXCEEDED", "retry_after_ms": 2500},
                )
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        with pytest.raises(RichContentThrottled) as caught:
            await adapter.post_rich(ROOM, "coder", _approval(), None)
        assert caught.value.retry_after == 2.5

    async def test_a_turn_status_is_a_notice_carrying_its_marker(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        turn = TurnUpsert.model_validate(
            {
                "type": "turn.upsert",
                "turnId": "t1",
                "status": "running",
                "commandId": None,
            }
        )
        content = TurnActivity(items=[], turn=turn, publication_token="pub-1")
        await adapter.post_rich(ROOM, "coder", content, "$root")
        status = _last(homeserver)
        assert status["msgtype"] == "m.notice"
        assert status["body"] == "**coder**\n**Working…**"
        assert status["com.switch.publication"] == {"token": "pub-1", "kind": "turn"}
        assert not [s for s in homeserver.sent if s.event_type == "m.reaction"]

    async def test_a_lost_card_is_found_again_by_its_marker(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.messages_pages.append(
            {
                "chunk": [
                    {
                        "event_id": "$quoted",
                        "sender": ALICE,
                        "content": {"com.switch.publication": {"token": "tok-1"}},
                    },
                    {
                        "event_id": "$card",
                        "sender": BOT,
                        "content": {"com.switch.publication": {"token": "tok-1"}},
                    },
                ]
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        found = await adapter.find_request_card(
            ROOM, None, "tok-1", datetime.now(UTC), "A1"
        )
        assert found == "$card"

    async def test_a_bare_answer_counts_only_as_the_first_reply(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver()
        homeserver.relations[("$card", "m.thread")] = [
            {"event_id": "$second", "origin_server_ts": 2},
            {"event_id": "$first", "origin_server_ts": 1},
        ]
        adapter, _ = await _adapter(monkeypatch, homeserver)
        assert await adapter.is_first_reply(ROOM, "$card", "$first") is True
        assert await adapter.is_first_reply(ROOM, "$card", "$second") is False


class TestRooms:
    async def test_a_room_is_created_unencrypted_with_its_kind_recorded(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        room_id = await adapter.create_channel(
            "release", "Release planning", channel_type="channel_private"
        )
        assert room_id.startswith("!created")
        [body] = homeserver.created
        assert body["preset"] == "private_chat"
        assert body["visibility"] == "private"
        assert body["creation_content"] == {
            "com.switch.channel_type": "channel_private"
        }
        assert "initial_state" not in body

    async def test_a_group_chat_cannot_be_created_this_way(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, _ = await _adapter(monkeypatch)
        with pytest.raises(ChannelCreationUnsupported):
            await adapter.create_channel("x", "y", channel_type="group")

    async def test_a_refusal_to_create_carries_the_homeservers_words(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={
                ("POST", r"/createRoom"): (
                    403,
                    {"errcode": "M_FORBIDDEN", "error": "room creation is restricted"},
                )
            }
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        with pytest.raises(BridgeOperationError, match="room creation is restricted"):
            await adapter.create_channel("x", "y")

    async def test_a_homeserver_that_encrypts_new_rooms_is_named_as_the_cause(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Synapse's encryption_enabled_by_default_for_room_type adds
        encryption whatever the request asks; the room is left at once and the
        caller told what to change, rather than refused later by the sync."""
        homeserver = FakeHomeserver()
        original = homeserver._route

        async def encrypting(method: str, path: str, request: Any, body: Any) -> Any:
            response = await original(method, path, request, body)
            if path == "/_matrix/client/v3/createRoom":
                room_id = response.json()["room_id"]
                homeserver.state[(room_id, "m.room.encryption", "")] = {
                    "algorithm": "m.megolm.v1.aes-sha2"
                }
            return response

        monkeypatch.setattr(homeserver, "_route", encrypting)
        adapter, _ = await _adapter(monkeypatch, homeserver)
        with pytest.raises(
            BridgeOperationError, match="encryption_enabled_by_default_for_room_type"
        ):
            await adapter.create_dm_channel(
                agent_name="coder", user_name="alice", user_external_id=ALICE
            )
        [left] = homeserver.left
        assert left.startswith("!created")

    async def test_a_direct_room_invites_its_person(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        await adapter.create_dm_channel(
            agent_name="coder", user_name="alice", user_external_id=ALICE
        )
        [body] = homeserver.created
        assert body["is_direct"] is True
        assert body["invite"] == [ALICE]
        assert body["creation_content"] == {"com.switch.channel_type": "direct"}

    async def test_people_are_invited_and_failures_handed_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            refusals={("POST", r"/invite"): (403, {"errcode": "M_FORBIDDEN"})}
        )
        homeserver.state[(ROOM, "m.room.member", ALICE)] = {"membership": "join"}
        adapter, _ = await _adapter(monkeypatch, homeserver)
        left_out = await adapter.add_users_to_channel(
            ROOM, ["alice", "bob"], [ALICE, "@bob:example.org"]
        )
        assert left_out == ["@bob:example.org"]

    async def test_deleting_a_room_makes_the_bot_leave(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        adapter, homeserver = await _adapter(monkeypatch)
        outcome = await adapter.retire_channel(ROOM)
        assert outcome.outcome == "left"
        assert homeserver.left == [ROOM]

    async def test_the_directory_is_searched(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        homeserver = FakeHomeserver(
            directory=[
                {"user_id": ALICE, "display_name": "Alice"},
                {"user_id": BOT, "display_name": "Switch"},
                {"user_id": "@al:other.example"},
            ]
        )
        adapter, _ = await _adapter(monkeypatch, homeserver)
        found = await adapter.search_directory_users("al")
        assert [(u.external_user_id, u.username, u.display_name) for u in found] == [
            (ALICE, "alice", "Alice"),
            ("@al:other.example", "al.other.example", "al.other.example"),
        ]

    async def test_a_room_link_is_https(self, monkeypatch: pytest.MonkeyPatch) -> None:
        adapter, _ = await _adapter(monkeypatch)
        assert await adapter.channel_deeplink(ROOM) == (
            "https://matrix.to/#/!room:example.org?via=example.org"
        )


class TestChunking:
    def test_a_short_message_is_one_piece(self) -> None:
        assert split_message("hello") == ["hello"]

    def test_a_cut_inside_code_closes_and_reopens_the_fence(self) -> None:
        code = "```py\n" + "\n".join("print(1)" for _ in range(3000)) + "\n```"
        pieces = split_message(code)
        assert len(pieces) > 1
        assert all(len(p.encode()) <= MAX_BODY_BYTES for p in pieces)
        assert pieces[0].endswith("\n```")
        assert pieces[1].startswith("```py\n")

    def test_size_is_counted_in_bytes(self) -> None:
        pieces = split_message("é" * 5000)
        assert len(pieces) == 2
        assert all(len(p.encode()) <= MAX_BODY_BYTES for p in pieces)
        assert "".join(pieces) == "é" * 5000

    @pytest.mark.parametrize("language", ["py", "x" * 200])
    def test_no_piece_is_ever_over_the_limit_fences_included(
        self, language: str
    ) -> None:
        code = f"```{language}\n" + "\n".join("y" * 79 for _ in range(500)) + "\n```"
        for limit in (500, 1000, 8000):
            pieces = split_message(code, limit)
            assert len(pieces) > 1
            assert all(len(p.encode()) <= limit for p in pieces), limit

    def test_code_keeps_its_own_spacing_when_a_long_line_is_cut(self) -> None:
        line = "    " + "a b " * 600
        pieces = split_message(f"```\n{line}\n```", 1000)
        rebuilt = "".join(p.removeprefix("```\n").removesuffix("\n```") for p in pieces)
        assert rebuilt == line

    def test_a_block_ending_at_a_cut_is_not_reopened_empty(self) -> None:
        body = "x" * 950
        pieces = split_message(f"```\n{body}\n```\nafter", 1000)
        assert "```\n```" not in "".join(pieces)


class TestHandles:
    async def test_the_first_account_seen_keeps_a_shared_handle(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`@alice.evil.example` here and `@alice` on evil.example are both
        `alice.evil.example`; the second must not take over the first's
        mentions."""
        adapter, homeserver = await _adapter(monkeypatch)
        adapter.prime_mention_targets(
            {"alice.evil.example": "@alice.evil.example:example.org"}
        )
        adapter._remember("@alice:evil.example")
        await adapter.send_message(
            ROOM, "coder", adapter.translate_outbound("@alice.evil.example hi")
        )
        assert _last(homeserver)["m.mentions"]["user_ids"] == [
            "@alice.evil.example:example.org"
        ]
