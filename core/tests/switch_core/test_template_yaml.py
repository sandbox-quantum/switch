"""Reading a template's YAML: anchors, aliases and oversized documents are
refused before anything walks them, and every template that comes with
Switch still reads as it did."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
import yaml

from switch_core.agent_templates import plan_template
from switch_core.template_lint import lint_template
from switch_core.template_v2 import compile_v2, is_v2_text
from switch_core.template_yaml import (
    MAX_TEMPLATE_CHARS,
    MAX_TEMPLATE_NODES,
    TemplateYamlRefused,
    load_template_yaml,
)

_REPO = Path(__file__).resolve().parents[3]
_SHIPPED = sorted(
    [
        *(_REPO / "core" / "switch_core" / "official_templates").rglob("*.yaml"),
        *(_REPO / "examples").rglob("*.yaml"),
        *(_REPO / "switch-expert").glob("*.yaml"),
    ]
)


def alias_bomb(depth: int, width: int) -> str:
    """A room template whose aliases nest `depth` deep, each list naming the
    one before it `width` times: a few hundred bytes that stand for
    `width ** depth` strings."""
    parts = ["a0: &a0 [" + ",".join(["'x'"] * width) + "]"]
    for i in range(1, depth):
        parts.append(f"a{i}: &a{i} [" + ",".join([f"*a{i - 1}"] * width) + "]")
    parts.append(f"bomb: *a{depth - 1}")
    return (
        "room:\n"
        "  name: boom\n"
        "  description: boom\n"
        "  decoy: {" + ", ".join(parts) + "}\n"
    )


def test_every_shipped_template_reads_as_it_did():
    assert len(_SHIPPED) > 30
    for path in _SHIPPED:
        text = path.read_text("utf-8")
        assert load_template_yaml(text) == yaml.safe_load(text), path


def test_an_alias_bomb_is_refused_at_once():
    text = alias_bomb(depth=10, width=6)
    assert len(text) < 500

    started = time.monotonic()
    with pytest.raises(TemplateYamlRefused, match="anchors or aliases"):
        load_template_yaml(text)
    assert time.monotonic() - started < 0.1


def test_a_single_anchor_and_alias_is_refused_with_where_it_is():
    text = "room:\n  name: x\n  description: &d hello\n  topic: *d\n"
    with pytest.raises(TemplateYamlRefused) as raised:
        load_template_yaml(text)
    assert raised.value.problem_mark is not None
    assert raised.value.problem_mark.line == 2
    assert "&d / *d" in str(raised.value)


def test_a_merge_key_is_refused():
    text = "base: &base {name: x}\nroom:\n  <<: *base\n  description: d\n"
    with pytest.raises(TemplateYamlRefused, match="anchors or aliases"):
        load_template_yaml(text)


def test_a_document_longer_than_the_cap_is_refused_before_it_is_read():
    text = "room:\n  name: x\n  description: '" + "y" * MAX_TEMPLATE_CHARS + "'\n"
    with pytest.raises(TemplateYamlRefused, match="characters long"):
        load_template_yaml(text)


def test_a_document_with_too_many_values_is_refused():
    text = "room:\n  name: x\n  tags: [" + ",".join(["1"] * MAX_TEMPLATE_NODES) + "]\n"
    assert len(text) < MAX_TEMPLATE_CHARS
    with pytest.raises(TemplateYamlRefused, match="at most"):
        load_template_yaml(text)


def test_the_refusal_is_a_yaml_error():
    """Callers that report a document that does not parse report this one
    the same way."""
    assert issubclass(TemplateYamlRefused, yaml.YAMLError)


def test_lint_reports_an_alias_at_its_line():
    result = lint_template(alias_bomb(depth=10, width=6))
    assert [f.code for f in result.errors] == ["invalid_yaml"]
    assert "line 4" in result.errors[0].message
    assert "anchors or aliases" in result.errors[0].message


def test_a_version_2_template_with_an_alias_is_refused():
    text = (
        "version: 2\n"
        "resources:\n"
        "  r:\n"
        "    type: room\n"
        "    name: &n boom\n"
        "    description: *n\n"
    )
    assert not is_v2_text(text)
    with pytest.raises(TemplateYamlRefused):
        compile_v2(text, {}, {})


def test_planning_a_run_refuses_an_alias_bomb():
    with pytest.raises(ValueError, match="anchors or aliases"):
        plan_template(
            alias_bomb(depth=10, width=6),
            {},
            {},
            builtins={"$creator": "zoe"},
            machines=None,
            providers=frozenset(),
        )
