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
