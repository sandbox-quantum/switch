"""Native Discord application commands, built from the shared command registry.

Discord registers commands with a declared signature: each argument is named,
typed and marked required up front, unlike the free-text tail a typed
`!command` carries. This module is the translation layer between the two.

It does NOT implement any command. Every declared argument is turned straight
back into the positional `@token` string that `bridges.agent.commands` already
parses, so a slash invocation reaches the identical handler a typed `!command`
reaches — one implementation, two entry points. The argument surface itself is
declared once, in that registry's `Command.args_spec`, rather than restated
here where it could drift from the handlers.
"""

from __future__ import annotations

import inspect
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import discord
from discord import app_commands

from switch_core.bridges.agent.commands import COMMANDS, Command, CommandArg
from switch_core.clients.mentions import NAME_CHAR

logger = logging.getLogger(__name__)

# Discord's hard caps on an application command's declared text.
MAX_DESCRIPTION = 100

# A declared argument is a mention token, with or without the `@` the user may
# have typed out of habit. Anchored: a value with a space or a stray character
# would silently lose part of itself once reassembled into the args string.
_TOKEN = re.compile(rf"^@?({NAME_CHAR}+)$")

SlashInvoke = Callable[[discord.Interaction, Command, dict[str, Any]], Awaitable[None]]
"""(interaction, command, option_values) -> None.

Handed the raw option values rather than a finished args string: reassembly can
fail on input Discord itself considers valid (see `reassemble_args`), and the
adapter is what owns replying to the user, so it does the conversion where it
can turn a failure into a visible message.
"""


class SlashArgError(ValueError):
    """A declared argument cannot be expressed as a positional `!command` arg.

    Carries user-facing text: it is shown back in the channel rather than only
    logged, so an invocation never appears to do nothing.
    """


def truncate_description(text: str, limit: int = MAX_DESCRIPTION) -> str:
    """Fit a registry description into Discord's cap, breaking on a word.

    Registry descriptions are written for `!help`, where they carry full usage
    prose and run well past Discord's 100 characters. The full text stays
    available there; this is only what the Discord command picker shows.
    """
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip(" .,;:—-") + "…"


def reassemble_args(spec: tuple[CommandArg, ...], values: dict[str, Any]) -> str:
    """Turn declared, named option values back into a positional args string.

    The handlers read their arguments by *position* out of the mention tokens in
    `args`, so the declared values are re-emitted in `spec` order, each with
    exactly one leading `@` — whether or not the user typed one.

    Raises SlashArgError when a value is supplied after an earlier optional one
    was left out. Discord submits options by name and happily allows that, but
    the positional form cannot express it: the later value would slide into the
    earlier one's slot and the command would do something plausible and wrong.
    """
    parts: list[str] = []
    skipped: str | None = None

    for arg in spec:
        raw = values.get(arg.name)
        if raw is None or not str(raw).strip():
            if arg.required:
                raise SlashArgError(f"`{arg.name}` is required.")
            if skipped is None:
                skipped = arg.name
            continue

        if skipped is not None:
            raise SlashArgError(
                f"`{arg.name}` can only be given together with `{skipped}` — "
                f"the command reads its arguments in order, so `{skipped}` "
                f"cannot be left out while `{arg.name}` is set."
            )

        token = str(raw).strip()
        match = _TOKEN.match(token)
        if match is None:
            raise SlashArgError(
                f"`{arg.name}` must be a single name (letters, digits, `.`, `-`, "
                f"`_`), optionally written with a leading `@` — got `{token}`."
            )
        parts.append(f"@{match.group(1)}")

    return " ".join(parts)


def _make_callback(command: Command, invoke: SlashInvoke) -> Any:
    """Build a callback whose signature declares `command`'s arguments.

    discord.py derives a command's options from its callback signature, so the
    signature has to carry the real argument names — they are what Discord
    renders as field labels. A fresh closure is built per command so the
    `describe` decorator below never mutates a shared function.
    """

    async def callback(interaction: discord.Interaction, **values: Any) -> None:
        await invoke(interaction, command, values)

    params = [
        inspect.Parameter(
            "interaction",
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            annotation=discord.Interaction,
        )
    ]
    for arg in command.args_spec:
        params.append(
            inspect.Parameter(
                arg.name,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                annotation=str,
                default=inspect.Parameter.empty if arg.required else None,
            )
        )
    callback.__signature__ = inspect.Signature(params)  # type: ignore[attr-defined]
    callback.__annotations__ = {"interaction": discord.Interaction} | {
        arg.name: str for arg in command.args_spec
    }

    if command.args_spec:
        callback = app_commands.describe(
            **{
                arg.name: truncate_description(arg.description)
                for arg in command.args_spec
            }
        )(callback)
    return callback


def build_app_commands(
    invoke: SlashInvoke,
) -> list[app_commands.Command[Any, ..., Any]]:
    """Build one Discord application command per registered in-room command.

    Hidden commands are skipped: they are absent from `!help` for a reason, and
    Discord rejects the empty description they carry anyway.
    """
    built: list[app_commands.Command[Any, ..., Any]] = []
    for command in COMMANDS:
        if command.hidden:
            continue
        if not command.description:
            logger.warning(
                "Skipping Discord registration for '%s': no description to declare",
                command.name,
            )
            continue
        built.append(
            app_commands.Command(
                name=command.name,
                description=truncate_description(command.description),
                callback=_make_callback(command, invoke),
            )
        )
    return built
