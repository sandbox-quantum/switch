"""Between Webex message markup and Switch Markdown.

A message a person writes in a Webex client arrives with `text`, and with
`html` once it carries any formatting or a mention. Mentions exist only in the
HTML, as `<spark-mention>` elements naming the person by id, so that is what
is read when it is there: the plain `text` has the mentioned name and nothing
to say whose it is.
"""

from __future__ import annotations

import base64
import binascii
import html
import re
from html.parser import HTMLParser

_ZWSP = "​"

# Webex's own mention syntax in a message the bridge sends.
_MENTION_SYNTAX = re.compile(
    r"<@(?=(?:all|personId:|personEmail:|groupMention:))", re.I
)


def defuse_webex_mentions(text: str) -> str:
    """Break Webex's mention syntax so the text cannot page anyone itself."""
    return _MENTION_SYNTAX.sub(f"<{_ZWSP}@", text)


def person_mention(person_id: str) -> str:
    return f"<@personId:{person_id}>"


_PERSON_UUID = re.compile(r"/PEOPLE/([0-9a-f-]{36})", re.I)


def same_person(a: str, b: str) -> bool:
    """Whether two Webex person ids name the same person.

    An id is base64 of `ciscospark://<region>/PEOPLE/<uuid>`, and the id a
    client writes into a `<spark-mention>` can carry trailing bytes after the
    uuid, so ids are compared by the uuid inside them.
    """
    return a == b or (_person_uuid(a) or a) == (_person_uuid(b) or b)


def _person_uuid(person_id: str) -> str | None:
    try:
        decoded = base64.urlsafe_b64decode(person_id + "=" * (-len(person_id) % 4))
    except (binascii.Error, ValueError):
        return None
    found = _PERSON_UUID.search(decoded.decode("utf-8", errors="replace"))
    return found.group(1).lower() if found else None


class _Reader(HTMLParser):
    def __init__(self, bot_id: str) -> None:
        super().__init__(convert_charrefs=True)
        self._bot_id = bot_id
        self.out: list[str] = []
        self.mentioned_bot = False
        self._mention: str | None = None
        self._href: list[str | None] = []
        self._in_pre = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        found = dict(attrs)
        if tag == "spark-mention":
            kind = found.get("data-object-type")
            target = found.get("data-object-id")
            if kind == "person" and target and same_person(target, self._bot_id):
                self.mentioned_bot = True
                self._mention = "bot"
            elif kind == "groupMention":
                self._mention = "group"
            else:
                self._mention = "person"
            return
        if tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("_")
        elif tag == "code" and not self._in_pre:
            self.out.append("`")
        elif tag == "pre":
            self._in_pre = True
            self.out.append("\n```\n")
        elif tag == "a":
            self._href.append(found.get("href"))
            self.out.append("[")
        elif tag == "br":
            self.out.append("\n")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag in ("p", "div", "blockquote", "ul", "ol"):
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "spark-mention":
            self._mention = None
            return
        if tag in ("strong", "b"):
            self.out.append("**")
        elif tag in ("em", "i"):
            self.out.append("_")
        elif tag == "code" and not self._in_pre:
            self.out.append("`")
        elif tag == "pre":
            self._in_pre = False
            self.out.append("\n```\n")
        elif tag == "a":
            href = self._href.pop() if self._href else None
            self.out.append(f"]({href})" if href else "]")
        elif tag in ("p", "div", "blockquote", "ul", "ol"):
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if self._mention == "bot":
            return
        if self._mention is not None:
            self.out.append(f"@{data.lstrip('@')}")
            return
        self.out.append(data)


def read_message(
    message: dict[str, object], bot_id: str, bot_name: str
) -> tuple[str, bool]:
    """A Webex message's body as Switch Markdown, and whether it named the bot.

    The bot's own mention is taken out: in a group space every message the bot
    is given names it, because that is the only way a message reaches a bot
    there, and it says nothing about which agent was meant. Without HTML the
    mention is only the bot's name at the front of `text`, and that is what
    comes off.
    """
    raw_html = message.get("html")
    mentioned = message.get("mentionedPeople")
    named_bot = isinstance(mentioned, list) and any(
        isinstance(person, str) and same_person(person, bot_id) for person in mentioned
    )
    if isinstance(raw_html, str) and raw_html.strip():
        reader = _Reader(bot_id)
        reader.feed(raw_html)
        reader.close()
        body = "".join(reader.out)
        return _tidy(body), named_bot or reader.mentioned_bot
    text = _tidy(
        html.unescape(str(message.get("markdown") or message.get("text") or ""))
    )
    if named_bot and bot_name and text.lower().startswith(bot_name.lower()):
        text = text[len(bot_name) :].lstrip(" ,:")
    return text, named_bot


def _tidy(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    joined = "\n".join(lines)
    joined = re.sub(r"\n{3,}", "\n\n", joined)
    return re.sub(r"^[ \t]+", "", joined.strip(), count=1)
