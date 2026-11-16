"""Escaping for text Slack will read as mrkdwn, and stripping for where it won't."""

from __future__ import annotations

import re


def escape_mrkdwn(text: str) -> str:
    """Neutralise the three characters Slack's own syntax is built from.

    Escaping them is what stops text Switch did not write from forging a link,
    a user mention or a `<!channel>` broadcast. It applies wherever Slack parses
    mrkdwn — a message's `text`, and the `text` of an `mrkdwn` block — and
    nowhere else: a `plain_text` block object is not parsed, so escaping one
    would show the entity to the reader instead of the character.

    mrkdwn's emphasis characters (`*`, `_`, `~`, backtick) have no escape
    sequence — Slack documents none — so text containing them can still
    unbalance a run it sits in. That is cosmetic; the markup it could forge is
    not, and this closes that.
    """
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# An `&` that does not already start one of the three entities Slack decodes.
_BARE_AMPERSAND = re.compile(r"&(?!(?:amp|lt|gt);)")


def escape_body_markup(text: str) -> str:
    """`escape_mrkdwn` for a body that may already carry Slack's entities.

    A message body arrives holding pieces escaped on their way in — a display
    name through `escape_label_for_body`, a card's text through
    `escape_mrkdwn` — and escaping those a second time would show the reader
    `&lt;` where the name had a `<`. So an `&` that already starts `&amp;`,
    `&lt;` or `&gt;` is left as it is; every other `&`, and every `<` and `>`,
    is escaped. An entity an agent typed therefore shows as its character,
    which is all it ever did, and it cannot open markup: Slack never parses
    the text an entity decodes to.
    """
    return _BARE_AMPERSAND.sub("&amp;", text).replace("<", "&lt;").replace(">", "&gt;")


def plain_text(text: str) -> str:
    """Strip Switch's markup for somewhere that renders none.

    A task card's title is plain text, so markup passed into it arrives as
    literal `_underscores_` and backticks rather than emphasis. The opposite
    problem to escaping, and the same reason: what Slack does with a string
    depends on where it is put, so the string has to be prepared for the place.
    """
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\w)[*_]([^*_]+)[*_](?!\w)", r"\1", text)
    return text.strip()
