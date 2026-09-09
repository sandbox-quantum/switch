"""Escaping for text Slack will read as mrkdwn."""

from __future__ import annotations


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
