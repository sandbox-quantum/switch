"""Text between Webex and Switch: reading a message, and fitting one to send.

Webex hands a bot a message three ways — `text`, `markdown` and `html` — and
only `html` says exactly who was mentioned and where the formatting was, so
that is what is read when it is there. Going out, Webex takes Markdown close
enough to Switch's own that the body needs no conversion, only two things a
person never typed: real mentions for the people Switch knows, and nothing a
body can use to mention anybody else.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

from switch_core.bridges.collaboration.webex.client import same_entity

# Webex refuses a message whose `text` or `markdown` is longer than this many
# bytes. Measured in bytes, not characters, so a body in a script with
# multi-byte characters fits fewer of them.
MAX_MESSAGE_BYTES = 7439

# What a split leaves room for: a code fence closed at the end of one part and
# opened again at the start of the next.
_FENCE = "```"
_FENCE_ROOM = len(f"\n{_FENCE}\n{_FENCE}\n".encode())


@dataclass
class Inbound:
    """A received message as Switch reads it."""

    text: str
    mentions_bot: bool = False
    mentioned_people: list[str] = field(default_factory=list)


_BLOCKS = {
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "ul",
    "ol",
}


class _HtmlReader(HTMLParser):
    """Webex's message HTML, back as the Markdown a person would have typed.

    Not a general converter: Webex writes a small, regular subset — paragraphs,
    emphasis, code, links, lists, quotes and `<spark-mention>` — and that is
    all this has to read. Anything else contributes its text.
    """

    def __init__(self, bot_id: str | None) -> None:
        super().__init__(convert_charrefs=True)
        self._bot_id = bot_id
        self._out: list[str] = []
        self._lists: list[list[int]] = []  # each open list: [is_ordered, next number]
        self._href: list[str | None] = []
        self._in_pre = False
        self._in_mention: str | None = None
        self._mention_text: list[str] = []
        self._quote = 0
        self.mentions_bot = False
        self.mentioned: list[str] = []

    def _newline(self, count: int = 1) -> None:
        text = "".join(self._out)
        trailing = len(text) - len(text.rstrip("\n"))
        if not text.strip():
            return
        if trailing < count:
            self._out.append("\n" * (count - trailing))
        if self._quote:
            self._out.append("> " * self._quote)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "spark-mention":
            self._in_mention = values.get("data-object-type") or "person"
            self._mention_text = []
            object_id = values.get("data-object-id") or ""
            if self._in_mention == "person":
                if same_entity(object_id, self._bot_id):
                    self.mentions_bot = True
                    self._in_mention = "bot"
                elif object_id:
                    self.mentioned.append(object_id)
            return
        if self._in_mention is not None:
            return
        if tag == "br":
            self._out.append("\n")
        elif tag in ("strong", "b"):
            self._out.append("**")
        elif tag in ("em", "i"):
            self._out.append("_")
        elif tag == "code" and not self._in_pre:
            self._out.append("`")
        elif tag == "pre":
            self._newline(2)
            self._out.append(f"{_FENCE}\n")
            self._in_pre = True
        elif tag == "a":
            self._href.append(values.get("href"))
            self._out.append("[")
        elif tag in ("ul", "ol"):
            if not self._lists:
                self._newline(2)
            self._lists.append([1 if tag == "ol" else 0, 1])
        elif tag == "li":
            self._newline(1)
            indent = "  " * (len(self._lists) - 1)
            if self._lists and self._lists[-1][0]:
                self._out.append(f"{indent}{self._lists[-1][1]}. ")
                self._lists[-1][1] += 1
            else:
                self._out.append(f"{indent}- ")
        elif tag == "blockquote":
            self._newline(2)
            self._quote += 1
            self._out.append("> ")
        elif tag in _BLOCKS:
            self._newline(2)

    def handle_endtag(self, tag: str) -> None:
        if tag == "spark-mention":
            kind, self._in_mention = self._in_mention, None
            name = "".join(self._mention_text).strip()
            if kind == "person" and name:
                self._out.append(f"@{name}")
            elif kind not in ("bot", "person") and name:
                # A group mention ("All"): kept as the word, not as a mention.
                self._out.append(name)
            return
        if self._in_mention is not None:
            return
        if tag in ("strong", "b"):
            self._out.append("**")
        elif tag in ("em", "i"):
            self._out.append("_")
        elif tag == "code" and not self._in_pre:
            self._out.append("`")
        elif tag == "pre":
            if not "".join(self._out).endswith("\n"):
                self._out.append("\n")
            self._out.append(_FENCE)
            self._in_pre = False
            self._newline(2)
        elif tag == "a":
            href = self._href.pop() if self._href else None
            self._out.append(f"]({href})" if href else "]")
        elif tag in ("ul", "ol"):
            if self._lists:
                self._lists.pop()
            if not self._lists:
                self._newline(2)
        elif tag == "blockquote":
            self._quote = max(0, self._quote - 1)
            self._newline(2)
        elif tag in _BLOCKS:
            self._newline(2)

    def handle_data(self, data: str) -> None:
        if self._in_mention is not None:
            self._mention_text.append(data)
            return
        self._out.append(data)

    def text(self) -> str:
        joined = "".join(self._out)
        joined = re.sub(r"\[([^\]]*)\]\(\1\)", r"\1", joined)  # a bare URL Webex linked
        joined = re.sub(r"\n{3,}", "\n\n", joined)
        return "\n".join(line.rstrip() for line in joined.split("\n")).strip()


def read_message(message: dict[str, object], bot_id: str | None) -> Inbound:
    """What a Webex message says, with the bot's own mention taken out.

    The bot's mention is how a person in a group space gets a message to the
    bot at all, so it is the address on the envelope rather than part of the
    message: left in, every message would open with the bot's name.
    """
    html = message.get("html")
    if isinstance(html, str) and html.strip():
        reader = _HtmlReader(bot_id)
        reader.feed(html)
        reader.close()
        return Inbound(
            text=reader.text(),
            mentions_bot=reader.mentions_bot,
            mentioned_people=reader.mentioned,
        )
    for key in ("markdown", "text"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            mentioned = message.get("mentionedPeople")
            mentions_bot = isinstance(mentioned, list) and any(
                isinstance(person, str) and same_entity(person, bot_id)
                for person in mentioned
            )
            return Inbound(text=value.strip(), mentions_bot=mentions_bot)
    return Inbound(text="")


# A Webex mention in raw markup: `<@personId:…>`, `<@personEmail:…>`, `<@all>`.
_RAW_MENTION = re.compile(r"<@", re.IGNORECASE)


def defuse_raw_mentions(text: str) -> str:
    """Break any Webex mention markup a body carries.

    A body is somebody else's words — an agent's reply, a relayed message —
    and in Webex Markdown `<@personEmail:…>` notifies whoever it names. Only
    the mentions this bridge writes itself, for people Switch knows, may do
    that. A zero-width space keeps the text legible and the markup inert.
    """
    return _RAW_MENTION.sub("<​@", text)


def mention(person_id: str, name: str | None = None) -> str:
    """A Webex mention of one person, which notifies them."""
    label = (name or "").replace(">", "").replace("|", "").strip()
    return f"<@personId:{person_id}|{label}>" if label else f"<@personId:{person_id}>"


def render_mentions(text: str, targets: dict[str, str]) -> str:
    """`@name` for each person Switch knows, written as a real Webex mention.

    Without this an agent writing `@ada` reaches nobody: Webex notifies only
    for its own markup, never for the plain word. Longest names first, so
    `@ada.l` is not taken for `@ada` followed by `.l`.
    """
    if not targets or "@" not in text:
        return text
    names = sorted(targets, key=len, reverse=True)
    pattern = re.compile(
        r"(?<![\w@<])@("
        + "|".join(re.escape(name) for name in names)
        + r")(?![\w.-]*\w)",
        re.IGNORECASE,
    )
    folded = {name.casefold(): target for name, target in targets.items()}

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        target = folded.get(name.casefold())
        return mention(target, name) if target else match.group(0)

    return pattern.sub(replace, text)


def chunk(text: str, limit: int = MAX_MESSAGE_BYTES) -> list[str]:
    """`text` as messages Webex will take, split where a reader would split.

    At a blank line where there is one, then a line, then a word, and only
    mid-word when a single word is longer than a message. A split inside a
    code block closes the fence at the end of one part and opens it again at
    the start of the next, so neither part renders the rest of the reply as
    code.
    """
    if len(text.encode()) <= limit:
        return [text]
    budget = max(64, limit - _FENCE_ROOM)
    parts: list[str] = []
    rest = text
    reopen = False
    while rest:
        if reopen:
            rest = f"{_FENCE}\n{rest}"
        if len(rest.encode()) <= limit:
            parts.append(rest)
            break
        piece = _cut(rest, budget)
        rest = rest[len(piece) :].lstrip("\n")
        piece = piece.rstrip()
        reopen = piece.count(_FENCE) % 2 == 1
        if reopen:
            piece = f"{piece}\n{_FENCE}"
        parts.append(piece)
    return [part for part in parts if part.strip()]


def _cut(text: str, budget: int) -> str:
    """The longest prefix of `text` within `budget` bytes, ending well."""
    encoded = text.encode()
    if len(encoded) <= budget:
        return text
    window = encoded[:budget].decode(errors="ignore")
    for separator in ("\n\n", "\n", " "):
        at = window.rfind(separator)
        if at > len(window) // 3:
            return window[: at + len(separator)]
    return window
