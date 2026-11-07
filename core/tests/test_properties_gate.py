"""The property catalog's gate (`properties/gate/gate.py`).

The real catalog is held to the real checkers by `just properties` in CI. These
tests pin what the gate means, on small catalogs built in a temporary tree.
"""

from __future__ import annotations

import importlib.util
import sys
import textwrap
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load_gate() -> ModuleType:
    """Import properties/gate/gate.py, which is not an installed package."""
    path = REPO_ROOT / "properties" / "gate" / "gate.py"
    spec = importlib.util.spec_from_file_location("properties_gate", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gate = _load_gate()

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


def write(root: Path, relative: str, content: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(content))


def catalog(
    root: Path,
    *,
    id: str = "area.thing",
    formality: str = "semi-formal",
    levels: str = "[code]",
    status: str = "proposed",
    extra: str = "",
) -> None:
    entry = ENTRY.format(
        id=id, formality=formality, levels=levels, status=status, extra=extra
    )
    write(root, "properties/catalog/area.yaml", "properties:" + entry)


def test_the_real_catalog_and_its_checkers_agree() -> None:
    assert gate.check(REPO_ROOT) == []


def test_a_well_formed_catalog_passes(tmp_path: Path) -> None:
    catalog(tmp_path)
    assert gate.check(tmp_path) == []


def test_an_empty_catalog_directory_fails(tmp_path: Path) -> None:
    assert gate.check(tmp_path) == ["properties/catalog has no *.yaml files"]


@pytest.mark.parametrize(
    "bad", ["Area.thing", "thing", "area.Thing", "area.two words", "area."]
)
def test_a_malformed_id_fails(tmp_path: Path, bad: str) -> None:
    catalog(tmp_path, id=f"'{bad}'")
    assert any("area.kebab-name" in problem for problem in gate.check(tmp_path))


def test_an_unknown_field_fails(tmp_path: Path) -> None:
    catalog(tmp_path, extra="    surprise: true\n")
    assert any("surprise" in problem for problem in gate.check(tmp_path))


def test_a_duplicate_id_fails(tmp_path: Path) -> None:
    write(
        tmp_path,
        "properties/catalog/area.yaml",
        "properties:"
        + ENTRY.format(
            id="area.thing",
            formality="semi-formal",
            levels="[code]",
            status="proposed",
            extra="",
        )
        + ENTRY.format(
            id="area.thing",
            formality="semi-formal",
            levels="[code]",
            status="proposed",
            extra="",
        ),
    )
    assert "area.thing: listed more than once" in gate.check(tmp_path)


def test_a_gap_needs_a_level_and_a_reason(tmp_path: Path) -> None:
    catalog(tmp_path, extra="    gaps:\n      model: not written\n")
    assert any("not one of its levels" in problem for problem in gate.check(tmp_path))
    catalog(tmp_path, extra="    gaps:\n      code: ' '\n")
    assert any("gives no reason" in problem for problem in gate.check(tmp_path))


def test_a_formal_property_names_its_spec_and_a_model_level(tmp_path: Path) -> None:
    catalog(tmp_path, formality="formal", levels="[model]")
    assert any("names its `spec`" in problem for problem in gate.check(tmp_path))
    catalog(
        tmp_path, formality="formal", levels="[code]", extra="    spec: m.qnt::Inv\n"
    )
    assert any("model level" in problem for problem in gate.check(tmp_path))
    catalog(tmp_path, extra="    spec: m.qnt::Inv\n")
    assert any("only a formal property" in problem for problem in gate.check(tmp_path))


def test_a_tag_for_a_property_not_in_the_catalog_fails(tmp_path: Path) -> None:
    catalog(tmp_path)
    write(
        tmp_path, "properties/specs/m.qnt", "/// @property area.other\nval Inv = true\n"
    )
    problems = gate.check(tmp_path)
    assert any(
        "area.other" in problem and "not in the catalog" in problem
        for problem in problems
    )


def test_a_tag_at_a_level_the_property_does_not_list_fails(tmp_path: Path) -> None:
    catalog(tmp_path, levels="[code]")
    write(
        tmp_path, "properties/specs/m.qnt", "/// @property area.thing\nval Inv = true\n"
    )
    assert any("which it does not list" in problem for problem in gate.check(tmp_path))


def test_every_tag_form_is_found(tmp_path: Path) -> None:
    catalog(tmp_path, levels="[model, code, system, ui]")
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "  /// @property area.thing\nval Inv = true\n",
    )
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        '@pytest.mark.property("area.thing")\ndef test_x(): ...\n',
    )
    write(
        tmp_path, "properties/history/h.py", '@checks("area.thing")\ndef check(): ...\n'
    )
    write(
        tmp_path,
        "console/tooling-e2e/src/explore/spec/g.ts",
        "/**\n * @property area.thing\n */\nexport const x = 1;\n",
    )
    assert set(gate.find_tags(tmp_path)["area.thing"]) == {
        "model",
        "code",
        "system",
        "ui",
    }
    assert gate.check(tmp_path) == []


def test_a_checked_property_needs_a_checker_at_every_level(tmp_path: Path) -> None:
    catalog(tmp_path, levels="[model, code]", status="checked")
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        '@pytest.mark.property("area.thing")\ndef test_x(): ...\n',
    )
    assert gate.check(tmp_path) == [
        "area.thing: checked, but nothing checks it at model"
    ]


def test_a_checked_property_has_no_gaps(tmp_path: Path) -> None:
    catalog(tmp_path, status="checked", extra="    gaps:\n      code: later\n")
    assert any("has no gaps" in problem for problem in gate.check(tmp_path))


def test_a_gap_at_a_level_with_a_checker_fails(tmp_path: Path) -> None:
    catalog(tmp_path, extra="    gaps:\n      code: later\n")
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        '@pytest.mark.property("area.thing")\ndef test_x(): ...\n',
    )
    assert gate.check(tmp_path) == [
        "area.thing: lists a gap at code, which has a checker"
    ]


def test_a_retired_property_is_not_checked(tmp_path: Path) -> None:
    catalog(tmp_path, status="retired")
    write(
        tmp_path,
        "core/tests/switch_core/properties/test_x.py",
        '@pytest.mark.property("area.thing")\ndef test_x(): ...\n',
    )
    assert any("retired" in problem for problem in gate.check(tmp_path))


def test_a_checked_spec_must_define_the_named_invariant(tmp_path: Path) -> None:
    catalog(
        tmp_path,
        formality="formal",
        levels="[model]",
        status="checked",
        extra="    spec: m.qnt::Inv\n",
    )
    assert any("does not exist" in problem for problem in gate.check(tmp_path))
    write(
        tmp_path,
        "properties/specs/m.qnt",
        "/// @property area.thing\nval Other = true\n",
    )
    assert any("Inv is not defined" in problem for problem in gate.check(tmp_path))
    write(
        tmp_path, "properties/specs/m.qnt", "/// @property area.thing\nval Inv = true\n"
    )
    assert gate.check(tmp_path) == []


def test_the_table_marks_checkers_gaps_and_the_rest(tmp_path: Path) -> None:
    catalog(
        tmp_path,
        levels="[model, code, system]",
        extra="    gaps:\n      system: later\n",
    )
    write(
        tmp_path, "properties/specs/m.qnt", "/// @property area.thing\nval Inv = true\n"
    )
    row = gate.table(tmp_path).splitlines()[1].split()
    assert row == ["area.thing", "proposed", "✔", "·", "gap"]
