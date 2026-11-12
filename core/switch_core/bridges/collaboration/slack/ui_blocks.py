"""A card (`ui_spec`) as Slack Block Kit.

`mrkdwn` renders a string the card's author wrote into mrkdwn that can
neither mention nor link by Slack's own syntax; it is applied to every string
that goes into an `mrkdwn` text. `plain_text` and table `raw_text` are not
parsed by Slack, so their strings go as written.

Every text is measured as sent against Slack's limit for its place; one over
raises UISpecError naming the element and prop. The spec's validation counts
the same escaping and markup, so only what `mrkdwn` changes beyond escaping
can get here.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from switch_core.ui_spec import (
    BUTTON_LABEL_MAX,
    FIELD_TEXT_MAX,
    FIELDS_PER_SECTION,
    HEADER_TEXT_MAX,
    TABLE_CHARS_MAX,
    TEXT_MAX,
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
    UISpecError,
    button_action,
    field_mrkdwn,
    over_rendered_limit,
    styled_mrkdwn,
)


def _fit(where: str, text: str, limit: int) -> str:
    issue = over_rendered_limit(where, text, limit)
    if issue is not None:
        raise UISpecError([issue])
    return text


def _plain(text: str) -> dict[str, Any]:
    return {"type": "plain_text", "text": text, "emoji": True}


def _context(text: str) -> dict[str, Any]:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


def _section(text: str) -> dict[str, Any]:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def _button(where: str, props: ButtonProps | LinkButtonProps) -> dict[str, Any]:
    button: dict[str, Any] = {
        "type": "button",
        "text": _plain(_fit(f"{where}.label", props.label, BUTTON_LABEL_MAX)),
    }
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
        where = f"elements.{key}.props"
        p = element.props
        out: list[dict[str, Any]] = []
        if isinstance(p, CardProps):
            if p.title:
                title = _fit(f"{where}.title", p.title, HEADER_TEXT_MAX)
                out.append({"type": "header", "text": _plain(title)})
            if p.subtitle:
                subtitle = _fit(f"{where}.subtitle", mrkdwn(p.subtitle), TEXT_MAX)
                out.append(_context(subtitle))
            if p.imageUrl:
                out.append(
                    {
                        "type": "image",
                        "image_url": p.imageUrl,
                        "alt_text": p.title or "Card image",
                    }
                )
        elif isinstance(p, TextProps):
            text = _fit(
                f"{where}.content", styled_mrkdwn(mrkdwn(p.content), p.style), TEXT_MAX
            )
            return [_context(text) if p.style == "muted" else _section(text)]
        elif isinstance(p, FieldsProps):
            fields = [
                (c, f)
                for c in element.children
                if isinstance(f := spec.elements[c].props, FieldProps)
            ]
            return [
                {
                    "type": "section",
                    "fields": [
                        {
                            "type": "mrkdwn",
                            "text": _fit(
                                f"elements.{c}.props.label+value",
                                field_mrkdwn(mrkdwn(f.label), mrkdwn(f.value)),
                                FIELD_TEXT_MAX,
                            ),
                        }
                        for c, f in fields[i : i + FIELDS_PER_SECTION]
                    ],
                }
                for i in range(0, len(fields), FIELDS_PER_SECTION)
            ]
        elif isinstance(p, TableProps):
            rows = [p.headers, *p.rows]
            _fit(
                f"{where}.headers+rows",
                "".join(cell for row in rows for cell in row),
                TABLE_CHARS_MAX,
            )
            table: dict[str, Any] = {
                "type": "table",
                "rows": [
                    [{"type": "raw_text", "text": cell} for cell in row] for row in rows
                ],
            }
            if p.align is not None:
                table["column_settings"] = [{"align": a} for a in p.align]
            if p.caption:
                caption = _fit(f"{where}.caption", mrkdwn(p.caption), TEXT_MAX)
                return [table, _context(caption)]
            return [table]
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
                        _button(f"elements.{c}.props", b)
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
