"""A rich card's spec: what parses, what an agent is told when it does not,
and the text every string in it is carried by."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from switch_core.ui_spec import (
    BUTTON_VALUE_MAX,
    HEADER_TEXT_MAX,
    MAX_BLOCKS,
    ButtonProps,
    ChartProps,
    SeriesChart,
    TableProps,
    UISpecError,
    estimated_block_count,
    parse_ui_spec,
    to_text,
    trust_text,
)


def _el(type_: str, props: dict[str, Any], *children: str) -> dict[str, Any]:
    return {"type": type_, "props": props, "children": list(children)}


def _full() -> dict[str, Any]:
    return {
        "root": "card",
        "elements": {
            "card": _el(
                "Card",
                {
                    "title": "Weekly deploys",
                    "subtitle": "Oct 27 to Nov 2",
                    "imageUrl": "https://img.example/banner.png",
                },
                "intro",
                "kpis",
                "div",
                "table",
                "group",
                "actions",
            ),
            "intro": _el("Text", {"content": "Deploys are **up 12%**."}),
            "kpis": _el("Fields", {}, "f1", "f2"),
            "f1": _el("Field", {"label": "Deploys", "value": 1284}),
            "f2": _el("Field", {"label": "Failures", "value": "3"}),
            "div": _el("Divider", {}),
            "table": _el(
                "Table",
                {
                    "headers": ["Project", "Deploys"],
                    "rows": [["web", "412"], ["api", 203]],
                    "align": ["left", "right"],
                    "caption": "Top projects",
                },
            ),
            "group": _el("Section", {}, "bars", "pie", "pic"),
            "bars": _el(
                "Chart",
                {
                    "title": "Per day",
                    "chart": {
                        "type": "bar",
                        "categories": ["Mon", "Tue"],
                        "series": [{"name": "Deploys", "values": [180, 210.5]}],
                        "xLabel": "Day",
                        "yLabel": "Count",
                    },
                },
            ),
            "pie": _el(
                "Chart",
                {
                    "title": "Share",
                    "chart": {
                        "type": "pie",
                        "segments": [
                            {"label": "web", "value": 60},
                            {"label": "api", "value": 40},
                        ],
                    },
                },
            ),
            "pic": _el("Image", {"url": "https://img.example/a.png", "alt": "Graph"}),
            "actions": _el("Actions", {}, "approve", "open"),
            "approve": _el(
                "Button",
                {
                    "id": "approve",
                    "label": "Approve",
                    "style": "primary",
                    "value": "rel-42",
                },
            ),
            "open": _el(
                "LinkButton",
                {"label": "Open dashboard", "url": "https://dash.example/x"},
            ),
        },
    }


def _issues(raw: object) -> list[str]:
    with pytest.raises(UISpecError) as caught:
        parse_ui_spec(raw)
    assert str(caught.value) == "\n".join(caught.value.issues)
    return caught.value.issues


def _minimal(*extra: tuple[str, dict[str, Any]], children: list[str]) -> dict[str, Any]:
    return {
        "root": "c",
        "elements": {"c": _el("Card", {"title": "T"}, *children), **dict(extra)},
    }


def test_a_full_spec_parses_with_typed_props() -> None:
    spec = parse_ui_spec(_full())

    table = spec.elements["table"].props
    assert isinstance(table, TableProps)
    assert table.rows == [["web", "412"], ["api", "203"]]
    chart = spec.elements["bars"].props
    assert isinstance(chart, ChartProps) and isinstance(chart.chart, SeriesChart)
    assert chart.chart.xLabel == "Day"
    button = spec.elements["approve"].props
    assert isinstance(button, ButtonProps) and button.id == "approve"
    assert spec.elements["card"].children[0] == "intro"


def test_a_dumped_spec_round_trips() -> None:
    spec = parse_ui_spec(_full())

    assert parse_ui_spec(spec.model_dump(mode="json", exclude_none=True)) == spec


def test_text_carries_every_string() -> None:
    text = to_text(parse_ui_spec(_full()))

    for expected in [
        "Weekly deploys",
        "Oct 27 to Nov 2",
        "https://img.example/banner.png",
        "Deploys are **up 12%**.",
        "Deploys: 1284",
        "Failures: 3",
        "| Project | Deploys |",
        "| api | 203 |",
        "Top projects",
        "Per day",
        "x: Day, y: Count",
        "Deploys: Mon 180, Tue 210.5",
        "Share",
        "web: 60",
        "api: 40",
        "![Graph](https://img.example/a.png)",
        "[Approve] (rel-42)",
        "[Open dashboard](https://dash.example/x)",
    ]:
        assert expected in text


def test_block_count() -> None:
    # header + context + image, Text, Fields, Divider, Table + caption, two
    # Charts, Image, Actions.
    assert estimated_block_count(parse_ui_spec(_full())) == 12


def test_missing_root_and_missing_child() -> None:
    raw = _minimal(children=["ghost"])
    raw["root"] = "nope"

    assert _issues(raw) == [
        "elements.c.children[0]: no valid element with key 'ghost'",
        "root: no valid element with key 'nope'",
    ]


def test_root_must_be_a_card() -> None:
    raw = {"root": "t", "elements": {"t": _el("Text", {"content": "x"})}}

    assert _issues(raw) == ["elements.t.type: the root must be a Card, got Text"]


def test_cycle() -> None:
    raw = _minimal(
        ("a", _el("Section", {}, "b")),
        ("b", _el("Section", {}, "a")),
        children=["a"],
    )

    issues = _issues(raw)
    assert (
        "elements.b.children[0]: 'a' is already a child of 'c'; an element has one parent"
        in issues
    )


def test_cycle_through_root() -> None:
    raw = _minimal(("a", _el("Section", {}, "c")), children=["a"])

    assert _issues(raw) == [
        "elements.a.children[0]: 'c' is an ancestor of 'a', which makes a cycle"
    ]


def test_depth() -> None:
    chain = {f"s{i}": _el("Section", {}, f"s{i + 1}") for i in range(8)}
    chain["s8"] = _el("Text", {"content": "deep"})
    raw = _minimal(*chain.items(), children=["s0"])

    assert _issues(raw) == ["elements.s7: nested deeper than 8 levels"]


def test_unreachable() -> None:
    raw = _minimal(("lost", _el("Text", {"content": "x"})), children=[])

    assert _issues(raw) == [
        "elements.lost: not reachable from root 'c'; every element must be a "
        "descendant of the root"
    ]


def test_bad_type_and_unsupported_fields() -> None:
    raw = _minimal(("x", _el("Carousel", {})), children=["x"])
    raw["state"] = {}
    raw["elements"]["c"]["visible"] = True

    issues = _issues(raw)
    assert issues[0] == "spec.state: unknown field (a spec has only root and elements)"
    assert (
        "elements.c.visible: unknown field (not supported in a posted message)"
        in issues
    )
    assert any(
        i.startswith("elements.x.type: unknown component 'Carousel'") for i in issues
    )


def test_bad_props() -> None:
    raw = _minimal(
        ("t", _el("Text", {"content": "", "style": "loud", "colour": "red"})),
        ("b", _el("Button", {"id": "has space", "label": "Go"})),
        ("a", _el("Actions", {}, "b")),
        children=["t", "a"],
    )

    issues = _issues(raw)
    assert any(
        i.startswith("elements.t.props.content: String should have at least 1")
        for i in issues
    )
    assert any(i.startswith("elements.t.props.style: Input should be") for i in issues)
    assert "elements.t.props.colour: Extra inputs are not permitted" in issues
    assert any(
        i.startswith("elements.b.props.id: String should match pattern") for i in issues
    )


def test_children_rules() -> None:
    raw = _minimal(
        ("t", _el("Text", {"content": "x"}, "f")),
        ("f", _el("Field", {"label": "a", "value": "b"})),
        ("fs", _el("Fields", {}, "t2")),
        ("t2", _el("Text", {"content": "y"})),
        ("empty", _el("Actions", {})),
        children=["t", "fs", "empty"],
    )

    issues = _issues(raw)
    assert "elements.t.children: a Text cannot have children" in issues
    assert (
        "elements.fs.children[0]: a Fields holds only Field elements, got Text"
        in issues
    )
    assert "elements.empty.children: a Actions needs at least one child" in issues


def test_field_outside_fields() -> None:
    raw = _minimal(("f", _el("Field", {"label": "a", "value": "b"})), children=["f"])

    assert _issues(raw) == [
        "elements.c.children[0]: a Field must be a child of Fields, not Card"
    ]


def test_row_column_mismatch() -> None:
    raw = _minimal(
        (
            "t1",
            _el(
                "Table",
                {
                    "headers": ["a", "b", "c"],
                    "rows": [["1", "2", "3"], ["1", "2", "3"], ["1", "2"]],
                    "align": ["left"],
                },
            ),
        ),
        children=["t1"],
    )

    assert _issues(raw) == [
        "elements.t1.props.rows[2]: expected 3 cells (headers has 3), got 2",
        "elements.t1.props.align: expected 3 entries (headers has 3), got 1",
    ]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_chart_values(bad: float) -> None:
    raw = _minimal(
        (
            "ch",
            _el(
                "Chart",
                {
                    "title": "t",
                    "chart": {
                        "type": "line",
                        "categories": ["a", "b"],
                        "series": [{"name": "s", "values": [1, bad]}],
                    },
                },
            ),
        ),
        children=["ch"],
    )

    assert _issues(raw) == [
        "elements.ch.props.chart.series[0].values[1]: Input should be a finite number"
    ]


def test_invalid_chart_series() -> None:
    raw = _minimal(
        (
            "ch",
            _el(
                "Chart",
                {
                    "title": "t",
                    "chart": {
                        "type": "bar",
                        "categories": ["a", "b"],
                        "series": [
                            {"name": "s", "values": [1]},
                            {"name": "s", "values": [1, 2]},
                        ],
                    },
                },
            ),
        ),
        (
            "pie",
            _el(
                "Chart",
                {
                    "title": "p",
                    "chart": {"type": "pie", "segments": [{"label": "x", "value": 0}]},
                },
            ),
        ),
        (
            "kind",
            _el("Chart", {"title": "k", "chart": {"type": "radar"}}),
        ),
        children=["ch", "pie", "kind"],
    )

    issues = _issues(raw)
    assert (
        "elements.ch.props.chart.series[0].values: expected 2 values (categories has 2), got 1"
        in issues
    )
    assert (
        "elements.ch.props.chart.series: names must be unique, repeated 's'" in issues
    )
    assert any(
        i.startswith(
            "elements.pie.props.chart.segments[0].value: Input should be greater than 0"
        )
        for i in issues
    )
    assert any(
        i.startswith("elements.kind.props.chart: Input tag 'radar'") for i in issues
    )


def test_non_https_urls() -> None:
    raw = _minimal(
        ("img", _el("Image", {"url": "http://img.example/a.png", "alt": "a"})),
        ("a", _el("Actions", {}, "l")),
        ("l", _el("LinkButton", {"label": "x", "url": "javascript:alert(1)"})),
        children=["img", "a"],
    )

    assert _issues(raw) == [
        "elements.img.props.url: Value error, must be an https:// URL",
        "elements.l.props.url: Value error, must be an https:// URL",
    ]


def test_too_many_tables_and_charts() -> None:
    table = _el("Table", {"headers": ["a"], "rows": []})
    chart = _el(
        "Chart",
        {
            "title": "p",
            "chart": {"type": "pie", "segments": [{"label": "x", "value": 1}]},
        },
    )
    raw = _minimal(
        ("t1", table),
        ("t2", copy.deepcopy(table)),
        ("c1", chart),
        ("c2", copy.deepcopy(chart)),
        ("c3", copy.deepcopy(chart)),
        children=["t1", "t2", "c1", "c2", "c3"],
    )

    assert _issues(raw) == [
        "spec: at most 1 Table per message, got 2 (t1, t2)",
        "spec: at most 2 Chart per message, got 3 (c1, c2, c3)",
    ]


def test_block_count_over_limit() -> None:
    texts = {f"t{i}": _el("Text", {"content": "x"}) for i in range(MAX_BLOCKS)}
    raw = _minimal(*texts.items(), children=list(texts))

    (issue,) = _issues(raw)
    assert issue.startswith(
        f"spec: expands to {MAX_BLOCKS + 1} Slack blocks, over the 50-block limit"
    )


def test_a_card_with_buttons_keeps_a_block_for_its_answer() -> None:
    texts = {f"t{i}": _el("Text", {"content": "x"}) for i in range(MAX_BLOCKS - 2)}
    links = _el("LinkButton", {"label": "Docs", "url": "https://example.com"})
    go = _el("Button", {"id": "go", "label": "Go"})

    linked = _minimal(
        *texts.items(),
        ("a", _el("Actions", {}, "docs")),
        ("docs", links),
        children=[*texts, "a"],
    )
    pressable = _minimal(
        *texts.items(),
        ("a", _el("Actions", {}, "docs", "go")),
        ("docs", links),
        ("go", go),
        children=[*texts, "a"],
    )

    parse_ui_spec(linked)
    (issue,) = _issues(pressable)
    assert issue.startswith(
        f"spec: expands to {MAX_BLOCKS} Slack blocks, over the 49-block limit"
    )


def test_fields_split_into_sections_of_ten() -> None:
    fields = {f"f{i}": _el("Field", {"label": "a", "value": "b"}) for i in range(11)}
    raw = _minimal(("fs", _el("Fields", {}, *fields)), *fields.items(), children=["fs"])

    assert estimated_block_count(parse_ui_spec(raw)) == 1 + 2


@pytest.mark.parametrize("char", ["é", "🚀", "👍🏽"[0]])
def test_lengths_count_code_points(char: str) -> None:
    at_limit = char * HEADER_TEXT_MAX
    parse_ui_spec({"root": "c", "elements": {"c": _el("Card", {"title": at_limit})}})

    issues = _issues(
        {"root": "c", "elements": {"c": _el("Card", {"title": at_limit + char})}}
    )
    assert issues == [
        "elements.c.props.title: String should have at most 150 characters"
    ]


def test_button_value_cap() -> None:
    def spec(value: str) -> dict[str, Any]:
        return _minimal(
            ("a", _el("Actions", {}, "b")),
            ("b", _el("Button", {"id": "go", "label": "Go", "value": value})),
            children=["a"],
        )

    parse_ui_spec(spec("🚀" * BUTTON_VALUE_MAX))
    assert _issues(spec("🚀" * (BUTTON_VALUE_MAX + 1))) == [
        "elements.b.props.value: String should have at most 1500 characters"
    ]


def test_button_ids_are_unique() -> None:
    assert _issues(
        _minimal(
            ("a", _el("Actions", {}, "b", "d")),
            ("b", _el("Button", {"id": "go", "label": "Go"})),
            ("d", _el("Button", {"id": "go", "label": "Go again"})),
            children=["a"],
        )
    ) == ["spec: Button ids must be unique, repeated 'go'"]


def test_not_an_object() -> None:
    assert _issues(["root"]) == [
        "spec: expected an object with root and elements, got list"
    ]
    assert _issues({"root": 3}) == [
        "root: expected the key of the root Card element",
        "elements: expected a non-empty object of elements by key",
    ]


_AS_SENT = (
    "characters as sent to Slack, over {limit} (& < > are sent as &amp; &lt; "
    "&gt;, and bold text and field labels are wrapped in *)"
)


def _text(**props: Any) -> dict[str, Any]:
    return _minimal(("t", _el("Text", props)), children=["t"])


@pytest.mark.parametrize(
    ("props", "length"),
    [
        ({"content": "x" * 3000, "style": "bold"}, 3002),
        ({"content": "&" * 1000}, 5000),
        ({"content": "<>" * 500, "style": "muted"}, 4000),
    ],
)
def test_text_is_measured_as_sent(props: dict[str, Any], length: int) -> None:
    assert _issues(_text(**props)) == [
        f"elements.t.props.content: {length} " + _AS_SENT.format(limit=3000)
    ]


def test_text_at_the_limit_as_sent_parses() -> None:
    parse_ui_spec(_text(content="x" * 2998, style="bold"))
    parse_ui_spec(_text(content="&" * 600))
    parse_ui_spec(_text(content="x" * 3000, style="muted"))


def test_a_field_is_measured_with_its_label_markup() -> None:
    def spec(label: str, value: str) -> dict[str, Any]:
        return _minimal(
            ("fs", _el("Fields", {}, "f")),
            ("f", _el("Field", {"label": label, "value": value})),
            children=["fs"],
        )

    parse_ui_spec(spec("&", "v" * 1992))
    assert _issues(spec("&", "v" * 1993)) == [
        "elements.f.props.label+value: 2001 " + _AS_SENT.format(limit=2000)
    ]


def test_subtitle_and_caption_are_measured_as_sent() -> None:
    raw = _minimal(
        ("tbl", _el("Table", {"headers": ["h"], "rows": [], "caption": "<" * 751})),
        children=["tbl"],
    )
    raw["elements"]["c"]["props"]["subtitle"] = ">" * 751

    assert _issues(raw) == [
        "elements.c.props.subtitle: 3004 " + _AS_SENT.format(limit=3000),
        "elements.tbl.props.caption: 3004 " + _AS_SENT.format(limit=3000),
    ]


def test_trust_text_carries_every_string_a_card_sends() -> None:
    raw = _full()
    leaves: list[str] = []

    def add(value: object) -> None:
        if isinstance(value, dict):
            for item in value.values():
                add(item)
        elif isinstance(value, list):
            for item in value:
                add(item)
        elif isinstance(value, int | float):
            leaves.append(f"{value:g}")
        else:
            leaves.append(str(value))

    for element in raw["elements"].values():
        add(element["props"])
    assert {"approve", "rel-42", "https://dash.example/x", "Graph"} <= set(leaves)

    assert set(leaves) <= set(trust_text(parse_ui_spec(raw)).split("\n"))
