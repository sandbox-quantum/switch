"""The property catalog's gate (`properties/gate/gate.py`).

The `properties` CI job and `just properties` hold the real catalog to the
real checkers. These tests pin what the gate means, on small catalogs built in
a temporary tree, and that the real catalog passes.
"""

from __future__ import annotations

import importlib.util
import sys
import textwrap
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]

ENTRY = """
  - id: {id}
    title: A title
    statement: A statement.
    kind: safety
    formality: {formality}
    levels: {levels}
    owner: platform
    status: {status}
{extra}"""

CODE_TEST = '@pytest.mark.property("area.thing")\ndef test_x(): ...\n'
MODEL_TAG = "/// @property area.thing\nval Inv = true\n"


@pytest.fixture(scope="module")
def gate() -> Iterator[ModuleType]:
    """properties/gate/gate.py, which is not an installed package."""
    path = REPO_ROOT / "properties" / "gate" / "gate.py"
    spec = importlib.util.spec_from_file_location("properties_gate", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        del sys.modules[spec.name]


def write(root: Path, relative: str, content: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content), encoding="utf-8")


def entry(
    *,
    id: str = "area.thing",
    formality: str = "semi-formal",
    levels: str = "[code]",
    status: str = "proposed",
    extra: str = "",
) -> str:
    return ENTRY.format(
        id=id, formality=formality, levels=levels, status=status, extra=extra
    )


def catalog(root: Path, *entries: str) -> None:
    write(root, "properties/catalog/area.yaml", "properties:" + "".join(entries))


def test_the_real_catalog_and_its_checkers_agree(gate: ModuleType) -> None:
    assert gate.check(REPO_ROOT) == []


def test_a_well_formed_catalog_passes(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry())
    assert gate.check(tmp_path) == []


def test_an_empty_catalog_directory_fails(gate: ModuleType, tmp_path: Path) -> None:
    assert gate.check(tmp_path) == ["properties/catalog has no *.yaml files"]


@pytest.mark.parametrize(
    "bad",
    [
        "Area.thing",
        "thing",
        "area.Thing",
        "area.two words",
        "area.",
        "a.b.c",
        "a.b-c.d",
    ],
)
def test_an_id_that_is_not_area_dot_kebab_name_fails(
    gate: ModuleType, tmp_path: Path, bad: str
) -> None:
    catalog(tmp_path, entry(id=f"'{bad}'"))
    assert any("area.kebab-name" in problem for problem in gate.check(tmp_path))


def test_an_unknown_field_fails(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry(extra="    surprise: true\n"))
    assert any("surprise" in problem for problem in gate.check(tmp_path))


def test_a_duplicate_id_fails(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry(), entry())
    assert "area.thing: listed more than once" in gate.check(tmp_path)


def test_a_gap_needs_a_level_and_a_reason(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry(extra="    gaps:\n      model: not written\n"))
    assert any("not one of its levels" in p for p in gate.check(tmp_path))
    catalog(tmp_path, entry(extra="    gaps:\n      code: ' '\n"))
    assert any("gives no reason" in p for p in gate.check(tmp_path))


def test_a_formal_property_names_its_spec_and_a_model_level(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(formality="formal", levels="[model]"))
    assert any("names its `spec`" in p for p in gate.check(tmp_path))
    catalog(
        tmp_path,
        entry(formality="formal", levels="[code]", extra="    spec: m.qnt::Inv\n"),
    )
    assert any("model level" in p for p in gate.check(tmp_path))
    catalog(tmp_path, entry(extra="    spec: m.qnt::Inv\n"))
    assert any("only a formal property" in p for p in gate.check(tmp_path))


def test_a_tag_for_a_property_not_in_the_catalog_fails(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry())
    write(
        tmp_path, "properties/specs/m.qnt", "/// @property area.other\nval Inv = true\n"
    )
    problems = gate.check(tmp_path)
    assert any("area.other" in p and "not in the catalog" in p for p in problems)


def test_a_tag_at_a_level_the_property_does_not_list_fails(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(levels="[code]"))
    write(tmp_path, "properties/specs/m.qnt", MODEL_TAG)
    assert any("which it does not list" in p for p in gate.check(tmp_path))


def test_every_tag_form_is_found(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry(levels="[model, code, system, ui]"))
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "  /// @property area.thing\nval Inv = true\n",
    )
    write(tmp_path, "core/tests/switch_core/properties/test_x.py", CODE_TEST)
    write(
        tmp_path, "properties/history/h.py", '@checks("area.thing")\ndef check(): ...\n'
    )
    write(
        tmp_path,
        "console/tooling-e2e/src/explore/spec/g.ts",
        "/**\n * @property area.thing\n */\nexport const x = 1;\n",
    )
    tags, problems = gate.find_tags(tmp_path)
    assert problems == []
    assert {tag.level for tag in tags["area.thing"]} == {
        "model",
        "code",
        "system",
        "ui",
    }
    assert gate.check(tmp_path) == []


def test_a_tag_in_a_comment_or_docstring_is_not_a_checker(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(levels="[model, code, ui]"))
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        '''
        # @pytest.mark.property("area.thing")
        def test_x():
            """@pytest.mark.property("area.thing")"""
        ''',
    )
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "/* /// @property area.thing\n*/\nval Inv = true\n",
    )
    write(
        tmp_path,
        "console/tooling-e2e/src/explore/spec/g.ts",
        "// * @property area.thing\nexport const x = 1;\n",
    )
    assert gate.find_tags(tmp_path) == ({}, [])


@pytest.mark.parametrize(
    "mark",
    [
        "pytest.mark.skip",
        "pytest.mark.skip(reason='x')",
        "pytest.mark.xfail",
        "pytest.mark.skipif(True, reason='x')",
    ],
)
def test_a_test_that_does_not_run_is_not_a_checker(
    gate: ModuleType, tmp_path: Path, mark: str
) -> None:
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        f'@{mark}\n@pytest.mark.property("area.thing")\ndef test_x(): ...\n\n'
        f'@{mark}\nclass TestY:\n    @pytest.mark.property("area.thing")\n    def test_y(self): ...\n',
    )
    assert gate.find_tags(tmp_path) == ({}, [])


def test_a_method_of_a_class_is_a_checker(gate: ModuleType, tmp_path: Path) -> None:
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        'class TestX:\n    @pytest.mark.property("area.thing")\n    def test_x(self): ...\n',
    )
    tags, problems = gate.find_tags(tmp_path)
    assert problems == []
    assert [tag.target for tag in tags["area.thing"]] == ["test_x"]


def test_a_tag_that_is_not_a_string_literal_fails(
    gate: ModuleType, tmp_path: Path
) -> None:
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        "@pytest.mark.property(PROPERTY)\ndef test_x(): ...\n",
    )
    _, problems = gate.find_tags(tmp_path)
    assert any("string literal" in p for p in problems)


def test_a_tag_above_nothing_fails(gate: ModuleType, tmp_path: Path) -> None:
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "/// @property area.thing\n\nval Inv = true\n",
    )
    write(
        tmp_path,
        "console/tooling-e2e/src/explore/spec/g.ts",
        "/**\n * @property area.thing\n */\nconst notExported = 1;\n",
    )
    _, problems = gate.find_tags(tmp_path)
    assert len(problems) == 2
    assert all("is not above" in p for p in problems)


def test_a_python_file_that_does_not_parse_fails(
    gate: ModuleType, tmp_path: Path
) -> None:
    write(tmp_path, "properties/history/h.py", "def (:\n")
    _, problems = gate.find_tags(tmp_path)
    assert any("cannot be read for tags" in p for p in problems)


def test_a_checked_property_needs_a_checker_at_every_level(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(levels="[model, code]", status="checked"))
    write(tmp_path, "core/tests/switch_core/properties/test_x.py", CODE_TEST)
    assert gate.check(tmp_path) == [
        "area.thing: checked, but nothing checks it at model"
    ]


def test_a_checked_property_has_no_gaps(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry(status="checked", extra="    gaps:\n      code: later\n"))
    assert any("has no gaps" in p for p in gate.check(tmp_path))


def test_a_gap_at_a_level_with_a_checker_fails(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(extra="    gaps:\n      code: later\n"))
    write(tmp_path, "core/tests/switch_core/properties/test_x.py", CODE_TEST)
    assert gate.check(tmp_path) == [
        "area.thing: lists a gap at code, which has a checker"
    ]


def test_a_retired_property_is_not_checked(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, entry(status="retired"))
    write(tmp_path, "core/tests/switch_core/properties/test_x.py", CODE_TEST)
    assert any("retired" in p for p in gate.check(tmp_path))


def formal(status: str) -> str:
    return entry(
        formality="formal",
        levels="[model]",
        status=status,
        extra="    spec: m.qnt::Inv\n",
    )


def test_a_proposed_spec_may_name_a_model_not_yet_written(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, formal("proposed"))
    assert gate.check(tmp_path) == []


def test_a_spec_must_name_a_definition_once_its_model_exists(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, formal("proposed"))
    write(tmp_path, "properties/specs/m.qnt", "val Other = true\n")
    assert gate.check(tmp_path) == [
        "area.thing: Inv is not defined in properties/specs/m.qnt"
    ]


def test_a_checked_spec_needs_its_model(gate: ModuleType, tmp_path: Path) -> None:
    catalog(tmp_path, formal("checked"))
    assert any("does not exist" in p for p in gate.check(tmp_path))


def test_a_checked_spec_needs_the_tag_on_the_definition_it_names(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, formal("checked"))
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "val Inv = true\n/// @property area.thing\nval Other = true\n",
    )
    assert any("carries no tag" in p for p in gate.check(tmp_path))
    write(
        tmp_path,
        "properties/specs/other.qnt",
        "/// @property area.thing\nval Inv = true\nval Other = true\n",
    )
    assert any("carries no tag" in p for p in gate.check(tmp_path))
    write(
        tmp_path, "properties/specs/m.qnt", "/// @property area.thing\nval Inv = true\n"
    )
    assert gate.check(tmp_path) == []


def test_a_definition_is_found_through_doc_lines_and_modifiers(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, formal("checked"))
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "/// @property area.thing\n/// More about it.\npure val Inv = true\n",
    )
    assert gate.check(tmp_path) == []


def test_the_table_marks_checkers_gaps_and_the_rest(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(
        tmp_path,
        entry(levels="[model, code, system]", extra="    gaps:\n      system: later\n"),
    )
    write(tmp_path, "properties/specs/m.qnt", MODEL_TAG)
    row = gate.table(tmp_path).splitlines()[1].split()
    assert row == ["area.thing", "proposed", "yes", "-", "gap"]


def test_the_table_is_ascii(gate: ModuleType) -> None:
    assert gate.table(REPO_ROOT).isascii()


ASSERTION = """
from antithesis.assertions import always, sometimes as maybe


def store():
    always(True, "area.thing: it holds", {})
    maybe(False, message="area.thing")
    always(True, "not a property: free text", {})
"""


def test_an_assertion_naming_a_property_is_a_system_tag(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(levels="[system]"))
    write(tmp_path, "core/switch_core/x.py", ASSERTION)
    tags, problems = gate.find_tags(tmp_path)
    assert problems == []
    assert [(t.level, t.target) for t in tags["area.thing"]] == [("system", "store")]
    assert list(tags) == ["area.thing"]
    assert gate.check(tmp_path) == []


def test_an_assertion_for_an_unknown_property_fails(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(levels="[system]"))
    write(
        tmp_path,
        "core/switch_core/x.py",
        "from antithesis.assertions import always\n"
        'always(True, "area.typo: it holds", {})\n',
    )
    assert any(
        "area.typo" in p and "not in the catalog" in p for p in gate.check(tmp_path)
    )


def test_a_call_not_from_the_sdk_is_not_an_assertion(
    gate: ModuleType, tmp_path: Path
) -> None:
    catalog(tmp_path, entry(levels="[system]"))
    write(
        tmp_path,
        "core/switch_core/x.py",
        'def always(*args): ...\nalways(True, "area.thing: x")\n',
    )
    tags, _ = gate.find_tags(tmp_path)
    assert "area.thing" not in tags
