"""A card (`ui_spec`) as Slack Block Kit.

`mrkdwn` renders a string the card's author wrote into mrkdwn that can
neither mention nor link by Slack's own syntax; it is applied to every string
that goes into an `mrkdwn` text. `plain_text` and table `raw_text` are not
parsed by Slack, so their strings go as written.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from switch_core.ui_spec import (
    FIELDS_PER_SECTION,
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


def _plain(text: str) -> dict[str, Any]:
    return {"type": "plain_text", "text": text, "emoji": True}


def _context(text: str) -> dict[str, Any]:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


def _section(text: str) -> dict[str, Any]:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def _button(props: ButtonProps | LinkButtonProps) -> dict[str, Any]:
    button: dict[str, Any] = {"type": "button", "text": _plain(props.label)}
    if isinstance(props, LinkButtonProps):
        button["url"] = props.url
        return button
    button["action_id"], button["value"] = button_action(props)
    if props.style in ("primary", "danger"):
        button["style"] = props.style
    return button


def _chart(props: ChartProps) -> dict[str, Any]:
    chart: dict[str, Any] = {"type": props.chart.type}
    if isinstance(props.chart, PieChart):
        chart["segments"] = [
            {"label": s.label, "value": s.value} for s in props.chart.segments
        ]
    else:
        categories = props.chart.categories
        chart["series"] = [
            {
                "name": s.name,
                "data": [
                    {"label": c, "value": v}
                    for c, v in zip(categories, s.values, strict=True)
                ],
            }
            for s in props.chart.series
        ]
        axis: dict[str, Any] = {"categories": list(categories)}
        if props.chart.xLabel:
            axis["x_label"] = props.chart.xLabel
        if props.chart.yLabel:
            axis["y_label"] = props.chart.yLabel
        chart["axis_config"] = axis
    return {"type": "data_visualization", "title": props.title, "chart": chart}


def ui_spec_to_blocks(
    spec: UISpec, mrkdwn: Callable[[str], str]
) -> list[dict[str, Any]]:
    """The blocks a card draws as, as many as `estimated_block_count` says."""

    def blocks(key: str) -> list[dict[str, Any]]:
        element = spec.elements[key]
        p = element.props
        out: list[dict[str, Any]] = []
        if isinstance(p, CardProps):
            if p.title:
                out.append({"type": "header", "text": _plain(p.title)})
            if p.subtitle:
                out.append(_context(mrkdwn(p.subtitle)))
            if p.imageUrl:
                out.append(
                    {
                        "type": "image",
                        "image_url": p.imageUrl,
                        "alt_text": p.title or "Card image",
                    }
                )
        elif isinstance(p, TextProps):
            text = mrkdwn(p.content)
            if p.style == "muted":
                return [_context(text)]
            return [_section(f"*{text}*" if p.style == "bold" else text)]
        elif isinstance(p, FieldsProps):
            fields = [
                f
                for c in element.children
                if isinstance(f := spec.elements[c].props, FieldProps)
            ]
            return [
                {
                    "type": "section",
                    "fields": [
                        {
                            "type": "mrkdwn",
                            "text": f"*{mrkdwn(f.label)}*\n{mrkdwn(f.value)}",
                        }
                        for f in fields[i : i + FIELDS_PER_SECTION]
                    ],
                }
                for i in range(0, len(fields), FIELDS_PER_SECTION)
            ]
        elif isinstance(p, TableProps):
            table: dict[str, Any] = {
                "type": "table",
                "rows": [
                    [{"type": "raw_text", "text": cell} for cell in row]
                    for row in [p.headers, *p.rows]
                ],
            }
            if p.align is not None:
                table["column_settings"] = [{"align": a} for a in p.align]
            return [table, *([_context(mrkdwn(p.caption))] if p.caption else [])]
        elif isinstance(p, ChartProps):
            return [_chart(p)]
        elif isinstance(p, DividerProps):
            return [{"type": "divider"}]
        elif isinstance(p, ImageProps):
            return [{"type": "image", "image_url": p.url, "alt_text": p.alt}]
        elif isinstance(p, ActionsProps):
            return [
                {
                    "type": "actions",
                    "elements": [
                        _button(b)
                        for c in element.children
                        if isinstance(
                            b := spec.elements[c].props, ButtonProps | LinkButtonProps
                        )
                    ],
                }
            ]
        for child in element.children:
            out += blocks(child)
        return out

    return blocks(spec.root)
