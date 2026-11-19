"""A card (`ui_spec`) as Discord embeds and buttons.

Every string the card's author wrote goes through `escape_card_text`, so it
can neither mention nor resolve any other `<…>` entity. Mentions in an embed
never notify; this is about what the card reads as. Table and chart cells sit
in code blocks, where Discord resolves nothing.

The limits are Discord's (message resource, "Embed Limits"; component
reference, "Button"). A card that does not fit raises `ValueError` before
anything is posted, so the caller sends the message's text instead.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import discord

from switch_core.ui_spec import (
    ANSWERER_NAME_MAX,
    UI_ACTION_PREFIX,
    ActionsProps,
    ButtonProps,
    CardProps,
    ChartProps,
    DividerProps,
    FieldProps,
    FieldsProps,
    ImageProps,
    LinkButtonProps,
    PieChart,
    TableProps,
    TextProps,
    UISpec,
    button_action,
)

EMBED_TITLE_MAX = 256
EMBED_DESCRIPTION_MAX = 4096
EMBED_FIELDS_MAX = 25
EMBED_FIELD_NAME_MAX = 256
EMBED_FIELD_VALUE_MAX = 1024
EMBED_TOTAL_MAX = 6000
EMBEDS_MAX = 10
BUTTONS_PER_ROW = 5
ROWS_MAX = 5
CUSTOM_ID_MAX = 100
LINK_URL_MAX = 512

_STYLES = {"primary": discord.ButtonStyle.primary, "danger": discord.ButtonStyle.danger}
_RULE = "─────"
# What may follow a Fields group for it to draw as embed fields, which Discord
# always puts under the description: nothing that is itself drawn in the text.
_AFTER_EMBED_FIELDS = frozenset(
    {"Field", "Section", "Divider", "Actions", "Button", "LinkButton"}
)


def escape_card_text(text: str) -> str:
    """Break `<@id>`, `<@&id>`, `<#id>` and every other `<…>` entity with a
    zero-width space after the `<` (Discord has no escape for it), and
    `@everyone`/`@here` the way discord.py does."""
    return discord.utils.escape_mentions(text.replace("<", "<\u200b"))


def card_custom_id(action_id: str, value: str) -> str:
    """What a card button carries, from which `parse_card_custom_id` gives back
    its `button_action`. The value is left out when it is the button's id."""
    if value == action_id.removeprefix(UI_ACTION_PREFIX):
        return action_id
    return f"{action_id} {value}"


def parse_card_custom_id(custom_id: str) -> tuple[str, str] | None:
    """The (action id, value) a card button press carries, or None if it is not
    a card button. A button id has no space, so the first one ends it."""
    if not custom_id.startswith(UI_ACTION_PREFIX):
        return None
    action_id, separator, value = custom_id.partition(" ")
    return action_id, value if separator else action_id.removeprefix(UI_ACTION_PREFIX)


def _grid(
    headers: list[str], rows: list[list[str]], align: Sequence[str] | None
) -> str:
    table = [[c.replace("\n", " ") for c in row] for row in [headers, *rows]]
    widths = [max(len(row[i]) for row in table) for i in range(len(headers))]
    pad = {"left": str.ljust, "right": str.rjust, "center": str.center}
    aligns = align or ["left"] * len(headers)
    lines = [
        "  ".join(
            pad[a](c, w) for c, w, a in zip(row, widths, aligns, strict=True)
        ).rstrip()
        for row in table
    ]
    lines.insert(1, "  ".join("-" * w for w in widths))
    return "```\n" + "\n".join(lines).replace("```", "``\u200b`") + "\n```"


def _chart(props: ChartProps) -> str:
    chart = props.chart
    if isinstance(chart, PieChart):
        total = sum(s.value for s in chart.segments)
        grid = _grid(
            ["", "value", "share"],
            [
                [s.label, f"{s.value:g}", f"{100 * s.value / total:.0f}%"]
                for s in chart.segments
            ],
            ["left", "right", "right"],
        )
    else:
        grid = _grid(
            [chart.xLabel or "", *(s.name for s in chart.series)],
            [
                [c, *(f"{s.values[i]:g}" for s in chart.series)]
                for i, c in enumerate(chart.categories)
            ],
            ["left"] + ["right"] * len(chart.series),
        )
    y_label = (
        f" ({escape_card_text(chart.yLabel)})"
        if chart.type != "pie" and chart.yLabel
        else ""
    )
    return f"**{escape_card_text(props.title)}**{y_label}\n{grid}"


def settled_notice(name: str, label: str) -> str:
    """Who chose what, as a settled card's footer says it: plain text, since a
    footer renders neither markdown nor mentions."""
    return f"✅ {name} chose {label}"


def _embed_fields(spec: UISpec) -> str | None:
    """The Fields group that may draw as embed fields: the last one, when
    nothing drawn in the description comes after it."""
    order: list[str] = []

    def visit(key: str) -> None:
        order.append(key)
        for child in spec.elements[key].children:
            visit(child)

    visit(spec.root)
    fields = [i for i, k in enumerate(order) if spec.elements[k].type == "Fields"]
    if not fields or any(
        spec.elements[k].type not in _AFTER_EMBED_FIELDS
        for k in order[fields[-1] + 1 :]
    ):
        return None
    return order[fields[-1]]


def _description(parts: list[str]) -> str | None:
    """The parts a blank line apart, but a Divider only a line break from its
    neighbours."""
    out = parts[:1]
    for before, part in zip(parts, parts[1:], strict=False):
        out.append(("\n" if _RULE in (before, part) else "\n\n") + part)
    return "".join(out) or None


def ui_spec_to_message(
    spec: UISpec, *, interactive: bool
) -> tuple[list[discord.Embed], discord.ui.View | None]:
    """The embeds and buttons a card draws as. Its Text, Fields, Table, Chart
    and Divider go into the first embed's description in order, except that
    a Fields group with nothing drawn there after it is drawn as inline
    fields, which Discord shows under the description; the first image goes
    under them and any more as embeds of their own. Each Actions starts a row of buttons. A Button needs
    `interactive` (a message this application owns); raises `ValueError` for a
    card that has one without it, or that is over a Discord limit."""
    embed = discord.Embed()
    parts: list[str] = []
    images: list[str] = []
    groups: list[list[ButtonProps | LinkButtonProps]] = []
    embed_fields = _embed_fields(spec)

    def walk(key: str) -> None:
        element = spec.elements[key]
        p = element.props
        if isinstance(p, CardProps):
            if p.title:
                embed.title = escape_card_text(p.title)
            if p.subtitle:
                parts.append(escape_card_text(p.subtitle))
            if p.imageUrl:
                images.append(p.imageUrl)
        elif isinstance(p, TextProps):
            text = escape_card_text(p.content)
            parts.append(
                f"**{text}**"
                if p.style == "bold"
                else f"*{text}*"
                if p.style == "muted"
                else text
            )
        elif isinstance(p, FieldsProps):
            fields = [spec.elements[c].props for c in element.children]
            if key != embed_fields:
                parts.append(
                    "\n".join(
                        f"**{escape_card_text(f.label)}:** {escape_card_text(f.value)}"
                        for f in fields
                        if isinstance(f, FieldProps)
                    )
                )
                return
            for f in fields:
                assert isinstance(f, FieldProps)
                embed.add_field(
                    name=escape_card_text(f.label),
                    value=escape_card_text(f.value),
                    inline=True,
                )
            return
        elif isinstance(p, TableProps):
            parts.append(_grid(p.headers, p.rows, p.align))
            if p.caption:
                parts.append(f"*{escape_card_text(p.caption)}*")
        elif isinstance(p, ChartProps):
            parts.append(_chart(p))
        elif isinstance(p, DividerProps):
            parts.append(_RULE)
        elif isinstance(p, ImageProps):
            images.append(p.url)
        elif isinstance(p, ActionsProps):
            groups.append(
                [
                    b
                    for c in element.children
                    if isinstance(
                        b := spec.elements[c].props, ButtonProps | LinkButtonProps
                    )
                ]
            )
            return
        for child in element.children:
            walk(child)

    walk(spec.root)
    embed.description = _description(parts)
    if images:
        embed.set_image(url=images[0])
    embeds = [embed] if len(embed) or images else []
    embeds += [discord.Embed().set_image(url=url) for url in images[1:]]

    if len(embed.description or "") > EMBED_DESCRIPTION_MAX:
        raise ValueError(
            f"its text is {len(embed.description or '')} characters, over Discord's "
            f"{EMBED_DESCRIPTION_MAX}-character embed description"
        )
    if len(embed.title or "") > EMBED_TITLE_MAX:
        raise ValueError(f"its title is over Discord's {EMBED_TITLE_MAX} characters")
    for field in embed.fields:
        if (
            len(field.name or "") > EMBED_FIELD_NAME_MAX
            or len(field.value or "") > EMBED_FIELD_VALUE_MAX
        ):
            raise ValueError(
                f"field {(field.name or '')[:40]!r} is over Discord's "
                f"{EMBED_FIELD_NAME_MAX}-character name or "
                f"{EMBED_FIELD_VALUE_MAX}-character value"
            )
    if len(embed.fields) > EMBED_FIELDS_MAX:
        raise ValueError(
            f"it has {len(embed.fields)} fields, over Discord's {EMBED_FIELDS_MAX}"
        )
    # A card with Buttons gains a footer naming who answered it.
    answer = max(
        (
            len(settled_notice("x" * ANSWERER_NAME_MAX, b.label))
            for g in groups
            for b in g
            if isinstance(b, ButtonProps)
        ),
        default=0,
    )
    if len(embed) + answer > EMBED_TOTAL_MAX:
        raise ValueError(
            f"it is {len(embed)} characters, and {answer} more kept for its "
            f"answer, over Discord's {EMBED_TOTAL_MAX} per message"
        )
    if len(embeds) > EMBEDS_MAX:
        raise ValueError(
            f"it has {len(images)} images, over Discord's {EMBEDS_MAX} embeds"
        )
    if not groups:
        return embeds, None

    if sum(math.ceil(len(g) / BUTTONS_PER_ROW) for g in groups) > ROWS_MAX:
        raise ValueError(
            f"its buttons need more than Discord's {ROWS_MAX} rows of {BUTTONS_PER_ROW}"
        )
    view = discord.ui.View(timeout=None)
    row = 0
    for group in groups:
        for i, b in enumerate(group):
            if isinstance(b, LinkButtonProps):
                if len(b.url) > LINK_URL_MAX:
                    raise ValueError(
                        f"link {b.label!r} is over Discord's {LINK_URL_MAX}-"
                        "character button URL"
                    )
                button: discord.ui.Button[discord.ui.View] = discord.ui.Button(
                    label=b.label, url=b.url
                )
            else:
                if not interactive:
                    raise ValueError(
                        f"button {b.label!r} cannot be pressed on a message this "
                        "application does not own"
                    )
                custom_id = card_custom_id(*button_action(b))
                if len(custom_id) > CUSTOM_ID_MAX:
                    raise ValueError(
                        f"button {b.label!r} would carry {len(custom_id)} characters "
                        f"and Discord allows {CUSTOM_ID_MAX}"
                    )
                button = discord.ui.Button(
                    label=b.label,
                    custom_id=custom_id,
                    style=_STYLES.get(b.style or "", discord.ButtonStyle.secondary),
                )
            button.row = row + i // BUTTONS_PER_ROW
            view.add_item(button)
        row += math.ceil(len(group) / BUTTONS_PER_ROW)
    # Presses arrive as gateway interactions, never through discord.py's view
    # dispatch; an unstopped view would sit in the client's store for good.
    view.stop()
    return embeds, view
