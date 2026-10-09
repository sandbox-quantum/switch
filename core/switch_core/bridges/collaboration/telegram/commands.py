"""The in-room command set, as Telegram's `/` menu publishes it.

Its own module because two things publish it: a self-registered bridge for its
own bot, and the distributed app's client for the one bot every tenant shares.
"""

from __future__ import annotations

import re

from telegram import BotCommand

from switch_core.bridges.agent.commands import COMMANDS

# Telegram will only register a command spelled in these characters, and caps a
# description at 256. A name it rejects is left out of the menu rather than
# taking the whole call down.
_TELEGRAM_COMMAND_RE = re.compile(r"[a-z0-9_-]{1,32}")
_MAX_COMMAND_DESCRIPTION = 256


def command_menu() -> list[BotCommand]:
    """Every visible command, hyphens spelled as underscores.

    Telegram only accepts `[a-z0-9_]` in a registered command, so the
    hyphenated names are published in their underscore spelling —
    `/invite_agent` — and the adapter's command parser accepts either.
    """
    return [
        BotCommand(
            command=command.name.replace("-", "_"),
            description=command.description[:_MAX_COMMAND_DESCRIPTION],
        )
        for command in COMMANDS
        if not command.hidden and _TELEGRAM_COMMAND_RE.fullmatch(command.name)
    ]
