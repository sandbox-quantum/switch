"""A card (`ui_spec`) as Telegram HTML, and the buttons drawn under it.

Telegram has no layout blocks, so a card is one HTML message: a bold title,
text, `Label: value` lines, and a table or a chart's data as a `<pre>` grid.
`markdown` renders a string the card's author wrote as Telegram HTML,
escaping it first; it is applied to every string written as Markdown. Every
other string is escaped here.
"""

from __future__ import annotations

import html
from collections.abc import Callable, Sequence

from switch_core.ui_spec import (
    ActionsProps,
    ButtonProps,
    CardProps,
    ChartProps,
    DividerProps,
    FieldProps,
    ImageProps,
    LinkButtonProps,
    PieChart,
    TableProps,
    TextProps,
    UISpec,
)

_RULE = "──────────"
_PAD = {"left": str.ljust, "right": str.rjust, "center": str.center}


def _esc(text: str) -> str:
    return html.escape(text, quote=False)


def _link(url: str, label: str) -> str:
    return f'<a href="{html.escape(url)}">{_esc(label)}</a>'


def _grid(rows: list[list[str]], align: Sequence[str] | None) -> str:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    sides = align or ["left"] * len(widths)
    lines = [
        " | ".join(
            _PAD[side](cell, width)
            for cell, width, side in zip(row, widths, sides, strict=True)
        ).rstrip()
        for row in rows
    ]
    return f"<pre>{_esc(chr(10).join(lines))}</pre>"


def ui_spec_to_html(
    spec: UISpec, markdown: Callable[[str], str]
) -> tuple[str, list[list[ButtonProps | LinkButtonProps]]]:
    """The card's text, and its buttons as one group per `Actions`."""
    groups: list[list[ButtonProps | LinkButtonProps]] = []

    def lines(key: str) -> list[str]:
        element = spec.elements[key]
        p = element.props
        out: list[str] = []
        if isinstance(p, CardProps):
            out += [f"<b>{_esc(p.title)}</b>"] if p.title else []
            out += [f"<i>{markdown(p.subtitle)}</i>"] if p.subtitle else []
            out += [_link(p.imageUrl, "Image")] if p.imageUrl else []
        elif isinstance(p, TextProps):
            text = markdown(p.content)
            tag = {"bold": "b", "muted": "i"}.get(p.style or "")
            out.append(f"<{tag}>{text}</{tag}>" if tag else text)
        elif isinstance(p, FieldProps):
            out.append(f"<b>{markdown(p.label)}:</b> {markdown(p.value)}")
        elif isinstance(p, TableProps):
            out.append(_grid([p.headers, *p.rows], p.align))
            out += [f"<i>{markdown(p.caption)}</i>"] if p.caption else []
        elif isinstance(p, ChartProps):
            out.append(f"<b>{_esc(p.title)}</b>")
            if isinstance(p.chart, PieChart):
                out.append(
                    _grid(
                        [[s.label, f"{s.value:g}"] for s in p.chart.segments],
                        ["left", "right"],
                    )
                )
            else:
                c = p.chart
                header = [c.xLabel or "", *(s.name for s in c.series)]
                rows = [
                    [category, *(f"{s.values[i]:g}" for s in c.series)]
                    for i, category in enumerate(c.categories)
                ]
                out.append(_grid([header, *rows], ["left"] + ["right"] * len(c.series)))
                out += [f"<i>{_esc(c.yLabel)}</i>"] if c.yLabel else []
        elif isinstance(p, DividerProps):
            out.append(_RULE)
        elif isinstance(p, ImageProps):
            out.append(_link(p.url, p.alt))
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
        for child in element.children:
            out += lines(child)
        return out

    return "\n".join(lines(spec.root)), groups
