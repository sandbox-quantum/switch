"""Inbound signal-cli events: one SSE line at a time into Inbound models.

The daemon's `/api/v1/events` is a stream of `receive` notifications, each
an envelope plus the account it arrived for. Everything this module decides
is decided from the event alone, so a second pod reading the same replay
derives the same `InboundMessage` — the dedupe is the router's
`message_ref`, not anything kept in one process.
"""

from __future__ import annotations

import json
import logging
import re
from bisect import bisect_left, bisect_right
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)

#: Envelope fields that identify the sender, in fallback order. The
#: `sourceUuid` is the stable one (it survives a number change), the number
#: is the fallback, and the name is display-only.
_SOURCE_ID_FIELDS = ("sourceUuid", "sourceNumber")

#: Envelope bodies that are not things the room should see: delivery and
#: read receipts, the other party's typing, sync messages from the account's
#: own devices, calls and stories, and edits of an already-relayed message
#: (the phone shows those; the room does not need a second copy).
_IGNORED_BODIES = (
    "receiptMessage",
    "typingMessage",
    "syncMessage",
    "callMessage",
    "storyMessage",
    "editMessage",
)

#: The style names signal-cli 0.14.x accepts, to the Markdown marker each
#: reads back as. A style outside this set leaves its span as the text the
#: phone showed it.
_STYLE_MARKERS = {
    "BOLD": "**",
    "ITALIC": "*",
    "STRIKETHROUGH": "~~",
    "MONOSPACE": "`",
}


class InboundEvent:
    """One `receive` notification, parsed out of the SSE stream.

    `envelope` is the signal-cli `messageEnvelope` object (as in the
    `signal_fixtures/sse_*.json` captures) and `account` the account the
    event was for. `sse_id` is the stream's `id:` line — the value a
    reconnect sends back as `Last-Event-ID`, or `None` for an event the
    stream did not label.
    """

    def __init__(
        self, *, envelope: dict[str, Any], account: str, sse_id: str | None
    ) -> None:
        self.envelope = envelope
        self.account = account
        self.sse_id = sse_id

    @property
    def sender_id(self) -> str:
        for field in _SOURCE_ID_FIELDS:
            value = self.envelope.get(field)
            if value:
                return str(value)
        return self.account


async def parse_sse_stream(lines: AsyncIterator[str]) -> AsyncIterator[InboundEvent]:
    """The `receive` events of a live SSE stream, one at a time.

    The stream is `id:`/`event:`/`data:` lines with blank-line separators.
    Anything that is not a `receive` event the daemon emits is skipped, and
    a `data:` line that is not JSON is skipped with a log line, never
    raised: one unreadable event must not tear down the stream.
    """
    current: dict[str, Any] = {}

    def complete() -> InboundEvent | None:
        data = current.get("data")
        if current.get("event") == "receive" and isinstance(data, dict):
            envelope = data.get("envelope")
            account = data.get("account")
            if isinstance(envelope, dict) and account:
                return InboundEvent(
                    envelope=envelope, account=str(account), sse_id=current.get("id")
                )
        return None

    async for raw_line in lines:
        line = raw_line.rstrip("\r\n")
        if line.startswith("id:"):
            event = complete()
            if event:
                yield event
            current = {"id": line[3:]}
        elif line.startswith("event:"):
            current["event"] = line[6:]
        elif line.startswith("data:"):
            try:
                current["data"] = json.loads(line[5:])
            except ValueError:
                logger.warning(
                    "Skipping an unreadable signal-cli SSE data line: %s", line[:200]
                )
                current.pop("data", None)
        elif line.strip() == "":
            event = complete()
            if event:
                yield event
            current = {}
    event = complete()
    if event:
        yield event


def message_event(event: InboundEvent) -> bool:
    """Whether this event carries something the room should see.

    A `dataMessage` with text or attachments. Ignored, like Telegram does:
    the bodies in `_IGNORED_BODIES`, and a message the bot's own account
    sent from another of its devices, so one account posting on two
    clients cannot feed itself.
    """
    envelope = event.envelope
    for ignored in _IGNORED_BODIES:
        if ignored in envelope:
            return False
    source = str(envelope.get("sourceNumber") or "")
    if source and source == event.account:
        return False
    data = envelope.get("dataMessage")
    if not isinstance(data, dict):
        return False
    # A body that is only a delete, a reaction, a poll or the like has no
    # `message` and no `attachments`, so the last line says no on its own.
    return bool(data.get("message") or data.get("attachments"))


def channel_id_of(event: InboundEvent) -> str:
    """The Switch channel id this event belongs to.

    A group event carries the group id on `dataMessage.groupInfo` (the
    typing and receipt variants carry their own), so it is the group the
    message was in; a DM carries no group and is the sender's account —
    the one side the bot addresses its replies to.
    """
    envelope = event.envelope
    for body_key in ("dataMessage", "typingMessage", "receiptMessage"):
        body = envelope.get(body_key)
        if isinstance(body, dict):
            group = body.get("groupInfo")
            if isinstance(group, dict) and group.get("groupId"):
                return f"g:{group['groupId']}"
            if body.get("groupId"):
                return f"g:{body['groupId']}"
    return f"d:{event.sender_id}"


def message_ref_of(event: InboundEvent) -> str:
    """The Switch `message_ref` of this event: who sent it, and when, in
    Signal's own terms. Every redelivery of the same event computes the
    same string, so the router dedupes it; and a quote-reply, an edit and
    a reaction all address the target by exactly this pair.

    The identifier is the event's own, never the target of an edit or
    delete: a second edit of the same message gets a new identifier and is
    not dropped as a duplicate.
    """
    data = event.envelope.get("dataMessage")
    if isinstance(data, dict) and data.get("timestamp") is not None:
        return f"{event.sender_id}:{int(data['timestamp'])}"
    return f"{event.sender_id}:{int(event.envelope.get('timestamp') or 0)}"


def root_id_of(event: InboundEvent) -> str | None:
    """The quoted message this one replies to, as a `message_ref`, or None.

    A reply in Signal is a quote, so this is where `InboundMessage.root_id`
    and `InboundCommand.root_id` come from; a card answered by quote-reply
    is answered *to* the card's ref and the core resolves it. The quote
    carries the author's `uuid` (falling back to the number) and the
    target's `id`, so the answer needs no state kept in one process.
    """
    data = event.envelope.get("dataMessage")
    if not isinstance(data, dict):
        return None
    quote = data.get("quote")
    if not isinstance(quote, dict) or quote.get("id") is None:
        return None
    author = str(quote.get("authorUuid") or quote.get("author") or "")
    return f"{author}:{int(quote['id'])}"


def _code_point_offsets(text: str) -> list[int]:
    """`offsets[i]` = the UTF-16 code unit where the i-th code point
    begins, with one past-the-end total at the end."""
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xFFFF else 1))
    return offsets


def _cp_bounds(text: str, start: int, length: int) -> tuple[int, int]:
    """A `start:length` span in Signal's UTF-16 units, as `[i:j)` code
    points of `text`.

    The send side writes ranges in UTF-16 code units (an emoji is two, so
    the offsets the phone reports do not count Python characters), and a
    range that does not land on a code-point boundary — a mismatched
    sender's client — snaps to the next boundary rather than splitting a
    character.
    """
    if not text or length <= 0:
        return 0, 0
    offsets = _code_point_offsets(text)
    total = offsets[-1]
    start = max(0, min(start, total))
    end = max(start, min(start + length, total))
    i = min(bisect_left(offsets, start), len(text))
    j = min(bisect_right(offsets, end), len(text))
    return i, j


def inbound_markdown(
    message: str,
    styles: list[dict[str, Any]],
    mentions: list[dict[str, Any]],
) -> str:
    """The room's Markdown of an inbound Signal text.

    `styles` and `mentions` are the sender's ranges over `message`, both in
    UTF-16 code units (as Signal writes them and as the send side sends):
    a style span becomes the Markdown marker it reads back as, and a
    mention becomes `@Name`, the room's stand-in for the phone's tap-able
    mention. Spans are spliced back-to-front so no splice shifts an offset
    a later one still uses. Ranges are independent; spans that overlap
    without nesting (Signal does not send them) degrade to readable text.
    """
    if not styles and not mentions:
        return message
    spans: list[tuple[int, int, str]] = []
    for style in styles:
        i, j = _cp_bounds(
            message, int(style.get("start") or 0), int(style.get("length") or 0)
        )
        if i < j:
            spans.append((i, j, "style:" + str(style.get("style") or "")))
    for mention in mentions:
        i, j = _cp_bounds(
            message, int(mention.get("start") or 0), int(mention.get("length") or 0)
        )
        if i < j:
            name = str(mention.get("name") or mention.get("number") or message[i:j])
            spans.append((i, j, "mention:" + name))
    spans.sort(key=lambda span: span[0], reverse=True)
    text = message
    for i, j, kind in spans:
        segment = text[i:j]
        if kind.startswith("mention:"):
            replacement = "@" + kind.split(":", 1)[1]
        else:
            marker = _STYLE_MARKERS.get(kind.split(":", 1)[1])
            replacement = f"{marker}{segment}{marker}" if marker else segment
        text = text[:i] + replacement + text[j:]
    return text


_COMMAND_NAME = re.compile(r"[a-z0-9_-]+")


def parse_command(text: str) -> tuple[str, str] | None:
    """Switch's `!command` out of a message, or None when it is not one.

    `!` is the prefix the room already knows, so a message that is not a
    command never reaches the dispatcher: anything that does not open with
    it is text. The name is the word after the `!`; the rest of the line is
    the argument, verbatim. Whether a command has a handler is the
    dispatcher's answer, not this parse's.
    """
    if not text or text[0] != "!":
        return None
    body = text[1:]
    match = _COMMAND_NAME.match(body)
    if not match:
        return None
    name = match.group(0)
    args = body[match.end() :].strip()
    return name, args
