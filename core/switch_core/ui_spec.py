"""Rich cards: a UI spec an agent attaches to a room message.

The format is json-render's chat spec — the flat `{"root", "elements"}` shape,
its standard chat components and their prop names — without state,
visibility, repeat or bindings, since a posted message has no inputs. A bridge
that can draw the card natively (Slack Block Kit) does; every other platform
gets the message body.

The limits are Slack's, so a spec that parses here fits in one Slack message.
Lengths are counted in Unicode code points (`len`), as Slack's character
limits are; none of the limits used is a byte limit.
"""

from __future__ import annotations

import math
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
)

from switch_core.bridges.collaboration.slack.mrkdwn import escape_mrkdwn

UI_CONTENT_KEY = "com.switch.ui"
# A press on a card button reaches the bridge under this action id prefix.
UI_ACTION_PREFIX = "switch.ui:"
# Or names its button by position in `card_buttons`, from 1, under this prefix,
# where the platform cannot carry the button's action and value.
UI_POSITION_PREFIX = f"{UI_ACTION_PREFIX}#"
# The room message a press becomes carries what was pressed under this key.
UI_PRESS_KEY = "com.switch.ui_press"

MAX_BLOCKS = 50
# A card is settled with a line naming who answered it; the name is cut to this
# so the room each platform keeps for that line is bounded.
ANSWERER_NAME_MAX = 64
MAX_DEPTH = 8
MAX_TABLES = 1
MAX_CHARTS = 2
HEADER_TEXT_MAX = 150
TEXT_MAX = 3000
FIELD_TEXT_MAX = 2000
FIELDS_PER_SECTION = 10
ACTIONS_PER_BLOCK = 25
BUTTON_LABEL_MAX = 75
# Slack allows 2000; the rest is kept for the routing Switch adds to the value.
BUTTON_VALUE_MAX = 1500
ACTION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$"
URL_MAX = 3000
IMAGE_ALT_MAX = 2000
# Slack counts the header as a table row.
TABLE_ROWS_MAX = 100
TABLE_COLUMNS_MAX = 20
TABLE_CHARS_MAX = 10000
CHART_TITLE_MAX = 50
CHART_LABEL_MAX = 20
CHART_AXIS_LABEL_MAX = 50
CHART_SERIES_MAX = 12
CHART_POINTS_MAX = 20

_CHART_TYPES = frozenset({"pie", "bar", "line", "area"})


def _display(value: object) -> object:
    # Models often emit numbers for display values; show them as text.
    if isinstance(value, int | float) and not isinstance(value, bool):
        return str(value)
    return value


def _https(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.netloc:
        raise ValueError("must be an https:// URL")
    return value


Text = Annotated[str, Field(min_length=1)]
DisplayText = Annotated[str, BeforeValidator(_display)]
HttpsUrl = Annotated[str, Field(max_length=URL_MAX), AfterValidator(_https)]
FiniteNumber = Annotated[float, Field(strict=True, allow_inf_nan=False)]
ChartLabel = Annotated[str, Field(min_length=1, max_length=CHART_LABEL_MAX)]
AxisLabel = Annotated[str, Field(min_length=1, max_length=CHART_AXIS_LABEL_MAX)]


class _Props(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CardProps(_Props):
    title: Annotated[str, Field(min_length=1, max_length=HEADER_TEXT_MAX)] | None = None
    subtitle: Annotated[str, Field(min_length=1, max_length=TEXT_MAX)] | None = None
    imageUrl: HttpsUrl | None = None


class SectionProps(_Props):
    pass


class TextProps(_Props):
    content: Annotated[str, Field(min_length=1, max_length=TEXT_MAX)]
    style: Literal["plain", "bold", "muted"] | None = None


class FieldsProps(_Props):
    pass


class FieldProps(_Props):
    label: Text
    value: DisplayText


class TableProps(_Props):
    headers: Annotated[list[str], Field(min_length=1, max_length=TABLE_COLUMNS_MAX)]
    rows: Annotated[list[list[DisplayText]], Field(max_length=TABLE_ROWS_MAX - 1)]
    align: list[Literal["left", "center", "right"]] | None = None
    caption: Annotated[str, Field(min_length=1, max_length=TEXT_MAX)] | None = None


class PieSegment(_Props):
    label: ChartLabel
    value: Annotated[float, Field(strict=True, allow_inf_nan=False, gt=0)]


class PieChart(_Props):
    type: Literal["pie"]
    segments: Annotated[
        list[PieSegment], Field(min_length=1, max_length=CHART_SERIES_MAX)
    ]


class ChartSeries(_Props):
    name: ChartLabel
    values: list[FiniteNumber]


class SeriesChart(_Props):
    type: Literal["bar", "line", "area"]
    categories: Annotated[
        list[ChartLabel], Field(min_length=1, max_length=CHART_POINTS_MAX)
    ]
    series: Annotated[
        list[ChartSeries], Field(min_length=1, max_length=CHART_SERIES_MAX)
    ]
    xLabel: AxisLabel | None = None
    yLabel: AxisLabel | None = None


class ChartProps(_Props):
    title: Annotated[str, Field(min_length=1, max_length=CHART_TITLE_MAX)]
    chart: Annotated[PieChart | SeriesChart, Field(discriminator="type")]


class DividerProps(_Props):
    pass


class ImageProps(_Props):
    url: HttpsUrl
    alt: Annotated[str, Field(min_length=1, max_length=IMAGE_ALT_MAX)]


class ActionsProps(_Props):
    pass


class ButtonProps(_Props):
    id: Annotated[str, Field(pattern=ACTION_ID_PATTERN)]
    label: Annotated[str, Field(min_length=1, max_length=BUTTON_LABEL_MAX)]
    style: Literal["primary", "danger", "default"] | None = None
    value: Annotated[str, Field(max_length=BUTTON_VALUE_MAX)] | None = None


class LinkButtonProps(_Props):
    label: Annotated[str, Field(min_length=1, max_length=BUTTON_LABEL_MAX)]
    url: HttpsUrl


UIProps = (
    CardProps
    | SectionProps
    | TextProps
    | FieldsProps
    | FieldProps
    | TableProps
    | ChartProps
    | DividerProps
    | ImageProps
    | ActionsProps
    | ButtonProps
    | LinkButtonProps
)

PROPS_MODELS: dict[str, type[UIProps]] = {
    "Card": CardProps,
    "Section": SectionProps,
    "Text": TextProps,
    "Fields": FieldsProps,
    "Field": FieldProps,
    "Table": TableProps,
    "Chart": ChartProps,
    "Divider": DividerProps,
    "Image": ImageProps,
    "Actions": ActionsProps,
    "Button": ButtonProps,
    "LinkButton": LinkButtonProps,
}

# Which components hold children, and which child types each accepts (None:
# any that is not tied to another parent).
_CONTAINERS: dict[str, frozenset[str] | None] = {
    "Card": None,
    "Section": None,
    "Fields": frozenset({"Field"}),
    "Actions": frozenset({"Button", "LinkButton"}),
}
_REQUIRED_PARENT = {"Field": "Fields", "Button": "Actions", "LinkButton": "Actions"}


class UIElement(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: str
    props: UIProps
    children: list[str]


class UISpec(BaseModel):
    model_config = ConfigDict(frozen=True)

    root: str
    elements: dict[str, UIElement]


class UISpecError(ValueError):
    """An invalid spec, one issue per line, each naming where it is."""

    def __init__(self, issues: list[str]) -> None:
        super().__init__("\n".join(issues))
        self.issues = issues


def _loc(loc: tuple[int | str, ...]) -> str:
    out = ""
    for i, part in enumerate(loc):
        if isinstance(part, int):
            out += f"[{part}]"
        elif i > 0 and loc[i - 1] == "chart" and part in _CHART_TYPES:
            continue  # the discriminator's tag, not a path the spec has
        else:
            out += f".{part}"
    return out


def parse_ui_spec(raw: object) -> UISpec:
    """Validate a spec as an agent sent it (or as it crossed the transport).
    Raises UISpecError listing every issue found."""
    if not isinstance(raw, dict):
        raise UISpecError(
            [
                f"spec: expected an object with root and elements, got {type(raw).__name__}"
            ]
        )
    issues: list[str] = [
        f"spec.{name}: unknown field (a spec has only root and elements)"
        for name in sorted(map(str, raw.keys() - {"root", "elements"}))
    ]
    root = raw.get("root")
    if not isinstance(root, str) or not root:
        issues.append("root: expected the key of the root Card element")
        root = None
    elements_raw = raw.get("elements")
    if not isinstance(elements_raw, dict) or not elements_raw:
        issues.append("elements: expected a non-empty object of elements by key")
        raise UISpecError(issues)

    shapes: dict[str, tuple[str, list[str]]] = {}
    elements: dict[str, UIElement] = {}
    for key, el in elements_raw.items():
        where = f"elements.{key}"
        if not isinstance(el, dict):
            issues.append(f"{where}: expected an object with type, props and children")
            continue
        for name in sorted(map(str, el.keys() - {"type", "props", "children"})):
            issues.append(
                f"{where}.{name}: unknown field (not supported in a posted message)"
            )
        kind = el.get("type")
        if not isinstance(kind, str) or kind not in PROPS_MODELS:
            issues.append(
                f"{where}.type: unknown component {kind!r}; expected one of "
                f"{', '.join(PROPS_MODELS)}"
            )
            continue
        model = PROPS_MODELS[kind]
        raw_children = el.get("children", [])
        children = (
            [c for c in raw_children if isinstance(c, str)]
            if isinstance(raw_children, list)
            else None
        )
        if children is None or len(children) != len(raw_children):
            issues.append(f"{where}.children: expected a list of element keys")
            continue
        shapes[key] = (kind, children)
        try:
            props = model.model_validate(el.get("props", {}))
        except ValidationError as error:
            for detail in error.errors():
                issues.append(f"{where}.props{_loc(detail['loc'])}: {detail['msg']}")
            continue
        elements[key] = UIElement(type=kind, props=props, children=children)

    issues += _structure_issues(root, shapes)
    for key, element in elements.items():
        issues += _element_issues(key, element)
    button_ids = [
        e.props.id for e in elements.values() if isinstance(e.props, ButtonProps)
    ]
    dupes = sorted({i for i in button_ids if button_ids.count(i) > 1})
    if dupes:
        issues.append(
            f"spec: Button ids must be unique, repeated {', '.join(map(repr, dupes))}"
        )
    for kind, limit in (("Table", MAX_TABLES), ("Chart", MAX_CHARTS)):
        keys = [k for k, (t, _) in shapes.items() if t == kind]
        if len(keys) > limit:
            issues.append(
                f"spec: at most {limit} {kind} per message, got {len(keys)} "
                f"({', '.join(keys)})"
            )
    if issues:
        raise UISpecError(issues)
    assert root is not None
    spec = UISpec(root=root, elements=elements)
    blocks = estimated_block_count(spec)
    # A card with Buttons gains a block when it is answered.
    limit = MAX_BLOCKS - 1 if card_buttons(spec) else MAX_BLOCKS
    if blocks > limit:
        raise UISpecError(
            [
                f"spec: expands to {blocks} Slack blocks, over the {limit}-block "
                f"limit ({MAX_BLOCKS}, less one kept for the answer when the card "
                "has a Button; a Card title, subtitle and image, and each Text, "
                "Table, Table caption, Chart, Divider, Image and Actions take one "
                f"block; Fields take one per {FIELDS_PER_SECTION} fields)"
            ]
        )
    return spec


def _structure_issues(
    root: str | None, shapes: dict[str, tuple[str, list[str]]]
) -> list[str]:
    issues: list[str] = []
    parent_of: dict[str, str] = {}
    for key, (kind, children) in shapes.items():
        where = f"elements.{key}.children"
        if kind not in _CONTAINERS:
            if children:
                issues.append(f"{where}: a {kind} cannot have children")
            continue
        if not children and kind != "Card":
            issues.append(f"{where}: a {kind} needs at least one child")
        if kind == "Actions" and len(children) > ACTIONS_PER_BLOCK:
            issues.append(
                f"{where}: at most {ACTIONS_PER_BLOCK} buttons in an Actions, "
                f"got {len(children)}"
            )
        accepts = _CONTAINERS[kind]
        for i, child in enumerate(children):
            if child not in shapes:
                issues.append(f"{where}[{i}]: no valid element with key {child!r}")
                continue
            if child in parent_of:
                issues.append(
                    f"{where}[{i}]: {child!r} is already a child of "
                    f"{parent_of[child]!r}; an element has one parent"
                )
                continue
            parent_of[child] = key
            child_kind = shapes[child][0]
            required = _REQUIRED_PARENT.get(child_kind)
            if accepts is not None and child_kind not in accepts:
                issues.append(
                    f"{where}[{i}]: a {kind} holds only "
                    f"{' and '.join(sorted(accepts))} elements, got {child_kind}"
                )
            elif required is not None and required != kind:
                issues.append(
                    f"{where}[{i}]: a {child_kind} must be a child of {required}, "
                    f"not {kind}"
                )

    if root is None:
        return issues
    if root not in shapes:
        issues.append(f"root: no valid element with key {root!r}")
        return issues
    if shapes[root][0] != "Card":
        issues.append(
            f"elements.{root}.type: the root must be a Card, got {shapes[root][0]}"
        )

    reached: set[str] = set()

    def visit(key: str, path: list[str]) -> None:
        reached.add(key)
        if len(path) > MAX_DEPTH:
            issues.append(f"elements.{key}: nested deeper than {MAX_DEPTH} levels")
            # Mark what lies below as reached, without recursing any deeper.
            below = [key]
            while below:
                for child in shapes[below.pop()][1]:
                    if child in shapes and child not in reached:
                        reached.add(child)
                        below.append(child)
            return
        for i, child in enumerate(shapes[key][1]):
            if child in path:
                issues.append(
                    f"elements.{key}.children[{i}]: {child!r} is an ancestor of "
                    f"{key!r}, which makes a cycle"
                )
            elif child in shapes and child not in reached:
                visit(child, [*path, child])

    visit(root, [root])
    for key in shapes:
        if key not in reached:
            issues.append(
                f"elements.{key}: not reachable from root {root!r}; every element "
                "must be a descendant of the root"
            )
    return issues


def _element_issues(key: str, element: UIElement) -> list[str]:
    where = f"elements.{key}.props"
    p = element.props
    issues: list[str] = []
    if isinstance(p, CardProps):
        if not (p.title or p.imageUrl or element.children):
            issues.append(
                f"elements.{key}: a Card needs a title, an imageUrl or at least one child"
            )
        if p.subtitle:
            issues += _over(f"{where}.subtitle", escape_mrkdwn(p.subtitle), TEXT_MAX)
    elif isinstance(p, TextProps):
        issues += _over(
            f"{where}.content",
            styled_mrkdwn(escape_mrkdwn(p.content), p.style),
            TEXT_MAX,
        )
    elif isinstance(p, FieldProps):
        issues += _over(
            f"{where}.label+value",
            field_mrkdwn(escape_mrkdwn(p.label), escape_mrkdwn(p.value)),
            FIELD_TEXT_MAX,
        )
    elif isinstance(p, TableProps):
        if p.caption:
            issues += _over(f"{where}.caption", escape_mrkdwn(p.caption), TEXT_MAX)
        width = len(p.headers)
        for i, row in enumerate(p.rows):
            if len(row) != width:
                issues.append(
                    f"{where}.rows[{i}]: expected {width} cells (headers has "
                    f"{width}), got {len(row)}"
                )
        if p.align is not None and len(p.align) != width:
            issues.append(
                f"{where}.align: expected {width} entries (headers has {width}), "
                f"got {len(p.align)}"
            )
        chars = sum(map(len, p.headers)) + sum(len(c) for row in p.rows for c in row)
        if chars > TABLE_CHARS_MAX:
            issues.append(
                f"{where}: headers and cells have {chars} characters, over "
                f"{TABLE_CHARS_MAX}"
            )
    elif isinstance(p, ChartProps) and isinstance(p.chart, SeriesChart):
        count = len(p.chart.categories)
        for i, series in enumerate(p.chart.series):
            if len(series.values) != count:
                issues.append(
                    f"{where}.chart.series[{i}].values: expected {count} values "
                    f"(categories has {count}), got {len(series.values)}"
                )
        for name, values in (
            ("categories", p.chart.categories),
            ("series", [s.name for s in p.chart.series]),
        ):
            dupes = sorted({v for v in values if values.count(v) > 1})
            if dupes:
                issues.append(
                    f"{where}.chart.{name}: names must be unique, repeated "
                    f"{', '.join(map(repr, dupes))}"
                )
    return issues


def styled_mrkdwn(text: str, style: str | None) -> str:
    """A Text's Slack text, from its content already rendered as mrkdwn."""
    return f"*{text}*" if style == "bold" else text


def field_mrkdwn(label: str, value: str) -> str:
    """A Field's Slack text, from its label and value already rendered as mrkdwn."""
    return f"*{label}*\n{value}"


def over_rendered_limit(where: str, text: str, limit: int) -> str | None:
    """The issue when `text`, as Slack receives it, is over `limit`. Shared by
    the validation (on the escaped text) and the Slack renderer (on what it
    sends), so the two count alike."""
    if len(text) <= limit:
        return None
    return (
        f"{where}: {len(text)} characters as sent to Slack, over {limit} "
        "(& < > are sent as &amp; &lt; &gt;, and bold text and field labels "
        "are wrapped in *)"
    )


def _over(where: str, text: str, limit: int) -> list[str]:
    issue = over_rendered_limit(where, text, limit)
    return [] if issue is None else [issue]


def button_action(button: ButtonProps) -> tuple[str, str]:
    """The action id and value a button is drawn with, by which a press is
    matched back to it. The value is never empty: Slack drops a press that
    carries none."""
    return f"{UI_ACTION_PREFIX}{button.id}", button.value or button.id


def answerer_name(name: str) -> str:
    """Who answered a card, as its settled line names them."""
    if len(name) <= ANSWERER_NAME_MAX:
        return name
    return name[: ANSWERER_NAME_MAX - 1] + "…"


def card_buttons(spec: UISpec) -> list[ButtonProps]:
    """The card's Buttons in the order it draws them, depth first from the root."""

    def walk(key: str) -> list[ButtonProps]:
        element = spec.elements[key]
        own = [element.props] if isinstance(element.props, ButtonProps) else []
        return own + [b for child in element.children for b in walk(child)]

    return walk(spec.root)


def pressed_button(spec: UISpec, action_id: str, value: str) -> ButtonProps | None:
    """The button on the card a press names, by its `button_action` or by its
    position (`UI_POSITION_PREFIX`); None if the card drew no such button."""
    buttons = card_buttons(spec)
    if action_id.startswith(UI_POSITION_PREFIX):
        by_position = {str(i): b for i, b in enumerate(buttons, 1)}
        return by_position.get(action_id.removeprefix(UI_POSITION_PREFIX))
    return next((b for b in buttons if button_action(b) == (action_id, value)), None)


def estimated_block_count(spec: UISpec) -> int:
    """How many Slack blocks the spec draws as: a Card's title (header),
    subtitle (context) and imageUrl (image) one each; Text, Divider, Image,
    Chart and Actions one each; a Table one, plus one for its caption; Fields
    one per FIELDS_PER_SECTION fields; Card and Section add nothing of their
    own beyond their children; Field and buttons are inside their parent's
    block."""

    def count(key: str) -> int:
        element = spec.elements[key]
        p = element.props
        if isinstance(p, CardProps):
            own = sum(x is not None for x in (p.title, p.subtitle, p.imageUrl))
        elif isinstance(p, FieldsProps):
            return math.ceil(len(element.children) / FIELDS_PER_SECTION)
        elif isinstance(p, ActionsProps):
            return math.ceil(len(element.children) / ACTIONS_PER_BLOCK)
        elif isinstance(p, TableProps):
            return 1 + (p.caption is not None)
        elif isinstance(p, TextProps | ChartProps | DividerProps | ImageProps):
            return 1
        else:
            own = 0
        return own + sum(count(child) for child in element.children)

    return count(spec.root)


def _number(value: float) -> str:
    return f"{value:g}"


def trust_text(spec: UISpec) -> str:
    """Every string and number the card can send out, one per line: what
    Switch Trust checks. Read off every prop generically, so a prop added later
    is checked too, button ids included; `to_text` is the readable version."""
    out: list[str] = []

    def add(value: object) -> None:
        if isinstance(value, dict):
            for item in value.values():
                add(item)
        elif isinstance(value, list):
            for item in value:
                add(item)
        elif isinstance(value, str):
            out.append(value)
        elif isinstance(value, int | float) and not isinstance(value, bool):
            out.append(_number(value))

    for element in spec.elements.values():
        add(element.props.model_dump())
    return "\n".join(out)


def to_text(spec: UISpec) -> str:
    """The card as plain markdown text, carrying every string in it."""

    def lines(key: str) -> list[str]:
        element = spec.elements[key]
        p = element.props
        out: list[str] = []
        if isinstance(p, CardProps):
            out += [f"**{p.title}**"] if p.title else []
            out += [p.subtitle] if p.subtitle else []
            out += [f"![]({p.imageUrl})"] if p.imageUrl else []
        elif isinstance(p, TextProps):
            out.append(p.content)
        elif isinstance(p, FieldProps):
            out.append(f"{p.label}: {p.value}")
        elif isinstance(p, TableProps):
            out.append("| " + " | ".join(p.headers) + " |")
            out.append("|" + " --- |" * len(p.headers))
            out += ["| " + " | ".join(row) + " |" for row in p.rows]
            out += [p.caption] if p.caption else []
        elif isinstance(p, ChartProps):
            out.append(f"{p.title} ({p.chart.type} chart)")
            if isinstance(p.chart, PieChart):
                out += [f"- {s.label}: {_number(s.value)}" for s in p.chart.segments]
            else:
                axes = [
                    f"{name}: {label}"
                    for name, label in (("x", p.chart.xLabel), ("y", p.chart.yLabel))
                    if label
                ]
                out += [", ".join(axes)] if axes else []
                categories = p.chart.categories
                out += [
                    f"- {s.name}: "
                    + ", ".join(
                        f"{c} {_number(v)}"
                        for c, v in zip(categories, s.values, strict=True)
                    )
                    for s in p.chart.series
                ]
        elif isinstance(p, DividerProps):
            out.append("---")
        elif isinstance(p, ImageProps):
            out.append(f"![{p.alt}]({p.url})")
        elif isinstance(p, ButtonProps):
            out.append(f"[{p.label}]" + (f" ({p.value})" if p.value else ""))
        elif isinstance(p, LinkButtonProps):
            out.append(f"[{p.label}]({p.url})")
        for child in element.children:
            out += lines(child)
        return out

    return "\n".join(lines(spec.root))
