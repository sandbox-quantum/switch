"""Reading Webex messages, writing ones Webex takes, and the card a press comes from."""

from __future__ import annotations

from switch_core.bridges.collaboration.adapter import AgentRendering
from switch_core.bridges.collaboration.session.renderers import Control
from switch_core.bridges.collaboration.webex.cards import (
    CARD_CONTENT_TYPE,
    card_attachment,
    read_press,
    request_card,
)
from switch_core.bridges.collaboration.webex.client import (
    WebexId,
    decode_id,
    is_webex_url,
    same_entity,
)
from switch_core.bridges.collaboration.webex.text import (
    MAX_MESSAGE_BYTES,
    chunk,
    defuse_raw_mentions,
    read_message,
    render_mentions,
)

BOT_UUID = "11111111-2222-3333-4444-555555555555"
BOT = WebexId("us", "PEOPLE", BOT_UUID).encode()
ADA = WebexId("us", "PEOPLE", "aaaaaaaa-0000-0000-0000-000000000001").encode()


def test_ids_round_trip_and_compare_however_written() -> None:
    decoded = decode_id(BOT)
    assert decoded == WebexId("us", "PEOPLE", BOT_UUID)
    # A mention in a message's HTML carries the id padded; the API does not.
    padded = BOT + "=" * (-len(BOT) % 4)
    assert same_entity(padded, BOT)
    # The event socket names the bare uuid.
    assert same_entity(BOT_UUID, BOT)
    assert not same_entity(ADA, BOT)
    assert decode_id("not-an-id") is None


def test_an_organisation_outside_the_us_keeps_its_cluster() -> None:
    eu = WebexId("urn:TEAM:eu-central-1_k", "ROOM", "abc").encode()
    assert decode_id(eu) == WebexId("urn:TEAM:eu-central-1_k", "ROOM", "abc")


def test_the_token_only_goes_to_webex_hosts() -> None:
    assert is_webex_url("https://webexapis.com/v1/messages")
    assert is_webex_url("https://wdm-a.wbx2.com/wdm/api/v1/devices")
    assert not is_webex_url("http://webexapis.com/v1/messages")
    assert not is_webex_url("https://webexapis.com.evil.example/v1")
    assert not is_webex_url("https://evil.example/?u=webexapis.com")


def test_the_bots_mention_is_the_address_not_the_message() -> None:
    html = (
        f'<p><spark-mention data-object-type="person" data-object-id="{BOT}=">'
        "Switch</spark-mention> ask "
        f'<spark-mention data-object-type="person" data-object-id="{ADA}">Ada</spark-mention>'
        " about <strong>this</strong> and <code>main.py</code></p>"
    )
    inbound = read_message({"html": html, "text": "Switch ask Ada about this"}, BOT)
    assert inbound.mentions_bot
    assert inbound.text == "ask @Ada about **this** and `main.py`"
    assert inbound.mentioned_people == [ADA]


def test_code_blocks_lists_and_links_survive_the_trip() -> None:
    html = (
        "<p>Steps:</p><ol><li>run it</li><li>read the log</li></ol>"
        '<pre><code class="language-python">print("hi")\n</code></pre>'
        '<p>see <a href="https://example.com/x">the docs</a></p>'
    )
    text = read_message({"html": html}, BOT).text
    assert text == (
        "Steps:\n\n1. run it\n2. read the log\n\n"
        '```\nprint("hi")\n```\n\nsee [the docs](https://example.com/x)'
    )


def test_a_message_without_html_is_read_from_its_text() -> None:
    inbound = read_message({"text": "  plain words ", "mentionedPeople": [BOT]}, BOT)
    assert inbound.text == "plain words"
    assert inbound.mentions_bot


def test_a_group_mention_is_kept_as_a_word() -> None:
    html = '<p><spark-mention data-object-type="groupMention" data-group-type="all">All</spark-mention> hello</p>'
    assert read_message({"html": html}, BOT).text == "All hello"


def test_long_text_is_split_within_webex_byte_limit() -> None:
    paragraph = "é" * 1000  # two bytes each
    text = "\n\n".join([paragraph] * 10)
    parts = chunk(text)
    assert len(parts) > 1
    assert all(len(part.encode()) <= MAX_MESSAGE_BYTES for part in parts)
    assert "".join(parts).replace("\n", "") == text.replace("\n", "")


def test_a_split_inside_code_closes_and_reopens_the_fence() -> None:
    code = "\n".join(f"line {n} " + "x" * 60 for n in range(200))
    parts = chunk(f"Here:\n```\n{code}\n```\ndone", 4000)
    assert len(parts) > 1
    for part in parts:
        assert part.count("```") % 2 == 0, part[:80]
        assert len(part.encode()) <= 4000


def test_short_text_is_one_message() -> None:
    assert chunk("hello") == ["hello"]


def test_known_people_become_real_mentions_and_nobody_else_does() -> None:
    targets = {"ada": ADA, "ada.l": BOT}
    out = render_mentions("thanks @ada and @ada.l, not @adam or me@ada.com", targets)
    assert f"<@personId:{ADA}|ada>" in out
    assert f"<@personId:{BOT}|ada.l>" in out
    assert "@adam" in out
    assert "me@ada.com" in out


def test_a_body_cannot_mention_people_with_raw_markup() -> None:
    out = defuse_raw_mentions("hi <@personEmail:boss@corp.com> and <@all>")
    assert "<@" not in out
    assert "personEmail:boss@corp.com" in out


def _agent() -> AgentRendering:
    return AgentRendering(
        field_label="coder", body_label="coder", icon_url="https://example.com/a.png"
    )


def test_a_request_card_has_a_button_per_option_carrying_only_token_and_number() -> (
    None
):
    card = request_card(
        _agent(),
        "**Permission needed**\nRun `rm -rf build`?\n1. Allow\n2. Deny",
        "tok-1",
        [Control(position=1, label="Allow"), Control(position=2, label="Deny")],
    )
    assert card["version"] == "1.3"
    actions = card["actions"]
    assert [a["title"] for a in actions] == ["1. Allow", "2. Deny"]
    assert all(a["type"] == "Action.Submit" for a in actions)
    assert actions[1]["data"] == {"switch": "answer", "token": "tok-1", "position": 2}
    assert card_attachment(card)["contentType"] == CARD_CONTENT_TYPE
    # The list stays one block, so it renders as one list.
    texts = [b["text"] for b in card["body"][1:]]
    assert "1. Allow\n2. Deny" in texts


def test_a_settled_card_has_no_buttons() -> None:
    card = request_card(_agent(), "Allowed by ada", "tok-1", [])
    assert "actions" not in card


def test_a_press_is_read_strictly() -> None:
    assert read_press({"switch": "answer", "token": "tok-1", "position": 2}) == (
        "tok-1",
        2,
    )
    # Webex may hand numbers back as strings.
    assert read_press({"switch": "answer", "token": "tok-1", "position": "2"}) == (
        "tok-1",
        2,
    )
    assert read_press({"token": "tok-1", "position": 2}) is None
    assert read_press({"switch": "answer", "token": "", "position": 2}) is None
    assert read_press({"switch": "answer", "token": "t", "position": 0}) is None
    assert read_press({"switch": "answer", "token": "t", "position": True}) is None
    assert read_press("nope") is None
